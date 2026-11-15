import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import { AssetManager } from './AssetManager';
import { AudioManager } from './AudioManager';
import { InputManager } from './InputManager';
import { VFXManager, ObjectiveMarker } from './VFXManager';
import { BarricadeInstance, CityGenerator, CityWorldData } from '../world/CityGenerator';
import { PlayerController } from '../entities/PlayerController';
import { ZombieManager } from '../entities/ZombieManager';
import { DogCompanion } from '../entities/DogCompanion';
import { DayNightSystem } from '../systems/DayNightSystem';
import { InventorySystem } from '../systems/InventorySystem';
import { HUD } from '../ui/HUD';
import { DamageIndicator, InteractableObject, SurvivorId, WaypointState, WeaponId } from '../types/game';
import { WEAPONS } from '../data/catalog';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.38 },
    uLowHealth: { value: 0 },
    uDamage: { value: 0 },
    uGrain: { value: 0.035 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uLowHealth, uDamage, uGrain;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float ca = uDamage * 0.006 + uLowHealth * 0.0018;
      vec4 c = texture2D(tDiffuse, vUv);
      c.r = texture2D(tDiffuse, vUv + d * ca * 2.0).r;
      c.b = texture2D(tDiffuse, vUv - d * ca * 2.0).b;
      // Cool shadows, warm highlights
      float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb * vec3(0.93, 0.99, 1.06), c.rgb * vec3(1.04, 1.0, 0.94), smoothstep(0.2, 0.8, lum));
      // Desaturate as health drops
      c.rgb = mix(c.rgb, vec3(lum), uLowHealth * 0.65);
      // Vignette (tightens at low health)
      float v = smoothstep(0.95, 0.3, length(d) * 1.3);
      c.rgb *= mix(1.0, v, clamp(uVignette + uLowHealth * 0.4, 0.0, 1.0));
      // Red pulse on damage / near death
      float pulse = uDamage * 0.5 + uLowHealth * 0.22 * (0.5 + 0.5 * sin(uTime * 5.5));
      c.rgb = mix(c.rgb, c.rgb * vec3(1.35, 0.55, 0.55), pulse * smoothstep(0.15, 0.75, length(d) * 1.4));
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
  private gradePass: ShaderPass;

  private physicsWorld: CANNON.World;
  private assets = new AssetManager();
  private audio: AudioManager;
  private input: InputManager;
  private vfx: VFXManager;
  private hud: HUD;

  private worldData!: CityWorldData;
  private player: PlayerController | null = null;
  private zombieManager: ZombieManager | null = null;
  private dog: DogCompanion | null = null;
  private dayNight: DayNightSystem | null = null;
  private inventory: InventorySystem;
  private barricades: BarricadeInstance[] = [];

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

  private settings = { volume: 0.8, sensitivity: 1, muted: false };

  private lastTime = performance.now();
  private elapsed = 0;
  private titleLook = new THREE.Vector3(0, 2, 0);

  constructor(container: HTMLElement, uiRoot: HTMLElement) {
    this.container = container;

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
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // Post: bloom for muzzle flashes / fire / neon, then tone-map, then colour grade
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.38, 0.55, 0.82));
    this.composer.addPass(new OutputPass());
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

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
        const msg = this.inventory.useItem(idx, this.player);
        if (msg) this.showToast(msg);
      },
      onCraftMedkit: () => {
        if (this.player) this.showToast(this.inventory.craftMedkit(this.player));
      },
      onCraftAmmo: (type) => {
        if (this.player) this.showToast(this.inventory.craftAmmo(this.player, type));
      },
      onToggleMute: () => {
        this.settings.muted = !this.settings.muted;
        this.audio.setMuted(this.settings.muted);
        this.hud.setMuted(this.settings.muted);
        this.saveSettings();
      },
      onResume: () => this.resume(),
      onRestart: () => window.location.reload(),
      onVolumeChange: (v) => {
        this.settings.volume = v;
        this.audio.setMasterVolume(v);
        this.saveSettings();
      },
      onSensitivityChange: (v) => {
        this.settings.sensitivity = v;
        this.input.sensitivity = 0.0022 * v;
        this.saveSettings();
      },
    });
    this.hud.setSettings(this.settings.volume, this.settings.sensitivity, this.settings.muted);

    window.addEventListener('resize', this.handleResize);
    new ResizeObserver(this.handleResize).observe(this.container);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running && !this.gameOver) this.setPaused(true);
    });
    this.input.onPointerLockChange((locked) => {
      if (!locked && this.running && !this.inventoryOpen && !this.gameOver && this.input.hasEverLocked) {
        this.setPaused(true);
      }
    });
    this.bindHotkeys();
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
    this.audio.setMuted(this.settings.muted);
    this.input.sensitivity = 0.0022 * this.settings.sensitivity;
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

    this.dayNight.onNightFall(() => {
      if (!this.running) return;
      this.audio.playSiren();
      this.audio.setTension(0.85);
      this.showToast('THE BLOOD SIREN WAILS — nightfall. Sprinters & Brutes are hunting.', 5);
    });
    this.dayNight.onDawn(() => {
      if (!this.running) return;
      this.audio.playObjectiveChime();
      this.showToast(`Dawn breaks. You survived night ${this.dayNight!.dayNumber - 1}.`, 4);
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
    this.zombieManager.setBarricades(this.barricades, (b) => this.breakBarricade(b));

    this.dog = new DogCompanion(this.worldData.dogSpawnPosition, this.scene, this.assets, this.audio);

    this.audio.onSoundEmitted((origin, radius) => {
      this.zombieManager?.onSoundEmitted(origin, radius);
    });

    this.player.setOnShotHit((point, normal, obj, damage, impulseDir, weapon) => {
      const res = this.zombieManager?.damageZombieByObject(obj, damage, point, normal, impulseDir);
      if (res) {
        this.registerHit(res.killed ? 'kill' : res.headshot ? 'head' : 'hit');
        if (weapon.id === 'shotgun' || weapon.id === 'sniper' || res.killed) this.hitStopTimer = 0.03;
      } else {
        this.vfx.spawnImpactSparks(point, normal);
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
    this.input.requestPointerLock();
    this.running = true;
    this.showToast('Find 3 Jerrycans + the Radio Beacon. Gunfire attracts the dead.', 5);
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
    if (paused) this.input.exitPointerLock();
  }

  private resume(): void {
    this.audio.resume();
    if (this.inventoryOpen) this.inventoryOpen = false;
    if (this.paused) this.setPaused(false);
    this.input.requestPointerLock();
  }

  private bindHotkeys(): void {
    const active = () => this.running && !this.inventoryOpen && !this.paused && !this.gameOver;
    this.input.onKeyPress('KeyF', () => active() && this.player?.toggleFlashlight());
    this.input.onKeyPress('KeyV', () => active() && this.player?.swapShoulder());
    this.input.onKeyPress('KeyC', () => active() && this.player?.toggleCrouch());
    this.input.onKeyPress('KeyR', () => active() && this.player?.startReload());
    this.input.onKeyPress('KeyQ', () => {
      if (!active() || !this.player) return;
      const msg = this.inventory.useQuickMedkit(this.player);
      this.showToast(msg ?? 'No Medkits or Bandages in pack!');
    });
    this.input.onKeyPress('Tab', () => {
      if (!this.running || this.gameOver || this.paused) return;
      this.inventoryOpen = !this.inventoryOpen;
      this.audio.playUI('ui_click', 0.3, this.inventoryOpen ? 1.1 : 0.9);
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
      const itemId = (item.data?.itemId as string) || 'canned_food';
      const gotText = this.inventory.pickup(itemId, this.player);
      const scrapGain = 10 + Math.floor(Math.random() * 8);
      this.player.scrap += scrapGain;
      this.audio.playUI('loot_pickup', 0.65);
      this.audio.playUI('door_open', 0.25, 1.3);

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
        this.audio.playObjectiveChime();
        this.showToast(`Found ${wname} [${WEAPONS[wid].slot}]! ${gotText} • +${scrapGain} Scrap`, 4.5);
      } else {
        this.showToast(`${gotText} • +${scrapGain} Scrap`);
      }
    } else if (item.type === 'jerrycan') {
      this.collect(item);
      this.jerrycansCollected++;
      this.audio.playUI('loot_pickup', 0.7);
      this.audio.playObjectiveChime();
      this.showToast(`Fuel Jerrycan secured (${this.jerrycansCollected}/3)`);
      this.checkExtractionReady();
    } else if (item.type === 'beacon') {
      this.collect(item);
      this.beaconCollected = true;
      this.audio.playUI('loot_pickup', 0.7);
      this.audio.playObjectiveChime();
      this.showToast('Radio Beacon parts acquired!');
      this.checkExtractionReady();
    } else if (item.type === 'barricade') {
      this.toggleBarricade(item);
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
      this.audio.playUI('heal_sfx', 0.55);
      this.showToast('Rested by the campfire (+35 Health).');
    } else if (item.type === 'dog') {
      item.consumed = true;
      this.dog?.recruit();
      this.showToast('Survivor dog recruited! It barks at threats and pins zombies.');
    } else if (item.type === 'extraction_truck') {
      if (this.extractionActive) return;
      if (this.jerrycansCollected < 3 || !this.beaconCollected) {
        this.showToast(
          `Need 3 Jerrycans (${this.jerrycansCollected}/3) & Radio Beacon (${this.beaconCollected ? '✓' : '✗'})`
        );
        return;
      }
      item.consumed = true;
      this.extractionActive = true;
      this.extractionTimer = SIEGE_SECONDS;
      this.audio.playUI('ui_alert', 0.9);
      this.audio.playSiren();
      this.audio.setTension(1.0);
      this.worldData.extractionBeaconLight.color.setHex(0xef4444);
      this.showToast(`ENGINE PRIMING — hold the truck for ${SIEGE_SECONDS} seconds!`, 5);
    }
  }

  private checkExtractionReady(): void {
    if (this.jerrycansCollected >= 3 && this.beaconCollected) {
      this.worldData.extractionMarker.setActive(true);
      this.worldData.extractionBeaconLight.color.setHex(0x22c55e);
      this.showToast('All parts found! Head to the armored truck at the North Gate.', 5);
    }
  }

  private toggleBarricade(item: InteractableObject): void {
    if (!this.player) return;
    const existing = this.barricades.find((b) => b.interactable === item);
    if (existing) {
      this.removeBarricade(existing);
      this.player.scrap += 5;
      this.audio.playPositional('wood_break', item.position, 0.6);
      this.showToast('Barricade dismantled (+5 Scrap).');
      return;
    }
    if (this.player.scrap < 10) {
      this.showToast('Need 10 Scrap to barricade this doorway.');
      return;
    }
    // Don't trap the player (or wedge them inside the collider)
    if (this.player.getPosition().distanceTo(item.position.clone().setY(0)) < 1.1) {
      this.showToast('Step out of the doorway first.');
      return;
    }
    this.player.scrap -= 10;
    const { mesh, body } = CityGenerator.buildBarricade(this.scene, this.physicsWorld, this.assets, item);
    this.worldData.raycastTargets.push(mesh);
    this.barricades.push({
      id: item.id,
      interactable: item,
      mesh,
      body,
      position: item.position.clone().setY(0),
      hp: 120,
      maxHp: 120,
    });
    item.label = 'Remove Barricade';
    item.subLabel = 'Refunds 5 Scrap';
    this.audio.playPositional('wood_break', item.position, 0.7, 0.05);
    this.showToast('Doorway barricaded — zombies will have to break through.');
  }

  private removeBarricade(b: BarricadeInstance): void {
    this.scene.remove(b.mesh);
    this.physicsWorld.removeBody(b.body);
    const idx = this.worldData.raycastTargets.indexOf(b.mesh);
    if (idx >= 0) this.worldData.raycastTargets.splice(idx, 1);
    this.barricades.splice(this.barricades.indexOf(b), 1);
    b.interactable.label = b.interactable.id.replace('barricade_', 'Barricade ') + ' Door';
    b.interactable.subLabel = 'Costs 10 Scrap • Zombies can break it';
  }

  private breakBarricade(b: BarricadeInstance): void {
    if (!this.barricades.includes(b)) return;
    this.removeBarricade(b);
    const debris = this.assets.cloneModel('prop_pallet_broken');
    debris.position.copy(b.position).setY(0.04);
    debris.rotation.y = Math.random() * Math.PI;
    this.scene.add(debris);
    this.audio.playPositional('wood_break', b.position, 1.0, 0.05);
    this.showToast('A barricade has been smashed!');
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
  };

  private computeWaypoint(): WaypointState | null {
    if (!this.player) return null;
    let target: THREE.Vector3 | null = null;
    let label = '';
    let color = '#f59e0b';
    const pPos = this.player.getPosition();

    if (this.extractionActive || (this.jerrycansCollected >= 3 && this.beaconCollected)) {
      target = this.worldData.extractionPosition.clone().add(new THREE.Vector3(0, 3, 0));
      label = this.extractionActive ? 'Defend' : 'Extract';
      color = '#22c55e';
    } else {
      let best = Infinity;
      for (const it of this.worldData.interactables) {
        if (it.consumed) continue;
        const want = (it.type === 'jerrycan' && this.jerrycansCollected < 3) || (it.type === 'beacon' && !this.beaconCollected);
        if (!want) continue;
        const d = it.position.distanceTo(pPos);
        if (d < best) {
          best = d;
          target = it.position.clone().add(new THREE.Vector3(0, 1.2, 0));
          label = it.type === 'jerrycan' ? 'Fuel' : 'Beacon';
          color = it.type === 'jerrycan' ? '#ef4444' : '#38bdf8';
        }
      }
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
    requestAnimationFrame(this.animate);

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
      this.vfx.update(dt, this.elapsed, this.camera.position);
      this.composer.render();
      return;
    }

    if (this.paused || this.gameOver || !this.player || !this.zombieManager || !this.dayNight) {
      this.audio.update(dt, this.dayNight?.isNight() ?? false);
      this.composer.render();
      return;
    }

    // Timers
    this.survivedSeconds += dt;
    this.spawnGraceTimer = Math.max(0, this.spawnGraceTimer - dt);
    this.hitMarkerTimer = Math.max(0, this.hitMarkerTimer - dt);
    this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    this.campfireCooldown = Math.max(0, this.campfireCooldown - dt);
    for (const ev of this.damageEvents) ev.t -= dt;
    this.damageEvents = this.damageEvents.filter((ev) => ev.t > 0);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastMessage = null;
    }

    this.physicsWorld.step(1 / 60, dt, 3);

    const raycastTargets = [...this.worldData.raycastTargets, ...this.zombieManager.getRaycastMeshes()];
    this.player.update(dt, raycastTargets, this.inventoryOpen);

    const pPos = this.player.getPosition();
    this.zombieManager.update(
      dt,
      pPos,
      this.player.isCrouching,
      this.dayNight.isNight(),
      this.extractionActive,
      (dmg, from) => {
        if (!this.player || this.gameOver || this.spawnGraceTimer > 0) return;
        this.player.takeDamage(dmg);
        this.damageFlashTimer = 0.25;
        this.damageEvents.push({ from: from.clone(), t: 1.2 });
      }
    );

    if (this.player.health <= 0) {
      this.endGame(false);
      return;
    }

    this.dog?.update(dt, pPos, this.player.facing, this.zombieManager);
    this.dayNight.update(dt, this.elapsed, pPos, this.camera.position);
    this.vfx.update(dt, this.elapsed, pPos);

    // Audio state: music tension, low-health heartbeat & muffling
    const hpFrac = this.player.health / this.player.maxHealth;
    const lowHealth = THREE.MathUtils.clamp((0.4 - hpFrac) / 0.4, 0, 1);
    if (!this.extractionActive) {
      let tension = this.dayNight.isNight() ? 0.85 : 0.1;
      const chasing = this.zombieManager.zombies.some((z) => z.state === 'chase' && z.group.position.distanceTo(pPos) < 20);
      if (chasing) tension = Math.max(tension, 0.55);
      this.audio.setTension(tension);
    }
    this.audio.setHeartbeat(lowHealth);
    this.audio.setMuffle(lowHealth * 0.55);
    this.audio.update(dt, this.dayNight.isNight());

    this.gradePass.uniforms.uLowHealth.value = lowHealth;
    this.gradePass.uniforms.uDamage.value = Math.min(1, this.damageFlashTimer / 0.25);

    // Extraction siege: the clock only runs while you hold the truck
    if (this.extractionActive) {
      this.extractionInRange = pPos.distanceTo(this.worldData.extractionPosition) < EXTRACTION_RADIUS;
      if (this.extractionInRange) this.extractionTimer -= dt;
      this.worldData.extractionBeaconLight.intensity = 3.5 + Math.sin(this.elapsed * 12) * 2.0;
      if (this.extractionTimer <= 0) {
        this.endGame(true);
        return;
      }
    }

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
      },
      this.input.isPointerLocked,
      dt
    );

    this.composer.render();
  };

  private endGame(victory: boolean): void {
    this.gameOver = true;
    this.input.exitPointerLock();
    this.audio.setHeartbeat(0);
    this.audio.setMuffle(victory ? 0 : 0.7);
    if (victory) this.audio.playObjectiveChime();
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
