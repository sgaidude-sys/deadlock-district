import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { AssetManager } from './AssetManager';
import { AudioManager } from './AudioManager';
import { InputManager } from './InputManager';
import { VFXManager } from './VFXManager';
import { CityGenerator, CityWorldData } from '../world/CityGenerator';
import { PlayerController } from '../entities/PlayerController';
import { ZombieManager } from '../entities/ZombieManager';
import { DogCompanion } from '../entities/DogCompanion';
import { DayNightSystem } from '../systems/DayNightSystem';
import { InventorySystem } from '../systems/InventorySystem';
import { HUD } from '../ui/HUD';
import { InteractableObject, SurvivorId } from '../types/game';

export class Game {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;

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

  private sunLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private fog: THREE.FogExp2;

  private running = false;
  private gameOver = false;
  private inventoryOpen = false;
  private hitStopTimer = 0;
  private spawnGraceTimer = 4.0;
  private hitMarkerTimer = 0;
  private damageFlashTimer = 0;
  private toastMessage: string | null = null;
  private toastTimer = 0;

  private jerrycansCollected = 0;
  private beaconCollected = false;
  private extractionActive = false;
  private extractionTimer = 60;

  private lastTime = performance.now();
  private elapsed = 0;

  constructor(container: HTMLElement, uiRoot: HTMLElement) {
    this.container = container;

    // Scene & Fog
    this.scene = new THREE.Scene();
    this.fog = new THREE.FogExp2(0x5a6875, 0.011);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x5a6875);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      65,
      window.innerWidth / window.innerHeight,
      0.1,
      260
    );

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    // Post-processing (subtle bloom for muzzle flash, fire, streetlamps)
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.32,
      0.5,
      0.85
    );
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    // Lighting
    this.hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x27272a, 0.75);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d6, 2.0);
    this.sunLight.position.set(35, 55, 25);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 160;
    const d = 68;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.scene.add(this.sunLight);

    // Physics
    this.physicsWorld = new CANNON.World({
      gravity: new CANNON.Vec3(0, -18, 0),
    });

    // Core Managers
    this.audio = new AudioManager(this.assets, this.scene);
    this.audio.attachToCamera(this.camera);
    this.input = new InputManager(this.renderer.domElement);
    this.vfx = new VFXManager(this.scene, this.assets);
    this.inventory = new InventorySystem(this.audio);

    // HUD
    this.hud = new HUD(uiRoot, {
      onStartGame: (survivor) => this.startGame(survivor),
      onUseItem: (idx) => {
        if (!this.player) return;
        const msg = this.inventory.useItem(idx, this.player);
        if (msg) this.showToast(msg);
      },
      onCraftMedkit: () => {
        if (!this.player) return;
        this.showToast(this.inventory.craftMedkit(this.player));
      },
      onCraftAmmo: (type) => {
        if (!this.player) return;
        this.showToast(this.inventory.craftAmmo(this.player, type));
      },
      onToggleMute: () => {
        this.audio.setMuted(!this.audio.isMuted());
        const btn = document.getElementById('btn-mute');
        if (btn) btn.textContent = this.audio.isMuted() ? 'Unmute Audio' : 'Mute Audio';
      },
      onResumePointerLock: () => {
        this.inventoryOpen = false;
        this.input.requestPointerLock();
      },
    });

    window.addEventListener('resize', this.handleResize);
    this.bindHotkeys();
  }

  public async init(): Promise<void> {
    await this.assets.preloadAll((loaded, total, label) => {
      this.hud.setLoadProgress(loaded, total, label);
    });

    const cityGen = new CityGenerator(this.scene, this.physicsWorld, this.assets, this.vfx);
    this.worldData = cityGen.generate();

    this.dayNight = new DayNightSystem(
      this.scene,
      this.sunLight,
      this.hemiLight,
      this.fog,
      this.worldData.streetLights,
      this.worldData.burningBarrels
    );

    this.dayNight.onNightFall(() => {
      this.audio.playUI('ui_alert', 0.7);
      this.audio.setTension(0.85);
      this.showToast('THE BLOOD SIREN — Nightfall! Sprinter & Brute spawns doubled!');
    });

    // Render preview loop while on title screen
    this.animate();
  }

  private startGame(survivorId: SurvivorId): void {
    const spawnPos = new THREE.Vector3(-12, 0, 14); // Open avenue near Safehouse & Dog
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

    this.zombieManager = new ZombieManager(
      this.scene,
      this.physicsWorld,
      this.assets,
      this.audio,
      this.vfx,
      this.worldData.zombieSpawnPoints
    );

    this.dog = new DogCompanion(
      this.worldData.dogSpawnPosition,
      this.scene,
      this.assets,
      this.audio
    );

    // Connect sound propagation to Zombie AI
    this.audio.onSoundEmitted((origin, radius) => {
      this.zombieManager?.onSoundEmitted(origin, radius);
    });

    // Connect gun/melee hits
    this.player.setOnShotHit((point, normal, obj, damage, impulseDir, weapon) => {
      const hitZombie = this.zombieManager?.damageZombieByObject(obj, damage, point, normal, impulseDir);
      if (hitZombie) {
        this.hitMarkerTimer = 0.14;
        if (weapon.isMelee || weapon.id === 'shotgun' || weapon.id === 'sniper') {
          this.hitStopTimer = 0.03; // 30ms visceral hit-stop
        }
        if (weapon.isMelee) {
          this.audio.playPositional('melee_hit', point, 0.8);
        }
      } else {
        this.vfx.spawnImpactSparks(point, normal);
      }
    });

    this.audio.startMusic();
    this.input.requestPointerLock();
    this.running = true;
    this.showToast('Scavenge 3 Jerrycans + Radio Beacon. Watch your noise!');
  }

  private bindHotkeys(): void {
    this.input.onKeyPress('KeyF', () => {
      if (this.running && !this.inventoryOpen) this.player?.toggleFlashlight();
    });
    this.input.onKeyPress('KeyC', () => {
      if (this.running && !this.inventoryOpen) this.player?.toggleCrouch();
    });
    this.input.onKeyPress('KeyR', () => {
      if (this.running && !this.inventoryOpen) this.player?.startReload();
    });
    this.input.onKeyPress('KeyQ', () => {
      if (this.running && this.player) {
        const msg = this.inventory.useQuickMedkit(this.player);
        this.showToast(msg ?? 'No Medkits or Bandages in pack!');
      }
    });
    this.input.onKeyPress('Tab', () => {
      if (!this.running || this.gameOver) return;
      this.inventoryOpen = !this.inventoryOpen;
      if (this.inventoryOpen) {
        this.input.exitPointerLock();
      } else {
        this.input.requestPointerLock();
      }
    });
    this.input.onKeyPress('KeyE', () => {
      if (this.running && !this.inventoryOpen) this.handleInteract();
    });

    // Weapon slots 1-6
    this.input.onKeyPress('Digit1', () => this.player?.equipWeapon('axe'));
    this.input.onKeyPress('Digit2', () => this.player?.equipWeapon('pistol'));
    this.input.onKeyPress('Digit3', () => this.player?.equipWeapon('shotgun'));
    this.input.onKeyPress('Digit4', () => this.player?.equipWeapon('smg'));
    this.input.onKeyPress('Digit5', () => this.player?.equipWeapon('rifle'));
    this.input.onKeyPress('Digit6', () => this.player?.equipWeapon('sniper'));
  }

  private getNearbyInteractable(): InteractableObject | null {
    if (!this.player) return null;
    const pPos = this.player.getPosition();
    let best: InteractableObject | null = null;
    let bestDist = Infinity;

    for (const item of this.worldData.interactables) {
      if (item.consumed) continue;
      const d = pPos.distanceTo(item.position);
      if (d <= item.radius && d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    return best;
  }

  private handleInteract(): void {
    if (!this.player) return;
    const item = this.getNearbyInteractable();
    if (!item) return;

    if (item.type === 'loot') {
      item.consumed = true;
      if (item.mesh) this.scene.remove(item.mesh);
      const itemId = (item.data?.itemId as string) || 'canned_food';
      this.inventory.addItem(itemId, 1);
      const scrapGain = 10 + Math.floor(Math.random() * 8);
      this.player.scrap += scrapGain;
      this.audio.playUI('loot_pickup', 0.65);

      // Unlock tiered firearms as player scavenges key crates!
      if (item.id === 'crate_pharm_2') {
        this.player.unlockWeapon('shotgun');
        this.player.equipWeapon('shotgun');
        this.showToast(`Found Pump Shotgun + ${scrapGain} Scrap!`);
      } else if (item.id === 'crate_park') {
        this.player.unlockWeapon('rifle');
        this.player.equipWeapon('rifle');
        this.showToast(`Found M4 Assault Rifle + ${scrapGain} Scrap!`);
      } else if (item.id === 'crate_diner_1') {
        this.player.unlockWeapon('smg');
        this.showToast(`Found MP5 SMG + Diner Burger + ${scrapGain} Scrap!`);
      } else if (item.id === 'crate_ambulance') {
        this.player.unlockWeapon('sniper');
        this.showToast(`Found Marksman Sniper + Medkit + ${scrapGain} Scrap!`);
      } else {
        this.showToast(`Scavenged supply crate (+${scrapGain} Scrap)`);
      }
    } else if (item.type === 'jerrycan') {
      item.consumed = true;
      if (item.mesh) this.scene.remove(item.mesh);
      const glow = item.data?.glow as THREE.PointLight | undefined;
      if (glow) this.scene.remove(glow);
      this.jerrycansCollected++;
      this.audio.playUI('loot_pickup', 0.7);
      this.showToast(`Fuel Jerrycan Collected (${this.jerrycansCollected}/3)`);
    } else if (item.type === 'beacon') {
      item.consumed = true;
      if (item.mesh) this.scene.remove(item.mesh);
      const glow = item.data?.glow as THREE.PointLight | undefined;
      if (glow) this.scene.remove(glow);
      this.beaconCollected = true;
      this.audio.playUI('loot_pickup', 0.7);
      this.showToast('Radio Beacon Parts Acquired!');
    } else if (item.type === 'barricade') {
      if (this.player.scrap < 10) {
        this.showToast('Need 10 Scrap to barricade doorway!');
        return;
      }
      this.player.scrap -= 10;
      const cityGen = new CityGenerator(this.scene, this.physicsWorld, this.assets, this.vfx);
      // Use existing worldData raycast targets & barricade map via helper
      this.placeBarricadeInWorld(item);
      void cityGen;
      this.audio.playPositional('wood_break', item.position, 0.7);
      this.showToast('Doorway Barricaded!');
    } else if (item.type === 'campfire') {
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 35);
      this.audio.playUI('heal_sfx', 0.55);
      this.showToast('Rested by Campfire (+35 Health). Press [Tab] to Craft.');
    } else if (item.type === 'dog') {
      item.consumed = true;
      this.dog?.recruit();
      this.showToast('Survivor Dog Recruited! It will bark near threats & pin zombies.');
    } else if (item.type === 'extraction_truck') {
      if (this.extractionActive) return;
      if (this.jerrycansCollected < 3 || !this.beaconCollected) {
        this.showToast(
          `Need 3 Jerrycans (${this.jerrycansCollected}/3) & Radio Beacon (${this.beaconCollected ? '✓' : '✗'})!`
        );
        return;
      }
      this.extractionActive = true;
      this.extractionTimer = 60;
      this.audio.playUI('ui_alert', 0.9);
      this.audio.setTension(1.0);
      this.worldData.extractionBeaconLight.color.setHex(0x22c55e);
      this.showToast('EXTRACTION STARTED! Survive the 60-second Horde Siege!');
    }
  }

  private placeBarricadeInWorld(item: InteractableObject): void {
    item.consumed = true;
    const pallet = this.assets.cloneModel('prop_pallet');
    pallet.position.set(item.position.x, 0, item.position.z);
    const horizontal = Boolean(item.data?.horizontal);
    if (!horizontal) pallet.rotation.y = Math.PI / 2;
    pallet.scale.set(2.2, 1.6, 1.2);
    this.scene.add(pallet);
    this.worldData.raycastTargets.push(pallet);

    const sx = horizontal ? 3.0 : 0.6;
    const sz = horizontal ? 0.6 : 3.0;
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx * 0.5, 1.0, sz * 0.5)),
      position: new CANNON.Vec3(item.position.x, 1.0, item.position.z),
    });
    this.physicsWorld.addBody(body);
  }

  private showToast(msg: string): void {
    this.toastMessage = msg;
    this.toastTimer = 3.6;
  }

  private handleResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const now = performance.now();
    const rawDt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= rawDt;
      this.composer.render();
      return;
    }

    const dt = rawDt;
    this.elapsed += dt;

    if (!this.running) {
      // Gentle title camera orbit
      this.camera.position.set(Math.sin(this.elapsed * 0.15) * 32, 16, Math.cos(this.elapsed * 0.15) * 32);
      this.camera.lookAt(0, 2, 0);
      this.dayNight?.update(dt * 0.25, this.elapsed);
      this.vfx.update(dt, this.elapsed);
      this.composer.render();
      return;
    }

    if (this.gameOver || !this.player || !this.zombieManager || !this.dayNight) {
      this.composer.render();
      return;
    }

    // Timers
    this.spawnGraceTimer = Math.max(0, this.spawnGraceTimer - dt);
    this.hitMarkerTimer = Math.max(0, this.hitMarkerTimer - dt);
    this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastMessage = null;
    }

    // Physics step
    this.physicsWorld.step(1 / 60, dt, 3);

    // Build combined raycast list (world + live zombies)
    const raycastTargets = [
      ...this.worldData.raycastTargets,
      ...this.zombieManager.getRaycastMeshes(),
    ];

    this.player.update(dt, raycastTargets, this.inventoryOpen);

    const pPos = this.player.getPosition();
    this.zombieManager.update(
      dt,
      pPos,
      this.dayNight.isNight(),
      this.extractionActive,
      (dmg) => {
        if (!this.player || this.gameOver || this.spawnGraceTimer > 0) return;
        this.player.takeDamage(dmg);
        this.damageFlashTimer = 0.25;
        if (this.player.health <= 0) {
          this.endGame(false);
        }
      }
    );

    this.dog?.update(dt, pPos, this.zombieManager);
    this.dayNight.update(dt, this.elapsed);
    this.vfx.update(dt, this.elapsed);
    this.audio.update(dt);

    // Music tension based on night / siege / proximity
    if (!this.extractionActive) {
      const baseTension = this.dayNight.isNight() ? 0.85 : 0.12;
      this.audio.setTension(baseTension);
    }

    // Extraction 60s Siege countdown
    if (this.extractionActive) {
      this.extractionTimer -= dt;
      this.worldData.extractionBeaconLight.intensity = 3.5 + Math.sin(this.elapsed * 12) * 2.0;
      if (this.extractionTimer <= 0) {
        this.endGame(true);
        return;
      }
    }

    // Update HUD
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
        dogRecruited: this.dog?.recruited ?? false,
        dogAlertTimer: this.dog?.alertTimer ?? 0,
        zombieCount: this.zombieManager.zombies.filter((z) => z.state !== 'dead').length,
        kills: this.zombieManager.kills,
        nearbyInteractable: this.getNearbyInteractable(),
        inventoryOpen: this.inventoryOpen,
        inventory: this.inventory.slots,
        toastMessage: this.toastMessage,
        crosshairSpread: this.player.equippedWeapon.spread * 10,
        hitMarkerTimer: this.hitMarkerTimer,
        damageFlashTimer: this.damageFlashTimer,
      },
      this.input.isPointerLocked
    );

    this.composer.render();
  };

  private endGame(victory: boolean): void {
    this.gameOver = true;
    this.input.exitPointerLock();
    this.hud.showEndScreen(
      victory,
      this.zombieManager?.kills ?? 0,
      this.dayNight?.dayNumber ?? 1
    );
  }
}
