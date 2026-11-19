import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

import { AssetManager } from './AssetManager';
import { AudioBus, AudioManager, LoopHandle } from './AudioManager';
import { createUrbanEnvironmentMap, updateEnvironmentUniforms } from './EnvironmentFX';
import { InputManager } from './InputManager';
import { VFXManager, ObjectiveMarker } from './VFXManager';
import { CityGenerator, CityWorldData, ExplosiveBarrel, FLOOR_Y, VehicleInstance } from '../world/CityGenerator';
import { PlayerController } from '../entities/PlayerController';
import { ZombieManager } from '../entities/ZombieManager';
import { DogCompanion } from '../entities/DogCompanion';
import { DayNightSystem } from '../systems/DayNightSystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { FortificationSystem } from '../systems/FortificationSystem';
import { StoryDirector } from '../systems/StoryDirector';
import { InventorySystem } from '../systems/InventorySystem';
import { HUD } from '../ui/HUD';
import { DamageIndicator, InteractableObject, SurvivorId, WaypointState, WeaponId } from '../types/game';
import { WEAPONS } from '../data/catalog';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.36 },
    uLowHealth: { value: 0 },
    uDamage: { value: 0 },
    uImpact: { value: 0 },
    uHeal: { value: 0 },
    uGrain: { value: 0.03 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uLowHealth, uDamage, uImpact, uHeal, uGrain;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float dist = length(d);
      // Chromatic aberration on damage, low health, and heavy impacts/explosions
      float ca = uDamage * 0.007 + uImpact * 0.0055 + uLowHealth * 0.002;
      vec4 c = texture2D(tDiffuse, vUv);
      if (ca > 0.0002) {
        c.r = texture2D(tDiffuse, vUv + d * ca * 2.2).r;
        c.b = texture2D(tDiffuse, vUv - d * ca * 2.2).b;
      }
      // Subtle 3-tap radial zoom blur on heavy impacts / explosions
      if (uImpact > 0.02) {
        vec2 stepUv = d * (uImpact * 0.016);
        vec3 rb = (
          texture2D(tDiffuse, vUv - stepUv).rgb +
          texture2D(tDiffuse, vUv - stepUv * 2.0).rgb
        ) * 0.5;
        c.rgb = mix(c.rgb, rb, clamp(uImpact * dist * 1.4, 0.0, 0.48));
      }
      // Filmic S-curve contrast lift + split-tone grading (cool teal shadows, warm amber highlights)
      c.rgb = mix(c.rgb, smoothstep(vec3(0.0), vec3(1.0), c.rgb), 0.14);
      float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb * vec3(0.92, 0.99, 1.07), c.rgb * vec3(1.05, 1.01, 0.94), smoothstep(0.18, 0.82, lum));
      // Desaturate as health drops
      c.rgb = mix(c.rgb, vec3(lum), uLowHealth * 0.65);
      // Vignette (tightens at low health)
      float v = smoothstep(0.96, 0.28, dist * 1.32);
      c.rgb *= mix(1.0, v, clamp(uVignette + uLowHealth * 0.42, 0.0, 1.0));
      // Red pulse on damage / near death
      float pulse = uDamage * 0.52 + uLowHealth * 0.24 * (0.5 + 0.5 * sin(uTime * 5.5));
      c.rgb = mix(c.rgb, c.rgb * vec3(1.38, 0.52, 0.52), pulse * smoothstep(0.14, 0.74, dist * 1.4));
      // Subtle emerald heal shimmer along edges
      if (uHeal > 0.01) {
        c.rgb += vec3(0.08, 0.42, 0.26) * uHeal * smoothstep(0.22, 0.78, dist * 1.45);
      }
      // Film grain
      c.rgb += (rand(vUv * 1000.0 + fract(uTime)) - 0.5) * uGrain;
      gl_FragColor = c;
    }`,
};

const SETTINGS_KEY = 'deadlock-district-settings';
const EXTRACTION_RADIUS = 20;
const SIEGE_SECONDS = 60;

interface DamageEvent {
  from: THREE.Vector3;
  t: number;
}

export class Game {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private gradePass: ShaderPass;
  private fxaaPass: ShaderPass;

  private physicsWorld: CANNON.World;
  private assets: AssetManager;
  private audio: AudioManager;
  private input: InputManager;
  private vfx: VFXManager;
  private hud: HUD;
  private onRestart?: () => void;
  private resizeObserver: ResizeObserver;
  private rafId = 0;
  private disposed = false;
  private uiRoot: HTMLElement;

  private worldData!: CityWorldData;
  private player: PlayerController | null = null;
  private zombieManager: ZombieManager | null = null;
  private dog: DogCompanion | null = null;
  private dayNight: DayNightSystem | null = null;
  private weather = new WeatherSystem();
  private engineLoop: LoopHandle | null = null;
  private alarms: { vehicle: VehicleInstance; loop: LoopHandle; t: number; noiseTimer: number }[] = [];
  private pendingDetonations: { barrel: ExplosiveBarrel; t: number }[] = [];
  private lastImpactSound = 0;
  private inventory: InventorySystem;
  private fort: FortificationSystem | null = null;
  private story: StoryDirector | null = null;
  private hasKeys = false;
  private keysPos: THREE.Vector3 | null = null;
  private siegeDone = false;
  private gateOpen = 0;
  private resting: { lastPhase: string } | null = null;
  private ending: { t: number; truckSpeed: number; boarded: boolean } | null = null;
  private lastPos = new THREE.Vector3();

  private sunLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private fog: THREE.FogExp2;

  private ready = false;
  private running = false;
  private paused = false;
  private gameOver = false;
  private inventoryOpen = false;
  private hitStopTimer = 0;
  private spawnGraceTimer = 4.0;
  private hitMarkerTimer = 0;
  private hitKind: 'hit' | 'head' | 'kill' = 'hit';
  private damageFlashTimer = 0;
  private impactPulse = 0;
  private healFlashTimer = 0;
  private chapterBanner: { chapter: number; title: string; timer: number; dur: number } | null = null;
  private damageEvents: DamageEvent[] = [];
  private toastMessage: string | null = null;
  private toastTimer = 0;
  private campfireCooldown = 0;

  private jerrycansCollected = 0;
  private beaconCollected = false;
  private extractionActive = false;
  private extractionTimer = SIEGE_SECONDS;
  private extractionInRange = true;
  private survivedSeconds = 0;

  private settings = {
    volume: 0.8,
    musicVolume: 0.8,
    sfxVolume: 0.9,
    ambienceVolume: 0.85,
    sensitivity: 1,
    muted: false,
    voiceEnabled: true,
    highQuality: true,
  };

  private lastTime = performance.now();
  private elapsed = 0;
  private titleLook = new THREE.Vector3(0, 2, 0);

  constructor(container: HTMLElement, uiRoot: HTMLElement, assets = new AssetManager(), onRestart?: () => void) {
    this.container = container;
    this.uiRoot = uiRoot;
    this.assets = assets;
    this.onRestart = onRestart;

    this.scene = new THREE.Scene();
    this.fog = new THREE.FogExp2(0x8a99a6, 0.0095);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x0b0e14);

    const { w, h } = this.viewSize();
    this.camera = new THREE.PerspectiveCamera(65, w / h, 0.1, 260);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.container.appendChild(this.renderer.domElement);

    // Procedural urban PMREM IBL reflections (makes wet asphalt, guns, vehicles & metal pop)
    this.scene.environment = createUrbanEnvironmentMap(this.renderer);

    // Post: HalfFloat HDR render target -> selective bloom -> ACES output -> cinematic grade -> FXAA
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.36, 0.55, 0.84);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
    this.fxaaPass = new ShaderPass(FXAAShader);
    const pr = this.renderer.getPixelRatio();
    this.fxaaPass.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
    this.composer.addPass(this.fxaaPass);

    // Lighting — the sun's shadow frustum follows the player for crisp shadows
    this.hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x2a2622, 0.85);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d6, 2.3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 150;
    const d = 40;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.03;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
    // Every body is pinned to the ground each frame, so ground friction only ever acted as a
    // brake (it stalled slow-walking zombies and made the player ~20% slower). Turn it off;
    // walls still block, and bodies now slide along them instead of sticking.
    this.physicsWorld.defaultContactMaterial.friction = 0;

    this.audio = new AudioManager(this.assets);
    this.audio.attachToCamera(this.camera);
    this.input = new InputManager(this.renderer.domElement);
    this.input.setCanLockChecker(() => this.running && !this.inventoryOpen && !this.gameOver && !this.paused);
    this.vfx = new VFXManager(this.scene, this.assets);
    this.inventory = new InventorySystem(this.audio);

    this.loadSettings();

    this.hud = new HUD(uiRoot, {
      onStartGame: (survivor) => this.startGame(survivor),
      onUseItem: (idx) => {
        if (!this.player) return;
        const prevHp = this.player.health;
        const msg = this.inventory.useItem(idx, this.player);
        if (this.player.health > prevHp) {
          this.healFlashTimer = 0.65;
          this.vfx.spawnPickupBurst(this.player.getPosition(), 0x34d399);
        }
        if (msg) this.showToast(msg);
      },
      onCraftMedkit: () => {
        if (!this.player) return;
        const msg = this.inventory.craftMedkit(this.player);
        if (msg.startsWith('Need')) this.audio.playUI('ui_error', 0.5);
        this.showToast(msg);
      },
      onCraftAmmo: (type) => {
        if (!this.player) return;
        const msg = this.inventory.craftAmmo(this.player, type);
        if (msg.startsWith('Need')) this.audio.playUI('ui_error', 0.5);
        this.showToast(msg);
      },
      onToggleMute: () => {
        this.settings.muted = !this.settings.muted;
        this.audio.setMuted(this.settings.muted);
        this.hud.setMuted(this.settings.muted);
        this.saveSettings();
      },
      onToggleVoice: () => {
        this.settings.voiceEnabled = !this.settings.voiceEnabled;
        this.audio.setVoiceEnabled(this.settings.voiceEnabled);
        this.hud.setVoiceEnabled(this.settings.voiceEnabled);
        this.saveSettings();
      },
      onResume: () => this.resume(),
      onRestart: () => {
        if (this.onRestart) this.onRestart();
        else window.location.reload();
      },
      onTouchMove: (x, y) => {
        this.input.touchMoveX = x;
        this.input.touchMoveY = y;
      },
      onTouchFire: (down) => {
        this.input.touchFireHeld = down;
      },
      onTouchAction: (code) => {
        this.input.triggerKeyPress(code);
      },
      onVolumeChange: (v) => {
        this.settings.volume = v;
        this.audio.setMasterVolume(v);
        this.saveSettings();
      },
      onBusVolumeChange: (bus: AudioBus, v: number) => {
        if (bus === 'music') this.settings.musicVolume = v;
        else if (bus === 'sfx') this.settings.sfxVolume = v;
        else this.settings.ambienceVolume = v;
        this.audio.setBusVolume(bus, v);
        this.saveSettings();
      },
      onQualityChange: (high: boolean) => {
        this.settings.highQuality = high;
        this.applyQuality();
        this.saveSettings();
      },
      onSensitivityChange: (v) => {
        this.settings.sensitivity = v;
        this.input.sensitivity = 0.0022 * v;
        this.saveSettings();
      },
    });
    this.hud.setSettings(this.settings);

    // Interface sounds for every button in the HUD (delegated, so new buttons get them too)
    let lastHover = 0;
    this.handleUiMouseOver = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn || btn.contains(e.relatedTarget as Node)) return;
      const now = performance.now();
      if (now - lastHover > 60) {
        lastHover = now;
        this.audio.playUI('ui_hover', 0.25);
      }
    };
    this.handleUiClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) this.audio.playUI('ui_click', 0.35);
    };
    uiRoot.addEventListener('mouseover', this.handleUiMouseOver);
    uiRoot.addEventListener('click', this.handleUiClick);

    window.addEventListener('resize', this.handleResize);
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this.container);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.input.onPointerLockChange((locked) => {
      if (!locked && this.running && !this.inventoryOpen && !this.gameOver && this.input.hasEverLocked) {
        this.setPaused(true);
      }
    });
    this.bindHotkeys();
  }

  private handleUiMouseOver: (e: MouseEvent) => void;
  private handleUiClick: (e: MouseEvent) => void;
  private handleVisibilityChange = (): void => {
    if (document.hidden && this.running && !this.gameOver) this.setPaused(true);
  };

  /** Cleanly tears down all loop timers, audio nodes, listeners and WebGL resources for instant replay. */
  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.uiRoot.removeEventListener('mouseover', this.handleUiMouseOver);
    this.uiRoot.removeEventListener('click', this.handleUiClick);
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.audio.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  private viewSize(): { w: number; h: number } {
    return {
      w: Math.max(1, this.container?.clientWidth || window.innerWidth),
      h: Math.max(1, this.container?.clientHeight || window.innerHeight),
    };
  }

  private loadSettings(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch {
      /* storage unavailable */
    }
    this.audio.setMasterVolume(this.settings.volume);
    this.audio.setBusVolume('music', this.settings.musicVolume);
    this.audio.setBusVolume('sfx', this.settings.sfxVolume);
    this.audio.setBusVolume('ambience', this.settings.ambienceVolume);
    this.audio.setVoiceEnabled(this.settings.voiceEnabled);
    this.audio.setMuted(this.settings.muted);
    this.input.sensitivity = 0.0022 * this.settings.sensitivity;
    this.applyQuality();
  }

  private applyQuality(): void {
    const high = this.settings.highQuality;
    const { w, h } = this.viewSize();
    const pr = Math.min(window.devicePixelRatio, high ? 1.5 : 1.0);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.fxaaPass.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
    this.bloomPass.strength = high ? 0.36 : 0.22;
    this.vfx.setQuality(high);
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable */
    }
  }

  public async init(): Promise<void> {
    await this.assets.preloadAll((loaded, total, label) => {
      this.hud.setLoadProgress(loaded, total, label);
    });

    const cityGen = new CityGenerator(this.scene, this.physicsWorld, this.assets, this.vfx);
    this.worldData = cityGen.generate();

    this.dayNight = new DayNightSystem(
      this.scene,
      this.renderer,
      this.sunLight,
      this.hemiLight,
      this.fog,
      this.worldData.streetLights,
      this.worldData.burningBarrels,
      this.worldData.windowMaterials
    );

    this.weather.collectMaterials(this.scene);
    this.weather.onLightning((distance) => this.audio.playThunder(distance));

    this.dayNight.onNightFall(() => {
      if (!this.running) return;
      this.audio.playSiren();
      if (Math.random() < 0.5) this.weather.forceRain();
      this.story?.notify('nightfall');
      this.showToast('THE BLOOD SIREN WAILS — nightfall. Sprinters & Brutes are hunting.', 5);
    });
    this.dayNight.onDawn(() => {
      if (!this.running) return;
      this.audio.playObjectiveChime();
      this.showToast(`Dawn breaks. You survived night ${this.dayNight!.dayNumber - 1}.`, 4);
      this.story?.notify('dawn');
    });

    // Warm the shader cache so the first frame of gameplay doesn't hitch
    this.precompile();
    this.ready = true;
    this.hud.showReady();
    this.animate();
  }

  private startGame(survivorId: SurvivorId): void {
    this.audio.resume();
    const spawnPos = new THREE.Vector3(-10, 0, 12);
    this.player = new PlayerController(
      survivorId,
      spawnPos,
      this.scene,
      this.physicsWorld,
      this.camera,
      this.assets,
      this.audio,
      this.input,
      this.vfx
    );
    this.player.setYaw(-0.7); // face the central intersection
    this.player.setCameraOccluders(this.worldData.cameraOccluders);
    this.player.setSurfaceResolver(this.worldData.surfaceAt);
    this.player.setOnHeavyShot((strength) => {
      this.impactPulse = Math.max(this.impactPulse, strength);
    });
    this.vfx.setOnCasingLand((pos) => this.audio.playPositional('casing', pos, 0.22, 0.12, 2.5));

    this.zombieManager = new ZombieManager(
      this.scene,
      this.physicsWorld,
      this.assets,
      this.audio,
      this.vfx,
      this.worldData.zombieSpawnPoints,
      this.worldData.sightBlockers,
      spawnPos
    );
    this.fort = new FortificationSystem(
      this.scene,
      this.physicsWorld,
      this.assets,
      this.audio,
      this.worldData.entries,
      this.worldData.buildings,
      this.worldData.interactables,
      this.worldData.raycastTargets,
      this.vfx
    );
    const fort = this.fort;
    this.zombieManager.setRouter(
      (from, to) => fort.route(from, to),
      (b) => {
        const slot = fort.slotForBarricade(b);
        if (!slot) return;
        fort.destroy(slot);
        const inside = this.player && fort.buildingAt(this.player.getPosition())?.id === slot.entry.building;
        this.showToast(inside ? `They broke through the ${slot.entry.kind}!` : `A barricade at the ${slot.entry.building} gave way.`, 3);
      }
    );
    this.zombieManager.setOnBossKilled((pos) => {
      this.spawnKeys(pos);
      this.story?.notify('bossKilled');
      this.showToast('The Butcher is down!', 3);
    });
    this.story = this.createStory();

    this.dog = new DogCompanion(this.worldData.dogSpawnPosition, this.scene, this.assets, this.audio);

    this.audio.onSoundEmitted((origin, radius) => {
      this.zombieManager?.onSoundEmitted(origin, radius);
    });

    this.player.setOnShotHit((point, normal, obj, damage, impulseDir, weapon) => {
      const explosiveId = Game.findTag(obj, 'explosiveId');
      if (explosiveId) {
        const barrel = this.worldData.explosiveBarrels.find((b) => b.id === explosiveId);
        if (barrel) this.detonate(barrel);
        return;
      }
      const res = this.zombieManager?.damageZombieByObject(obj, damage, point, normal, impulseDir);
      if (res) {
        this.registerHit(res.killed ? 'kill' : res.headshot ? 'head' : 'hit');
        if (weapon.id === 'shotgun' || weapon.id === 'sniper' || res.killed) this.hitStopTimer = 0.03;
        return;
      }
      const vehicleId = Game.findTag(obj, 'vehicleId');
      this.vfx.spawnImpactSparks(point, normal, !!vehicleId);
      const now = performance.now();
      if (now - this.lastImpactSound > 50) {
        this.lastImpactSound = now;
        const isBarricade = (this.fort?.slots ?? []).some((sl) => sl.visual && Game.isDescendant(obj, sl.visual));
        this.audio.playPositional(vehicleId ? 'impact_metal' : isBarricade ? 'impact_wood' : 'impact_concrete', point, 0.45, 0.15, 4);
      }
      if (vehicleId) {
        const v = this.worldData.vehicles.find((x) => x.id === vehicleId);
        if (v) this.triggerCarAlarm(v);
      }
    });

    this.player.setOnMelee((origin, forward, weapon) => {
      const results = this.zombieManager?.meleeSweep(origin, forward, weapon.range, weapon.damage) ?? [];
      if (results.length === 0) return false;
      this.audio.playUI('melee_hit', 0.75, 0.95 + Math.random() * 0.1);
      this.registerHit(results.some((r) => r.killed) ? 'kill' : 'hit');
      this.hitStopTimer = 0.045;
      this.player?.addTrauma(0.2);
      return true;
    });

    this.warmUpShaders();
    this.audio.startMusic();
    for (const p of this.worldData.firePositions) this.audio.createLoop('loop_fire', p, 0.55, 2.5);
    this.audio.createJukebox(this.worldData.jukeboxPosition);
    this.input.requestPointerLock();
    this.running = true;
    this.story.begin();
  }

  /**
   * Compile every shader the game will need *now* (behind the deploy click) instead of
   * mid-fight: the player, flashlight, zombies and first muzzle flash / blood / sparks each
   * introduce new programs, which otherwise compile on first use and freeze the game.
   */
  private warmUpShaders(): void {
    const hidden = new THREE.Vector3(0, -50, 0);
    const up = new THREE.Vector3(0, 1, 0);
    this.vfx.spawnMuzzleFlash(hidden, up, true);
    this.vfx.spawnTracer(hidden, hidden.clone().add(up));
    this.vfx.spawnBloodBurst(hidden, up, 2);
    this.vfx.spawnImpactSparks(hidden, up);
    this.vfx.spawnBloodDecal(hidden);
    this.vfx.spawnExplosion(hidden, 0.2);
    // Every zombie rig, including ones not in the starting population (brutes appear later)
    const standIns = ['zombie_basic', 'zombie_arm', 'zombie_ribcage', 'zombie_chubby'].map((k) => {
      const m = this.assets.cloneModel(k);
      m.position.copy(hidden);
      this.scene.add(m);
      return m;
    });
    this.player?.group.updateMatrixWorld(true);
    this.precompile();
    standIns.forEach((m) => this.scene.remove(m));
  }

  /**
   * Compile shaders exactly as the game renders them: into the post-processing chain's linear
   * render target (a different shader variant from direct-to-screen output), then draw one real
   * frame so shadow-depth variants are built too.
   */
  private precompile(): void {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    // Shadow-depth variants are only built for things inside the shadow frustum, which follows
    // the player. Widen it to the whole district for one frame so none compile mid-game.
    const cam = this.sunLight.shadow.camera;
    const saved = [cam.left, cam.right, cam.top, cam.bottom];
    cam.left = cam.bottom = -95;
    cam.right = cam.top = 95;
    cam.updateProjectionMatrix();
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.position.set(40, 70, 30);
    this.sunLight.target.updateMatrixWorld();
    this.composer.render();
    [cam.left, cam.right, cam.top, cam.bottom] = saved;
    cam.updateProjectionMatrix();
    this.composer.render();
  }

  private registerHit(kind: 'hit' | 'head' | 'kill'): void {
    // Kill markers outrank headshots, which outrank plain hits, within one frame
    const rank = { hit: 0, head: 1, kill: 2 };
    if (this.hitMarkerTimer <= 0 || rank[kind] >= rank[this.hitKind]) this.hitKind = kind;
    this.hitMarkerTimer = kind === 'kill' ? 0.3 : 0.16;
    this.audio.playHitFeedback(kind);
  }

  private setPaused(paused: boolean): void {
    if (!this.running || this.gameOver || this.paused === paused) return;
    if (paused && this.inventoryOpen) this.inventoryOpen = false;
    this.paused = paused;
    this.hud.setPaused(paused);
    this.audio.setMuffle(paused ? 0.85 : 0);
    if (paused) {
      this.audio.stopSpeech();
      this.input.exitPointerLock();
    }
  }

  private resume(): void {
    this.audio.resume();
    if (this.inventoryOpen) this.inventoryOpen = false;
    if (this.paused) this.setPaused(false);
    this.input.requestPointerLock();
  }

  private bindHotkeys(): void {
    const active = () => this.running && !this.inventoryOpen && !this.paused && !this.gameOver && !this.resting && !this.ending;
    this.input.onKeyPress('KeyF', () => active() && this.player?.toggleFlashlight());
    this.input.onKeyPress('KeyV', () => active() && this.player?.swapShoulder());
    this.input.onKeyPress('KeyC', () => active() && this.player?.toggleCrouch());
    this.input.onKeyPress('Space', () => active() && this.player?.tryDodge());
    this.input.onKeyPress('KeyR', () => active() && this.player?.startReload());
    this.input.onKeyPress('KeyQ', () => {
      if (!active() || !this.player) return;
      const prevHp = this.player.health;
      const msg = this.inventory.useQuickMedkit(this.player);
      if (this.player.health > prevHp) {
        this.healFlashTimer = 0.65;
        this.vfx.spawnPickupBurst(this.player.getPosition(), 0x34d399);
      }
      this.showToast(msg ?? 'No Medkits or Bandages in pack!');
    });
    this.input.onKeyPress('Tab', () => {
      if (!this.running || this.gameOver || this.paused) return;
      this.inventoryOpen = !this.inventoryOpen;
      this.audio.playUI(this.inventoryOpen ? 'ui_open' : 'ui_close', 0.4);
      if (this.inventoryOpen) this.input.exitPointerLock();
      else this.input.requestPointerLock();
    });
    const togglePause = () => {
      if (!this.running || this.gameOver) return;
      if (this.inventoryOpen) {
        this.resume();
        return;
      }
      if (this.paused) this.resume();
      else this.setPaused(true);
    };
    // Esc only pauses: browsers won't re-grab the mouse from an Esc press, so resume is a click.
    this.input.onKeyPress('Escape', () => {
      if (this.inventoryOpen) this.resume();
      else if (!this.paused) togglePause();
    });
    this.input.onKeyPress('KeyP', togglePause);
    this.input.onKeyPress('KeyE', () => active() && this.handleInteract());
    this.input.onKeyPress('KeyG', () => {
      if (!active() || !this.player || !this.fort) return;
      const item = this.getNearbyInteractable();
      const slot = item && this.fort.slotFor(item);
      if (!slot) return;
      const msg = this.fort.secondary(slot, this.player);
      if (msg.startsWith('Need') || msg.startsWith('Already')) this.audio.playUI('ui_error', 0.5);
      this.showToast(msg);
    });

    const slots: WeaponId[] = ['axe', 'pistol', 'shotgun', 'smg', 'rifle', 'sniper'];
    slots.forEach((id, i) => {
      this.input.onKeyPress(`Digit${i + 1}`, () => {
        if (!active() || !this.player) return;
        if (!this.player.unlockedWeapons.includes(id)) {
          this.showToast(`${id.toUpperCase()} not found yet — scavenge supply crates.`);
          return;
        }
        this.player.equipWeapon(id);
      });
    });
    this.input.onWheel((dir) => active() && this.player?.cycleWeapon(dir));
  }

  private getNearbyInteractable(): InteractableObject | null {
    if (!this.player) return null;
    const pPos = this.player.getPosition();
    let best: InteractableObject | null = null;
    let bestDist = Infinity;
    for (const item of this.worldData.interactables) {
      if (item.consumed) continue;
      const dx = pPos.x - item.position.x;
      const dz = pPos.z - item.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= item.radius && d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    return best;
  }

  private collect(item: InteractableObject): void {
    item.consumed = true;
    if (item.mesh) this.scene.remove(item.mesh);
    (item.data?.marker as ObjectiveMarker | undefined)?.setActive(false);
  }

  private handleInteract(): void {
    if (!this.player) return;
    const item = this.getNearbyInteractable();
    if (!item) return;

    if (item.type === 'loot') {
      this.collect(item);
      this.vfx.spawnPickupBurst(item.position, 0xfbbf24);
      const itemId = (item.data?.itemId as string) || 'canned_food';
      const gotText = this.inventory.pickup(itemId, this.player);
      const scrapGain = 10 + Math.floor(Math.random() * 8);
      this.player.scrap += scrapGain;
      this.audio.playUI('crate_open', 0.6);
      this.audio.playUI('crate_creak', 0.35, 1.2);
      this.audio.playUI(itemId.startsWith('ammo') ? 'ammo_pickup' : 'loot_pickup', 0.6);

      const unlocks: Record<string, [WeaponId, string, 'pistol' | 'shells' | 'rifle', number]> = {
        crate_pharm_2: ['shotgun', 'Pump Shotgun', 'shells', 6],
        crate_park: ['rifle', 'M4 Assault Rifle', 'rifle', 30],
        crate_diner_1: ['smg', 'MP5 SMG', 'pistol', 30],
        crate_ambulance: ['sniper', 'Marksman Rifle', 'rifle', 10],
      };
      const unlock = unlocks[item.id];
      if (unlock) {
        const [wid, wname, ammo, amount] = unlock;
        this.player.unlockWeapon(wid);
        this.player.reserveAmmo[ammo] += amount;
        this.player.equipWeapon(wid);
        this.audio.playUI('ui_powerup', 0.55);
        this.showToast(`Found ${wname} [${WEAPONS[wid].slot}]! ${gotText} • +${scrapGain} Scrap`, 4.5);
      } else {
        this.showToast(`${gotText} • +${scrapGain} Scrap`);
      }
      if (item.id === 'crate_safehouse') this.story?.notify('lootedSafehouse');
    } else if (item.type === 'jerrycan') {
      this.collect(item);
      this.vfx.spawnPickupBurst(item.position, 0xef4444);
      this.jerrycansCollected++;
      this.audio.playUI('loot_pickup', 0.7);
      this.audio.playObjectiveChime();
      this.showToast(`Fuel Jerrycan secured (${this.jerrycansCollected}/3)`);
      this.story?.notify('jerrycan');
    } else if (item.type === 'beacon') {
      this.collect(item);
      this.vfx.spawnPickupBurst(item.position, 0x38bdf8);
      this.beaconCollected = true;
      this.audio.playUI('loot_pickup', 0.7);
      this.audio.playObjectiveChime();
      this.showToast('Shortwave radio — tuned to Evac Command.');
      this.story?.notify('beacon');
    } else if (item.type === 'entry') {
      const slot = this.fort?.slotFor(item);
      if (!slot) return;
      const msg = this.fort!.primary(slot, this.player);
      if (msg.startsWith('Need') || msg.startsWith('Already')) this.audio.playUI('ui_error', 0.5);
      this.showToast(msg);
    } else if (item.type === 'bed') {
      this.startRest();
    } else if (item.type === 'keys') {
      this.collect(item);
      this.hasKeys = true;
      this.keysPos = null;
      this.audio.playUI('objective_pickup', 0.7);
      this.audio.playUI('crate_open', 0.4, 1.4);
      this.showToast('Truck keys recovered.');
      this.story?.notify('keys');
    } else if (item.type === 'campfire') {
      if (this.campfireCooldown > 0) {
        this.showToast(`The fire needs tending — rest again in ${Math.ceil(this.campfireCooldown)}s.`);
        return;
      }
      if (this.player.health >= this.player.maxHealth) {
        this.showToast('You are already fully rested.');
        return;
      }
      this.campfireCooldown = 45;
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 35);
      this.healFlashTimer = 0.75;
      this.vfx.spawnPickupBurst(this.player.getPosition(), 0x34d399);
      this.audio.playUI('heal_sfx', 0.55);
      this.showToast('Rested by the campfire (+35 Health).');
    } else if (item.type === 'dog') {
      item.consumed = true;
      this.dog?.recruit();
      this.showToast('Survivor dog recruited! It barks at threats and pins zombies.');
    } else if (item.type === 'extraction_truck') {
      if (this.story?.stage === 'board') {
        this.startEnding();
        return;
      }
      if (this.extractionActive) return;
      if (this.jerrycansCollected < 3 || !this.hasKeys) {
        this.audio.playUI('ui_error', 0.5);
        this.showToast(`The truck needs fuel (${this.jerrycansCollected}/3) and its keys (${this.hasKeys ? '✓' : '✗'}).`);
        return;
      }
      this.extractionActive = true;
      this.extractionTimer = SIEGE_SECONDS;
      this.audio.playUI('ui_alert', 0.9);
      this.audio.playSiren();
      this.engineLoop = this.audio.createLoop('loop_engine', this.worldData.extractionPosition.clone().setY(1), 0.7, 6);
      this.engineLoop.setRate(0.7);
      this.worldData.extractionBeaconLight.color.setHex(0xef4444);
      item.label = 'Armored Extraction Truck';
      item.subLabel = 'Engine warming up — defend it!';
      this.story?.notify('truckStarted');
    }
  }

  private static findTag(obj: THREE.Object3D, key: string): string | undefined {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o.userData[key]) return o.userData[key] as string;
      o = o.parent;
    }
    return undefined;
  }

  private static isDescendant(obj: THREE.Object3D, root: THREE.Object3D): boolean {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o === root) return true;
      o = o.parent;
    }
    return false;
  }

  /** Fuel drum explosion: area damage, knockback, chain reactions, car alarms, a lot of noise. */
  private detonate(barrel: ExplosiveBarrel): void {
    if (barrel.exploded) return;
    barrel.exploded = true;
    const pos = barrel.position.clone().setY(0.1);
    this.scene.remove(barrel.mesh);
    this.physicsWorld.removeBody(barrel.body);
    const idx = this.worldData.raycastTargets.indexOf(barrel.mesh);
    if (idx >= 0) this.worldData.raycastTargets.splice(idx, 1);

    this.vfx.spawnExplosion(pos);
    this.audio.duck(0.6, 1.5);
    this.audio.playPositional('explosion', pos, 1.0, 0.08, 14, 1.0);
    this.audio.playPositional('explosion_low', pos, 0.9, 0.08, 18, 0.6);
    setTimeout(() => this.audio.playPositional('debris_fall', pos, 0.6, 0.15, 6), 350);
    this.audio.emitNoise(pos, 70);

    const kills = this.zombieManager?.explosionAt(pos, 7, 230) ?? 0;
    if (kills > 0) {
      this.registerHit('kill');
      if (kills >= 3) this.showToast(`Fuel drum took out ${kills} infected!`, 2.5);
    }

    if (this.player) {
      const d = this.player.getPosition().distanceTo(pos);
      this.player.addTrauma(THREE.MathUtils.clamp(1.1 - d / 25, 0, 1));
      this.impactPulse = Math.max(this.impactPulse, THREE.MathUtils.clamp(1.0 - d / 28, 0, 1));
      if (d < 6.5 && !this.gameOver) {
        this.player.takeDamage(Math.round(60 * (1 - d / 6.5)));
        this.damageFlashTimer = 0.35;
        this.damageEvents.push({ from: pos.clone(), t: 1.2 });
      }
      if (d < 12) this.hitStopTimer = 0.05;
    }
    for (const slot of this.fort?.slots ?? []) {
      if (slot.barricade && slot.entry.position.distanceTo(pos) < 5) this.fort!.destroy(slot);
    }
    for (const v of this.worldData.vehicles) {
      if (v.position.distanceTo(pos) < 9) this.triggerCarAlarm(v);
    }
    for (const other of this.worldData.explosiveBarrels) {
      if (!other.exploded && other.position.distanceTo(pos) < 5 && !this.pendingDetonations.some((p) => p.barrel === other)) {
        this.pendingDetonations.push({ barrel: other, t: 0.18 + Math.random() * 0.15 });
      }
    }
  }

  /** Shooting a car sets off its alarm: flashing lights and a siren that pulls the horde in. */
  private triggerCarAlarm(v: VehicleInstance): void {
    if (v.alarmCooldown > 0 || this.alarms.some((a) => a.vehicle === v)) return;
    const loop = this.audio.createLoop('loop_car_alarm', v.position.clone().setY(1), 0.65, 6);
    this.alarms.push({ vehicle: v, loop, t: 9, noiseTimer: 0 });
    if (this.alarms.length === 1) this.showToast('Car alarm! Every zombie nearby heard that.', 2.5);
  }

  private updateWorldEvents(dt: number): void {
    for (const v of this.worldData.vehicles) v.alarmCooldown = Math.max(0, v.alarmCooldown - dt);
    for (let i = this.alarms.length - 1; i >= 0; i--) {
      const a = this.alarms[i];
      a.t -= dt;
      a.noiseTimer -= dt;
      if (a.noiseTimer <= 0) {
        a.noiseTimer = 1;
        this.audio.emitNoise(a.vehicle.position, 45);
      }
      const on = Math.floor(a.t * 3) % 2 === 0;
      for (const m of a.vehicle.lightMats) m.emissiveIntensity = on ? 3 : 0.15;
      if (a.t <= 0) {
        a.loop.stop(0.3);
        for (const m of a.vehicle.lightMats) m.emissiveIntensity = 0.15;
        a.vehicle.alarmCooldown = 20;
        this.alarms.splice(i, 1);
      }
    }
    for (let i = this.pendingDetonations.length - 1; i >= 0; i--) {
      const p = this.pendingDetonations[i];
      p.t -= dt;
      if (p.t <= 0) {
        this.pendingDetonations.splice(i, 1);
        this.detonate(p.barrel);
      }
    }
  }

  private createStory(): StoryDirector {
    const world = this.worldData;
    const story = new StoryDirector({
      jerrycans: () => this.jerrycansCollected,
      safehouseSeal: () => this.fort?.sealedCount('Safehouse') ?? [0, 3],
      isNight: () => this.dayNight?.isNight() ?? false,
      skipToDusk: () => {
        // Dusk starts at 0.56 — land just inside it so the bed is usable straight away
        if (!this.dayNight || this.dayNight.timeOfDay >= 0.575) return;
        this.dayNight.timeOfDay = 0.575;
        this.showToast('Hours pass while you siphon the fuel... the sun is going down.', 4.5);
      },
      spawnBoss: () => {
        if (!this.zombieManager) return;
        const boss = this.zombieManager.spawnZombie(world.bossSpawn, 'brute', {
          scale: 1.9,
          hp: 1000,
          damage: 32,
          speed: 2.5,
          tint: 0xffa090,
          boss: true,
        });
        boss.state = 'patrol';
        this.audio.playPositional('brute_roar', world.bossSpawn, 1, 0.05, 25, 0.8, 0.7);
      },
      bossPosition: () => this.zombieManager?.getBoss()?.group.position.clone().setY(2.5) ?? null,
      keysPosition: () => this.keysPos?.clone().setY(1) ?? null,
      interactablePosition: (id) => {
        const it = world.interactables.find((i) => i.id === id && !i.consumed);
        return it ? it.position.clone().setY(1.2) : null;
      },
      nearestJerrycan: () => {
        if (!this.player) return null;
        const p = this.player.getPosition();
        let best: THREE.Vector3 | null = null;
        let bd = Infinity;
        for (const it of world.interactables) {
          if (it.type !== 'jerrycan' || it.consumed) continue;
          const d = it.position.distanceTo(p);
          if (d < bd) {
            bd = d;
            best = it.position.clone().setY(1.2);
          }
        }
        return best;
      },
      safehouseDoor: () => {
        const door = world.entries.find((e) => e.building === 'Safehouse' && e.kind === 'door')!;
        return door.position.clone().setY(2);
      },
      truckPosition: () => world.extractionPosition.clone().setY(3),
      siegeSecondsLeft: () => this.extractionTimer,
      onStageChanged: (stage, chapter, title) => {
        if (stage !== 'arrive') this.audio.playUI('ui_confirm', 0.5);
        if (stage === 'board') this.audio.playUI('ui_powerup', 0.7);
        this.chapterBanner = { chapter, title, timer: 0, dur: 3.4 };
        const truck = world.interactables.find((i) => i.type === 'extraction_truck');
        if (truck && (stage === 'truck' || stage === 'board')) {
          world.extractionMarker.setActive(true);
          world.extractionBeaconLight.color.setHex(0x22c55e);
          truck.label = stage === 'board' ? 'BOARD THE TRUCK' : 'Start the armored truck';
          truck.subLabel = stage === 'board' ? 'Get in and get out!' : 'Fuel 3/3 · Keys ✓';
        }
      },
    });
    story.setOnRadioLine((line) => {
      this.audio.playRadioStatic();
      this.audio.speakRadio(line.text);
    });
    return story;
  }

  private spawnKeys(pos: THREE.Vector3): void {
    const keys = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: 0xd4a72c, metalness: 0.9, roughness: 0.3, emissive: 0x3a2a00, emissiveIntensity: 0.6 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.015, 8, 16), gold);
    ring.rotation.x = Math.PI / 2;
    keys.add(ring);
    for (let i = 0; i < 2; i++) {
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, 0.16), gold);
      k.position.set(0.05 - i * 0.1, 0, 0.13);
      k.rotation.y = 0.3 - i * 0.6;
      keys.add(k);
    }
    const spot = pos.clone().setY(FLOOR_Y + 0.02);
    keys.position.copy(spot);
    this.scene.add(keys);
    const marker = this.vfx.createObjectiveMarker(spot, 0xfacc15);
    this.keysPos = spot.clone();
    this.worldData.interactables.push({
      id: 'truck_keys',
      type: 'keys',
      label: 'Truck Keys',
      subLabel: 'Take them',
      position: spot.clone().setY(0.6),
      radius: 2.4,
      mesh: keys,
      data: { marker },
    });
  }

  private static clockText(timeOfDay: number): string {
    const minutes = Math.floor(((6 + timeOfDay * 24) % 24) * 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  /** Bed in the sealed safehouse: time-lapse to dawn while the horde tests your barricades. */
  private startRest(): void {
    if (!this.player || !this.fort || !this.dayNight || !this.zombieManager) return;
    const phase = this.dayNight.phase;
    if (phase === 'day') {
      this.showToast("It's still light out. Rest once the sun goes down.");
      return;
    }
    if (this.fort.buildingAt(this.player.getPosition())?.id !== 'Safehouse') return;
    if (!this.fort.isSealed('Safehouse')) {
      const [n, m] = this.fort.sealedCount('Safehouse');
      this.audio.playUI('ui_error', 0.5);
      this.showToast(`Seal every door and window first (${n}/${m}).`);
      return;
    }
    const intruder = this.zombieManager.zombies.some((z) => z.state !== 'dead' && this.fort!.buildingAt(z.group.position)?.id === 'Safehouse');
    if (intruder) {
      this.showToast("You can't rest with one of them in here!");
      return;
    }
    this.resting = { lastPhase: phase };
    this.audio.playUI('gear_rustle', 0.5, 0.8);
    this.input.exitPointerLock();
  }

  private updateRest(dt: number): void {
    if (!this.resting || !this.dayNight || !this.fort || !this.player || !this.zombieManager) return;
    const sim = dt * 26; // a night passes in a few seconds
    this.dayNight.update(sim, this.elapsed, this.player.getPosition(), this.camera.position);
    const alive = this.zombieManager.aliveCount();
    const intensity = this.dayNight.nightFactor() * (0.6 + alive / 30);
    const breached = this.fort.siegeTick('Safehouse', intensity, sim);
    this.fort.update();
    this.audio.setMuffle(0.55);

    if (breached) {
      // Woken by something coming through
      this.resting = null;
      this.fort.destroy(breached);
      for (let i = 0; i < 2; i++) {
        const z = this.zombieManager.spawnZombie(breached.outside, i ? 'shambler' : 'sprinter');
        z.state = 'chase';
        z.lastKnownPlayer = this.player.getPosition();
      }
      this.audio.playUI('zombie_roar', 0.9);
      this.player.addTrauma(0.6);
      this.showToast(`You jolt awake — something broke through the ${breached.entry.kind}!`, 4);
      return;
    }

    const phase = this.dayNight.phase;
    if (this.resting.lastPhase === 'dawn' && phase === 'day') {
      this.resting = null;
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 50);
      this.player.stamina = this.player.maxStamina;
      this.player.hunger = Math.max(0, this.player.hunger - 20);
      this.player.thirst = Math.max(0, this.player.thirst - 25);
      // The horde drifts off with the daylight
      for (const z of this.zombieManager.zombies) {
        if (z.state === 'dead' || z.group.position.distanceTo(this.player.getPosition()) > 22) continue;
        const sp = this.worldData.zombieSpawnPoints[Math.floor(Math.random() * this.worldData.zombieSpawnPoints.length)];
        z.body.position.set(sp.x, z.radius, sp.z);
        z.body.previousPosition.copy(z.body.position);
        z.body.interpolatedPosition.copy(z.body.position);
        z.state = 'patrol';
      }
      this.audio.playUI('raven', 0.5);
      this.showToast('You wake at dawn. The barricades held. (+50 Health)', 4.5);
      return;
    }
    this.resting.lastPhase = phase;
  }

  private restOverlay(): { clock: string; status: string } | null {
    if (!this.resting || !this.fort || !this.dayNight) return null;
    const lines = this.fort.slots
      .filter((s) => s.entry.building === 'Safehouse')
      .map((s) => {
        const pct = s.barricade ? Math.max(0, s.barricade.hp / s.barricade.maxHp) : 0;
        const bar = '█'.repeat(Math.round(pct * 10)).padEnd(10, '░');
        const name = s.entry.kind === 'door' ? 'Front door ' : `Window (${s.entry.id.split('_').pop()})`;
        return `${name.padEnd(16)} ${bar} ${Math.round(pct * 100)}%`;
      });
    return { clock: Game.clockText(this.dayNight.timeOfDay), status: lines.join('\n') };
  }

  /** Board the truck and smash out through the North Gate. */
  private startEnding(): void {
    if (this.ending || !this.player) return;
    this.ending = { t: 0, truckSpeed: 0, boarded: false };
    this.story?.notify('boarded');
    this.input.exitPointerLock();
    const truck = this.worldData.truck.root;
    // Walk-up spot: driver's side of the cab
    const door = truck.position.clone().add(new THREE.Vector3(-2.1, 0, -0.5));
    this.player.teleport(door);
    this.player.setYaw(Math.PI / 2);
    this.audio.playUI('door_open', 0.7);
    // The truck no longer blocks anything — it's leaving
    const truckIt = this.worldData.interactables.find((i) => i.type === 'extraction_truck');
    if (truckIt) truckIt.consumed = true;
    this.worldData.extractionMarker.setActive(false);
  }

  private updateEnding(dt: number): void {
    if (!this.ending || !this.player || !this.zombieManager) return;
    const e = this.ending;
    e.t += dt;
    const truck = this.worldData.truck.root;

    if (!e.boarded && e.t > 0.15) this.player.playJump();
    if (!e.boarded && e.t > 0.7) {
      e.boarded = true;
      this.player.hideBody();
      this.audio.playUI('door_open', 0.6, 0.8);
      this.audio.playUI('crate_creak', 0.4, 0.6);
    }
    if (e.t > 1.1) {
      e.truckSpeed = Math.min(16, e.truckSpeed + dt * 7);
      truck.position.z -= e.truckSpeed * dt;
      for (const w of this.worldData.truck.wheels) w.rotation.x -= (e.truckSpeed * dt) / 0.45;
      this.engineLoop?.setRate(0.9 + e.truckSpeed / 14);
      // Anything in the way gets ploughed aside
      const front = truck.position.clone().add(new THREE.Vector3(0, 0, -3));
      this.zombieManager.explosionAt(front, 2.6, 600);
    }

    // Cinematic cameras
    const tp = truck.position;
    if (e.t < 1.1) {
      this.camera.position.set(tp.x - 6, 2.2, tp.z + 4.5);
      this.camera.lookAt(tp.x - 1.5, 1.4, tp.z - 0.5);
    } else if (e.t < 3.6) {
      this.camera.position.lerp(new THREE.Vector3(tp.x + 2.5, 3.2, tp.z + 9), Math.min(1, dt * 4));
      this.camera.lookAt(tp.x, 1.6, tp.z - 6);
    } else {
      // Hold on the gate while the truck tears off into the dark
      this.camera.position.lerp(new THREE.Vector3(7, 4, -60), Math.min(1, dt * 2));
      this.camera.lookAt(tp.x, 1.5, tp.z);
    }
    if (e.t > 3.0) this.audio.setMuffle(Math.min(0.8, (e.t - 3) * 0.25));
    if (e.t > 6.2) {
      this.ending = null;
      this.endGame(true);
    }
  }

  private updateGate(dt: number): void {
    if (!this.siegeDone || this.gateOpen >= 1) return;
    if (this.gateOpen === 0) {
      this.physicsWorld.removeBody(this.worldData.gate.body);
      this.audio.playPositional('debris_fall', this.worldData.gate.mesh.position, 0.8, 0.05, 12);
      this.audio.playPositional('impact_metal', this.worldData.gate.mesh.position, 0.9, 0.05, 12, 0.6);
    }
    this.gateOpen = Math.min(1, this.gateOpen + dt / 3.5);
    const eased = 1 - Math.pow(1 - this.gateOpen, 2);
    this.worldData.gate.mesh.position.x = eased * 9.5;
  }

  private showToast(msg: string, seconds = 3.6): void {
    this.toastMessage = msg;
    this.toastTimer = seconds;
  }

  private handleResize = (): void => {
    const { w, h } = this.viewSize();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaaPass.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
  };

  /** Rain dims the sun and thickens the fog; lightning briefly floods the scene with light. */
  private applyWeatherLighting(): void {
    const r = this.weather.rain;
    const f = this.weather.flash;
    this.sunLight.intensity *= 1 - 0.55 * r;
    this.hemiLight.intensity = this.hemiLight.intensity * (1 - 0.3 * r) + f * 2.4;
    this.fog.density += r * 0.011;
    this.fog.color.lerp(new THREE.Color(0x6b7380), r * 0.35);
    if (f > 0) this.fog.color.lerp(new THREE.Color(0xc8d4ff), f * 0.5);
  }

  private computeWaypoint(): WaypointState | null {
    if (!this.player) return null;
    let target: THREE.Vector3 | null = null;
    let label = '';
    let color = '#f59e0b';
    const pPos = this.player.getPosition();

    const goal = this.story?.target();
    if (goal) {
      target = goal.pos;
      label = goal.label;
      color = goal.color;
    }
    if (!target) return null;

    const distance = target.clone().setY(0).distanceTo(pPos);
    if (distance < 3.5) return null;
    const { w, h } = this.viewSize();
    const ndc = target.clone().project(this.camera);
    const behind = ndc.z > 1;
    let x = ((ndc.x + 1) / 2) * w;
    let y = ((1 - ndc.y) / 2) * h;
    const margin = 48;
    const onScreen = !behind && x > margin && x < w - margin && y > margin + 60 && y < h - margin;
    let angle = 0;
    if (!onScreen) {
      let dx = x - w / 2;
      let dy = y - h / 2;
      if (behind) {
        dx = -dx;
        dy = -dy;
      }
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) dy = 1;
      const s = Math.min((w / 2 - margin) / Math.abs(dx || 1), (h / 2 - margin - 40) / Math.abs(dy || 1));
      x = w / 2 + dx * s;
      y = h / 2 + dy * s;
      angle = Math.atan2(dy, dx) + Math.PI / 2;
    }
    return { label, distance, x, y, onScreen, angle, color };
  }

  private computeDamageIndicators(): DamageIndicator[] {
    if (!this.player) return [];
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const camYaw = Math.atan2(camDir.x, camDir.z);
    const p = this.player.getPosition();
    return this.damageEvents.slice(-4).map((ev) => {
      const to = ev.from.clone().sub(p);
      const a = Math.atan2(to.x, to.z) - camYaw;
      return { angle: -a, alpha: Math.min(1, ev.t / 0.6) };
    });
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);

    const now = performance.now();
    const rawDt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.gradePass.uniforms.uTime.value = now / 1000;
    if (!this.ready) return;

    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= rawDt;
      this.composer.render();
      return;
    }

    const dt = rawDt;
    this.elapsed += dt;

    if (!this.running) {
      // Slow cinematic orbit over the district on the title screen
      const a = this.elapsed * 0.06 + 0.6;
      this.camera.position.set(Math.sin(a) * 38, 13 + Math.sin(this.elapsed * 0.2) * 2, Math.cos(a) * 38);
      this.camera.lookAt(this.titleLook);
      this.dayNight?.update(0, this.elapsed, this.titleLook, this.camera.position);
      updateEnvironmentUniforms(this.elapsed, 0.15, this.dayNight?.nightFactor() ?? 0);
      this.vfx.setAtmosphere(this.dayNight?.nightFactor() ?? 0, 0);
      this.vfx.update(dt, this.elapsed, this.camera.position);
      this.audio.update(dt, false);
      this.composer.render();
      return;
    }

    if (this.paused || this.gameOver || !this.player || !this.zombieManager || !this.dayNight) {
      this.audio.update(dt, this.dayNight?.isNight() ?? false);
      this.composer.render();
      return;
    }

    if (this.resting) {
      this.updateRest(dt);
      this.vfx.update(dt, this.elapsed, this.player.getPosition());
      this.audio.update(dt, true, this.player.getPosition());
      this.story?.update(dt);
      this.pushHud(dt);
      this.composer.render();
      return;
    }

    // Timers
    this.survivedSeconds += dt;
    this.spawnGraceTimer = Math.max(0, this.spawnGraceTimer - dt);
    this.hitMarkerTimer = Math.max(0, this.hitMarkerTimer - dt);
    this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    this.impactPulse = Math.max(0, this.impactPulse - dt * 3.4);
    this.healFlashTimer = Math.max(0, this.healFlashTimer - dt);
    this.campfireCooldown = Math.max(0, this.campfireCooldown - dt);
    if (this.chapterBanner) {
      this.chapterBanner.timer += dt;
      if (this.chapterBanner.timer >= this.chapterBanner.dur) this.chapterBanner = null;
    }
    for (const ev of this.damageEvents) ev.t -= dt;
    this.damageEvents = this.damageEvents.filter((ev) => ev.t > 0);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastMessage = null;
    }

    this.physicsWorld.step(1 / 60, dt, 3);

    const raycastTargets = [...this.worldData.raycastTargets, ...this.zombieManager.getRaycastMeshes()];
    if (this.ending) {
      this.player.updateAnimationOnly(dt);
      this.updateEnding(dt);
    } else {
      this.player.update(dt, raycastTargets, this.inventoryOpen);
    }

    // During the ending the horde chases the truck instead of the (boarded) player
    const pPos = this.ending ? this.worldData.truck.root.position.clone().setY(0) : this.player.getPosition();
    this.zombieManager.update(
      dt,
      pPos,
      this.player.isCrouching,
      this.dayNight.isNight(),
      this.extractionActive,
      (dmg, from) => {
        if (!this.player || this.gameOver || this.spawnGraceTimer > 0 || this.ending || this.player.isDodging()) return;
        this.player.takeDamage(dmg);
        this.damageFlashTimer = 0.25;
        this.impactPulse = Math.max(this.impactPulse, 0.45);
        this.damageEvents.push({ from: from.clone(), t: 1.2 });
      }
    );

    if (this.player.health <= 0) {
      this.endGame(false);
      return;
    }

    this.dog?.update(dt, pPos, this.player.facing, this.zombieManager);
    const night = this.dayNight.nightFactor();
    this.weather.update(dt, night);
    this.player.setWetness(this.weather.wetness);
    updateEnvironmentUniforms(this.elapsed, this.weather.rain, night);
    this.dayNight.haze = 1 + this.weather.rain * 2.2;
    this.dayNight.cloud = Math.min(1, this.weather.rain * 1.4);
    this.dayNight.update(dt, this.elapsed, pPos, this.camera.position);
    this.applyWeatherLighting();
    this.vfx.setAtmosphere(night, this.weather.rain);
    this.vfx.update(dt, this.elapsed, pPos);
    this.updateWorldEvents(dt);
    this.updateGate(dt);
    this.fort?.update();
    this.story?.update(dt);
    const currentBuilding = this.fort?.buildingAt(pPos) ?? null;
    this.audio.setIndoors(currentBuilding !== null);
    if (this.story?.stage === 'arrive' && currentBuilding?.id === 'Safehouse') this.story.notify('enteredSafehouse');

    // Audio: music follows night / being hunted / the siege; heartbeat & muffling at low health
    const hpFrac = this.player.health / this.player.maxHealth;
    const lowHealth = THREE.MathUtils.clamp((0.4 - hpFrac) / 0.4, 0, 1);
    let hunters = 0;
    for (const z of this.zombieManager.zombies) {
      if ((z.state === 'chase' || z.state === 'attack') && z.group.position.distanceTo(pPos) < 18) hunters++;
    }
    this.audio.setMusicState(night, Math.min(1, hunters / 3), this.extractionActive);
    this.audio.setWeather(this.weather.rain);
    this.audio.setHeartbeat(lowHealth);
    this.audio.setMuffle(lowHealth * 0.55);
    this.audio.update(dt, this.dayNight.isNight(), pPos);
    if (this.engineLoop) this.engineLoop.setRate(0.7 + 0.6 * (1 - this.extractionTimer / SIEGE_SECONDS));

    this.gradePass.uniforms.uLowHealth.value = lowHealth;
    this.gradePass.uniforms.uDamage.value = Math.min(1, this.damageFlashTimer / 0.25);
    this.gradePass.uniforms.uImpact.value = this.impactPulse;
    this.gradePass.uniforms.uHeal.value = Math.min(1, this.healFlashTimer / 0.65);

    // Extraction siege: the clock only runs while you hold the truck
    if (this.extractionActive) {
      this.extractionInRange = pPos.distanceTo(this.worldData.extractionPosition) < EXTRACTION_RADIUS;
      if (this.extractionInRange) this.extractionTimer -= dt;
      this.worldData.extractionBeaconLight.intensity = 3.5 + Math.sin(this.elapsed * 12) * 2.0;
      if (this.extractionTimer <= 0 && !this.siegeDone) {
        this.siegeDone = true;
        this.extractionTimer = 0;
        this.engineLoop?.setRate(1.35);
        this.audio.playUI('ui_alert', 0.9);
        this.story?.notify('siegeDone');
      }
    }

    this.pushHud(dt);

    this.composer.render();
  };

  private pushHud(dt: number): void {
    if (!this.player || !this.zombieManager || !this.dayNight) return;
    this.hud.update(
      {
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        stamina: this.player.stamina,
        maxStamina: this.player.maxStamina,
        hunger: this.player.hunger,
        thirst: this.player.thirst,
        scrap: this.player.scrap,
        noiseLevel: this.player.noiseLevel,
        flashlightOn: this.player.flashlightOn,
        isAiming: this.player.isAiming,
        isCrouching: this.player.isCrouching,
        isSprinting: this.player.isSprinting,
        isReloading: this.player.isReloading,
        reloadProgress: this.player.isReloading
          ? 1 - this.player.reloadTimer / Math.max(0.1, this.player.equippedWeapon.reloadTime)
          : 0,
        equippedWeapon: this.player.equippedWeapon,
        magAmmo: this.player.magAmmo,
        reserveAmmo: this.player.reserveAmmo,
        unlockedWeapons: this.player.unlockedWeapons,
        dayNumber: this.dayNight.dayNumber,
        timeOfDay: this.dayNight.timeOfDay,
        phase: this.dayNight.phase,
        jerrycansCollected: this.jerrycansCollected,
        beaconCollected: this.beaconCollected,
        extractionActive: this.extractionActive,
        extractionTimer: this.extractionTimer,
        extractionInRange: this.extractionInRange,
        dogRecruited: this.dog?.recruited ?? false,
        dogAlertTimer: this.dog?.alertTimer ?? 0,
        zombieCount: this.zombieManager.aliveCount(),
        kills: this.zombieManager.kills,
        nearbyInteractable: this.getNearbyInteractable(),
        inventoryOpen: this.inventoryOpen,
        inventory: this.inventory.slots,
        inventoryVersion: this.inventory.version,
        toastMessage: this.toastMessage,
        crosshairSpread: this.player.equippedWeapon.spread * 10,
        hitMarkerTimer: this.hitMarkerTimer,
        hitKind: this.hitKind,
        damageFlashTimer: this.damageFlashTimer,
        waypoint: this.computeWaypoint(),
        damageIndicators: this.computeDamageIndicators(),
        chapterLabel: this.story ? `Ch ${this.story.chapter} · ${this.story.title}` : '',
        objectiveText: this.story?.objective() ?? '',
        radio: this.story?.radio() ?? null,
        bossHealth: (() => {
          const boss = this.zombieManager.getBoss();
          return boss ? boss.hp / boss.maxHp : null;
        })(),
        rest: this.restOverlay(),
        cinematic: !!this.ending,
        cameraYaw: this.player.yaw,
        objectiveBearing: (() => {
          const goal = this.story?.target();
          if (!goal) return null;
          const p = this.player.getPosition();
          return Math.atan2(goal.pos.x - p.x, -(goal.pos.z - p.z));
        })(),
        dodgeReady: Math.max(0, 1 - this.player.dodgeCooldown / 0.85),
        chapterBanner: this.chapterBanner
          ? {
              chapter: this.chapterBanner.chapter,
              title: this.chapterBanner.title,
              alpha:
                this.chapterBanner.timer < 0.45
                  ? this.chapterBanner.timer / 0.45
                  : this.chapterBanner.timer > this.chapterBanner.dur - 0.65
                  ? Math.max(0, (this.chapterBanner.dur - this.chapterBanner.timer) / 0.65)
                  : 1,
            }
          : null,
        healFlashTimer: this.healFlashTimer,
        isSniperADS: this.player.isAiming && this.player.equippedWeapon.id === 'sniper',
      },
      this.input.isPointerLocked,
      dt
    );

  }

  private endGame(victory: boolean): void {
    this.gameOver = true;
    this.input.exitPointerLock();
    this.audio.setHeartbeat(0);
    this.audio.setMuffle(victory ? 0 : 0.7);
    this.engineLoop?.stop(1.5);
    if (victory) this.audio.playVictorySting();
    else this.audio.playDefeatSting();
    this.gradePass.uniforms.uLowHealth.value = victory ? 0 : 1;
    this.hud.showEndScreen({
      victory,
      kills: this.zombieManager?.kills ?? 0,
      headshots: this.zombieManager?.headshots ?? 0,
      days: this.dayNight?.dayNumber ?? 1,
      seconds: this.survivedSeconds,
    });
  }
}
