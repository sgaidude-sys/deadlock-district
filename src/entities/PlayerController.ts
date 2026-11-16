import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager, Surface } from '../core/AudioManager';
import { InputManager } from '../core/InputManager';
import { VFXManager } from '../core/VFXManager';
import { WEAPONS } from '../data/catalog';
import { SurvivorId, WeaponDef, WeaponId } from '../types/game';

export interface ShotHitCallback {
  (
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    hitObject: THREE.Object3D,
    damage: number,
    impulseDir: THREE.Vector3,
    weapon: WeaponDef
  ): void;
}

export interface MeleeCallback {
  (origin: THREE.Vector3, forward: THREE.Vector3, weapon: WeaponDef): boolean;
}

/** Baked weapon node inside the Zombie Apocalypse Kit rig (held in the left hand), and muzzle offset. */
const BAKED_WEAPON: Record<WeaponId, { node: string; muzzle: number; scale: number }> = {
  axe: { node: 'Axe', muzzle: 0, scale: 1 },
  pistol: { node: 'Pistol', muzzle: 0.32, scale: 1 },
  shotgun: { node: 'Shotgun', muzzle: 0.75, scale: 1 },
  smg: { node: 'SMG', muzzle: 0.5, scale: 1 },
  rifle: { node: 'Rifle', muzzle: 0.75, scale: 1 },
  sniper: { node: 'Rifle', muzzle: 0.85, scale: 1.12 },
};
const ALL_BAKED = ['Axe', 'Guitar', 'Knife', 'Pistol', 'Rifle', 'Shotgun', 'SMG', 'Spear', 'WoodenBat_Barbed', 'WoodenBat_Saw'];

// Kit survivors are ~1.4 m tall at native scale
const STAND_HEIGHT = 1.3;
const CROUCH_HEIGHT = 0.95;
const BODY_RADIUS = 0.38;

// Ground speeds (m/s) and the speeds the kit clips were authored at, so feet don't slide.
const SPEED = { walk: 1.9, jog: 3.9, sprint: 5.8, crouch: 1.5 };
const CLIP_SPEED = { walk: 1.3, run: 2.1 };

const PITCH_MIN = -1.1; // looking down from above
const PITCH_MAX = 0.55; // looking up

export class PlayerController {
  public group = new THREE.Group();
  public body: CANNON.Body;

  /** Camera / aim orientation (driven by the mouse). */
  public yaw = 0;
  public pitch = -0.15;
  /** Direction the character's body faces (turns toward movement, or toward the aim). */
  public facing = 0;
  public trauma = 0;

  public health = 100;
  public maxHealth = 100;
  public stamina = 100;
  public maxStamina = 100;
  public hunger = 100;
  public thirst = 100;
  public scrap = 20;
  public noiseLevel = 0;

  public flashlightOn = true;
  public isAiming = false;
  public isCrouching = false;
  public isSprinting = false;
  public isReloading = false;
  public reloadTimer = 0;

  public unlockedWeapons: WeaponId[] = ['axe', 'pistol'];
  public equippedWeapon: WeaponDef = WEAPONS.pistol;
  public magAmmo: Record<WeaponId, number> = {
    axe: 0,
    pistol: WEAPONS.pistol.magSize,
    shotgun: WEAPONS.shotgun.magSize,
    smg: WEAPONS.smg.magSize,
    rifle: WEAPONS.rifle.magSize,
    sniper: WEAPONS.sniper.magSize,
  };
  public reserveAmmo: Record<'pistol' | 'shells' | 'rifle', number> = {
    pistol: 45,
    shells: 12,
    rifle: 30,
  };

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private assets: AssetManager;
  private audio: AudioManager;
  private input: InputManager;
  private vfx: VFXManager;

  private modelGroup: THREE.Group;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private currentAnim = '';
  private animLockTimer = 0;
  private bakedWeapons = new Map<string, THREE.Object3D>();
  private activeWeaponNode: THREE.Object3D | null = null;

  private flashlight: THREE.SpotLight;
  private flashlightTarget = new THREE.Object3D();
  private volumetricCone: THREE.Mesh;

  private fireCooldown = 0;
  private dryFireCooldown = 0;
  private stepTimer = 0;
  private pendingMelee = -1;
  private recoilPitch = 0;
  /** While > 0 the body stays turned toward the aim (after shooting). */
  private combatFacingTimer = 0;
  private raycaster = new THREE.Raycaster();
  private camRaycaster = new THREE.Raycaster();
  private onShotHit?: ShotHitCallback;
  private onMelee?: MeleeCallback;
  private cameraOccluders: THREE.Object3D[] = [];
  private surfaceAt: (x: number, z: number) => Surface = () => 'concrete';
  private gaspCooldown = 0;

  // Camera
  private shoulderSide = -1; // -1 = over the left shoulder (the gun hand), 1 = right
  private shoulderBlend = -1;
  private currentCamPos = new THREE.Vector3();
  private camDistance = 3.4;
  private eyeHeight = STAND_HEIGHT;

  constructor(
    survivorId: SurvivorId,
    spawnPos: THREE.Vector3,
    scene: THREE.Scene,
    physicsWorld: CANNON.World,
    camera: THREE.PerspectiveCamera,
    assets: AssetManager,
    audio: AudioManager,
    input: InputManager,
    vfx: VFXManager
  ) {
    this.scene = scene;
    this.camera = camera;
    this.assets = assets;
    this.audio = audio;
    this.input = input;
    this.vfx = vfx;

    // No damping: velocity is driven directly each frame (damping made us ~20% slower than intended)
    this.body = new CANNON.Body({
      mass: 75,
      shape: new CANNON.Sphere(BODY_RADIUS),
      position: new CANNON.Vec3(spawnPos.x, BODY_RADIUS, spawnPos.z),
      linearDamping: 0,
      fixedRotation: true,
    });
    physicsWorld.addBody(this.body);

    const modelKey = `survivor_${survivorId}`;
    this.modelGroup = this.assets.cloneModel(modelKey);

    // The rig carries every weapon on the left-hand bone; show only the equipped one.
    this.modelGroup.traverse((child) => {
      if (ALL_BAKED.includes(child.name)) {
        child.visible = false;
        if (!this.bakedWeapons.has(child.name)) this.bakedWeapons.set(child.name, child);
      }
      if ((child as THREE.Mesh).isMesh) {
        child.frustumCulled = false;
        (child as THREE.Mesh).raycast = () => {}; // never block our own bullets / camera rays
      }
    });

    this.group.add(this.modelGroup);
    this.scene.add(this.group);

    const clips = this.assets.getClips(modelKey);
    if (clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.modelGroup);
      for (const clip of clips) this.actions[clip.name] = this.mixer.clipAction(clip);
      this.mixer.addEventListener('finished', () => {
        this.animLockTimer = 0;
      });
      this.playAnim('Idle_Gun');
    }

    // Flashlight. It is never hidden (that changes the scene's light count and forces every
    // material to recompile — a visible freeze); "off" is intensity 0.
    this.flashlight = new THREE.SpotLight(0xfff5db, 7, 40, Math.PI / 6, 0.5, 1.3);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.bias = -0.002;
    this.flashlight.position.set(0.2, 1.05, 0.3);
    this.group.add(this.flashlight);
    this.group.add(this.flashlightTarget);
    this.flashlightTarget.position.set(0, 0.9, 10);
    this.flashlight.target = this.flashlightTarget;

    this.volumetricCone = this.vfx.createFlashlightConeMesh();
    this.volumetricCone.position.copy(this.flashlight.position);
    this.volumetricCone.raycast = () => {};
    this.group.add(this.volumetricCone);

    this.equipWeapon('pistol', true);
    this.currentCamPos.copy(spawnPos).add(new THREE.Vector3(0, 1.8, 3.4));
  }

  public setOnShotHit(cb: ShotHitCallback): void {
    this.onShotHit = cb;
  }

  public setOnMelee(cb: MeleeCallback): void {
    this.onMelee = cb;
  }

  public setSurfaceResolver(fn: (x: number, z: number) => Surface): void {
    this.surfaceAt = fn;
  }

  public setCameraOccluders(list: THREE.Object3D[]): void {
    this.cameraOccluders = list;
  }

  /** Point both the camera and the body the same way (spawn). */
  public setYaw(yaw: number): void {
    this.yaw = yaw;
    this.facing = yaw;
  }

  /**
   * Smoothed position: physics runs at a fixed 60 Hz, so the raw body position only changes on
   * physics ticks (stutter at 120/144 Hz and with uneven frame times). The interpolated position
   * is updated every rendered frame.
   */
  public getPosition(): THREE.Vector3 {
    const p = this.body.interpolatedPosition;
    return new THREE.Vector3(p.x, 0, p.z);
  }

  /** Direction the character's body faces. */
  public getForward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.facing), 0, -Math.cos(this.facing));
  }

  private camForward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  public toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.intensity = this.flashlightOn ? 7 : 0;
    this.volumetricCone.visible = this.flashlightOn;
    this.audio.playUI('ui_click', 0.35, 1.4);
  }

  public toggleCrouch(): void {
    this.isCrouching = !this.isCrouching;
  }

  public swapShoulder(): void {
    this.shoulderSide *= -1;
  }

  public unlockWeapon(id: WeaponId): void {
    if (!this.unlockedWeapons.includes(id)) this.unlockedWeapons.push(id);
  }

  public cycleWeapon(dir: number): void {
    const order: WeaponId[] = ['axe', 'pistol', 'shotgun', 'smg', 'rifle', 'sniper'];
    const owned = order.filter((w) => this.unlockedWeapons.includes(w));
    const idx = owned.indexOf(this.equippedWeapon.id);
    this.equipWeapon(owned[(idx + dir + owned.length) % owned.length]);
  }

  public equipWeapon(id: WeaponId, silent = false): void {
    if (!this.unlockedWeapons.includes(id)) return;
    if (this.equippedWeapon.id === id && this.activeWeaponNode) return;
    if (this.isReloading) {
      this.isReloading = false;
      this.reloadTimer = 0;
    }
    this.pendingMelee = -1;
    this.equippedWeapon = WEAPONS[id];

    if (this.activeWeaponNode) this.activeWeaponNode.visible = false;
    const spec = BAKED_WEAPON[id];
    this.activeWeaponNode = this.bakedWeapons.get(spec.node) ?? null;
    if (this.activeWeaponNode) {
      this.activeWeaponNode.visible = true;
      this.activeWeaponNode.scale.setScalar(spec.scale);
    }
    this.fireCooldown = Math.max(this.fireCooldown, 0.25);
    this.currentAnim = ''; // re-pick the gun / melee locomotion set
    if (!silent) this.audio.playUI('gear_rustle', 0.4, 1.1);
  }

  public startReload(): void {
    const w = this.equippedWeapon;
    if (w.isMelee || this.isReloading || !w.ammoType) return;
    if (this.magAmmo[w.id] >= w.magSize || this.reserveAmmo[w.ammoType] <= 0) return;
    this.isReloading = true;
    this.reloadTimer = w.reloadTime;
    this.audio.playUI('reload', 0.6);
  }

  public takeDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
    this.trauma = Math.min(1, this.trauma + 0.45);
    this.audio.playHurt();
    if (this.animLockTimer <= 0) this.playAnim('HitReact', true, 0.3);
  }

  public addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  private playAnim(name: string, oneShot = false, lockSeconds = 0, timeScale = 1): void {
    if (!this.mixer) return;
    const target = this.actions[name] ?? this.actions['Idle_Gun'] ?? this.actions['Idle'];
    if (!target) return;
    if (this.currentAnim === name && !oneShot) return;

    const prev = this.actions[this.currentAnim];
    if (prev && prev !== target) prev.fadeOut(0.18);
    target.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(0.15);
    if (oneShot) {
      target.setLoop(THREE.LoopOnce, 1);
      target.clampWhenFinished = false;
      this.animLockTimer = lockSeconds;
    } else {
      target.setLoop(THREE.LoopRepeat, Infinity);
    }
    target.play();
    this.currentAnim = name;
  }

  /** Locomotion never interrupts a running one-shot (swing / hit react). */
  private playLocomotion(name: string, timeScale = 1): void {
    if (this.animLockTimer > 0) return;
    this.playAnim(name);
    this.actions[name]?.setEffectiveTimeScale(timeScale);
  }

  private turnFacing(target: number, dt: number, rate: number): void {
    let diff = target - this.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.facing += diff * Math.min(1, dt * rate);
  }

  public update(dt: number, raycastTargets: THREE.Object3D[], inventoryOpen: boolean): void {
    if (this.mixer) this.mixer.update(dt);
    this.animLockTimer = Math.max(0, this.animLockTimer - dt);
    this.combatFacingTimer = Math.max(0, this.combatFacingTimer - dt);

    this.hunger = Math.max(0, this.hunger - dt * 0.2);
    this.thirst = Math.max(0, this.thirst - dt * 0.27);
    if (this.hunger <= 0 || this.thirst <= 0) this.health = Math.max(0, this.health - dt * 1.5);

    this.noiseLevel = Math.max(0, this.noiseLevel - dt * 45);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.dryFireCooldown = Math.max(0, this.dryFireCooldown - dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.8);

    if (this.isReloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }

    if (this.recoilPitch > 0) {
      const rec = Math.min(this.recoilPitch, dt * 0.9);
      this.recoilPitch -= rec;
      this.pitch -= rec * 0.6;
    }

    // ── Free orbit camera: mouse (or arrow keys) moves the camera, not the body ──
    if (!inventoryOpen && this.input.isPointerLocked) {
      const { dx, dy } = this.input.consumeMouseDelta();
      const adsScale = this.isAiming ? 0.6 : 1;
      this.yaw -= dx * adsScale;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * adsScale, PITCH_MIN, PITCH_MAX);
    } else {
      this.input.consumeMouseDelta();
    }
    if (!inventoryOpen) {
      const keyLook = 2.2 * dt;
      if (this.input.isDown('ArrowLeft')) this.yaw += keyLook;
      if (this.input.isDown('ArrowRight')) this.yaw -= keyLook;
      if (this.input.isDown('ArrowUp')) this.pitch = Math.min(PITCH_MAX, this.pitch + keyLook * 0.7);
      if (this.input.isDown('ArrowDown')) this.pitch = Math.max(PITCH_MIN, this.pitch - keyLook * 0.7);
    }

    this.isAiming = !inventoryOpen && this.input.rightMouseDown && !this.equippedWeapon.isMelee;

    // ── Movement is relative to the camera ──
    const camFwd = this.camForward();
    const camRight = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const moveDir = new THREE.Vector3();
    if (!inventoryOpen) {
      if (this.input.isDown('KeyW')) moveDir.add(camFwd);
      if (this.input.isDown('KeyS')) moveDir.sub(camFwd);
      if (this.input.isDown('KeyD')) moveDir.add(camRight);
      if (this.input.isDown('KeyA')) moveDir.sub(camRight);
    }
    const isMoving = moveDir.lengthSq() > 0.001;
    if (isMoving) moveDir.normalize();

    // Aiming / shooting: body faces the crosshair and strafes. Otherwise it turns to face travel.
    const combatStance = this.isAiming || this.combatFacingTimer > 0;
    const sprintHeld = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
    const wantsSprint = sprintHeld && isMoving && !this.isAiming;
    if (wantsSprint && this.isCrouching) this.isCrouching = false;
    this.isSprinting = wantsSprint && this.stamina > 2;

    this.gaspCooldown = Math.max(0, this.gaspCooldown - dt);
    if (this.isSprinting) {
      this.stamina = Math.max(0, this.stamina - dt * 20);
      if (this.stamina < 8 && this.gaspCooldown <= 0) {
        this.gaspCooldown = 8;
        this.audio.playUI('player_gasp', 0.45);
      }
    }
    else this.stamina = Math.min(this.maxStamina, this.stamina + dt * (isMoving ? 12 : 18));

    let speed = SPEED.jog;
    if (this.isSprinting) speed = SPEED.sprint;
    else if (this.isCrouching) speed = SPEED.crouch;
    else if (this.isAiming) speed = SPEED.walk;

    if (combatStance) {
      this.turnFacing(this.yaw, dt, 18);
    } else if (isMoving) {
      this.turnFacing(Math.atan2(-moveDir.x, -moveDir.z), dt, 12);
    }

    // Velocity eases toward the target (snappy start, short stop)
    const targetVx = isMoving ? moveDir.x * speed : 0;
    const targetVz = isMoving ? moveDir.z * speed : 0;
    const accel = Math.min(1, dt * (isMoving ? 14 : 18));
    this.body.velocity.x += (targetVx - this.body.velocity.x) * accel;
    this.body.velocity.z += (targetVz - this.body.velocity.z) * accel;

    const holdingGun = !this.equippedWeapon.isMelee;
    const groundSpeed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    if (isMoving) {
      // When strafing/back-pedalling in combat stance, play the walk slower so it reads less "moonwalky"
      const backwards = combatStance && moveDir.dot(this.getForward()) < -0.3;
      if (this.isSprinting || (!this.isCrouching && !this.isAiming && !combatStance)) {
        this.playLocomotion(holdingGun ? 'Run_Gun' : 'Run', groundSpeed / CLIP_SPEED.run);
      } else {
        this.playLocomotion(holdingGun ? 'Walk_Gun' : 'Walk', (groundSpeed / CLIP_SPEED.walk) * (backwards ? 0.8 : 1));
      }
      this.noiseLevel = Math.max(this.noiseLevel, this.isSprinting ? 30 : this.isCrouching ? 4 : 14);

      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = this.isSprinting ? 0.27 : this.isCrouching || this.isAiming ? 0.5 : 0.36;
        const p = this.body.interpolatedPosition;
        this.audio.playFootstep(this.surfaceAt(p.x, p.z), this.isCrouching ? 0.1 : this.isSprinting ? 0.34 : 0.22);
      }
    } else {
      this.stepTimer = 0.05;
      this.playLocomotion(this.isCrouching ? 'Duck' : holdingGun ? 'Idle_Gun' : 'Idle');
    }

    this.body.position.y = BODY_RADIUS;
    this.body.velocity.y = 0;
    const smooth = this.body.interpolatedPosition;
    this.group.position.set(smooth.x, 0.06, smooth.z);
    // Kit models face +Z, so add PI to face along -Z when facing = 0
    this.group.rotation.y = this.facing + Math.PI;

    // Flashlight follows the camera's pitch in body space
    this.flashlightTarget.position.set(0, 0.9 + Math.sin(this.pitch) * 10, 10);
    this.volumetricCone.rotation.x = -this.pitch;

    if (this.pendingMelee >= 0) {
      this.pendingMelee -= dt;
      if (this.pendingMelee < 0) {
        const hit = this.onMelee?.(this.getPosition(), this.getForward(), this.equippedWeapon) ?? false;
        if (!hit) this.audio.playUI('melee_swing', 0.25, 0.8);
      }
    }

    if (!inventoryOpen && this.input.isPointerLocked && this.input.leftMouseDown) {
      this.tryFire(raycastTargets, dt);
    }

    this.updateCamera(dt);
  }

  private finishReload(): void {
    const w = this.equippedWeapon;
    if (!w.ammoType) return;
    const load = Math.min(w.magSize - this.magAmmo[w.id], this.reserveAmmo[w.ammoType]);
    this.magAmmo[w.id] += load;
    this.reserveAmmo[w.ammoType] -= load;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.audio.playUI('reload_mag', 0.6);
  }

  private getMuzzlePosition(aimDir: THREE.Vector3): THREE.Vector3 {
    const pos = new THREE.Vector3();
    if (this.activeWeaponNode) {
      this.activeWeaponNode.getWorldPosition(pos);
      pos.addScaledVector(aimDir, BAKED_WEAPON[this.equippedWeapon.id].muzzle);
    } else {
      pos.copy(this.getPosition()).add(new THREE.Vector3(0, 1.0, 0)).addScaledVector(aimDir, 0.5);
    }
    return pos;
  }

  private tryFire(raycastTargets: THREE.Object3D[], dt: number): void {
    // Turn to face the crosshair before the first shot leaves the barrel
    this.combatFacingTimer = 1.2;
    let diff = this.yaw - this.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (Math.abs(diff) > 0.6) {
      this.turnFacing(this.yaw, dt, 30);
      return;
    }

    if (this.fireCooldown > 0 || this.isReloading) return;
    const w = this.equippedWeapon;

    if (!w.isMelee) {
      if (this.magAmmo[w.id] <= 0) {
        if (w.ammoType && this.reserveAmmo[w.ammoType] > 0) {
          this.startReload();
        } else if (this.dryFireCooldown <= 0) {
          this.dryFireCooldown = 0.35;
          this.audio.playDryFire();
        }
        return;
      }
      this.magAmmo[w.id]--;
    }

    this.fireCooldown = 1 / w.fireRate;
    this.addTrauma(w.trauma);
    this.noiseLevel = Math.max(this.noiseLevel, Math.min(100, w.noiseRadius * 1.4));

    const playerPos = this.getPosition();
    // Gunshots feed the street reverb so they echo off the buildings
    this.audio.playPositional(w.sfxKey, playerPos, w.id === 'sniper' ? 1.0 : 0.85, 0.06, 10, w.isMelee ? 0 : w.id === 'sniper' || w.id === 'shotgun' ? 0.8 : 0.5);
    this.audio.emitNoise(playerPos, w.noiseRadius);

    if (w.isMelee) {
      this.facing = this.yaw;
      this.playAnim('Slash', true, 0.5, 1.5);
      this.audio.playUI('melee_swing', 0.55, 0.9 + Math.random() * 0.15);
      this.pendingMelee = 0.16;
      return;
    }

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const muzzlePos = this.getMuzzlePosition(camDir);
    this.vfx.spawnMuzzleFlash(muzzlePos, camDir, w.id === 'shotgun' || w.id === 'sniper');
    const rightDir = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();
    this.vfx.spawnShellCasing(muzzlePos, rightDir);

    // Ray starts level with the player (not at the camera) so things *behind* us never eat shots.
    const head = playerPos.clone().setY(this.eyeHeight);
    const startT = Math.max(0, head.clone().sub(this.camera.position).dot(camDir) - 0.4);

    const spreadScale = (this.isAiming ? 0.4 : 1.0) * (this.isSprinting ? 1.8 : 1) * (this.isCrouching ? 0.8 : 1);
    for (let p = 0; p < w.pellets; p++) {
      const dir = camDir.clone();
      dir.x += (Math.random() - 0.5) * w.spread * spreadScale;
      dir.y += (Math.random() - 0.5) * w.spread * spreadScale;
      dir.z += (Math.random() - 0.5) * w.spread * spreadScale;
      dir.normalize();

      const origin = this.camera.position.clone().addScaledVector(camDir, startT);
      this.raycaster.set(origin, dir);
      this.raycaster.far = w.range;

      let endPoint = origin.clone().addScaledVector(dir, w.range);
      const validHit = this.raycaster.intersectObjects(raycastTargets, true)[0];
      if (validHit) {
        endPoint = validHit.point;
        const normal = validHit.face?.normal
          ? validHit.face.normal.clone().transformDirection(validHit.object.matrixWorld)
          : dir.clone().negate();
        this.onShotHit?.(validHit.point, normal, validHit.object, w.damage, dir, w);
      }
      if (p < 3) this.vfx.spawnTracer(muzzlePos, endPoint);
    }

    const kick = w.recoil * (this.isAiming ? 0.55 : 1.0);
    this.pitch = Math.min(PITCH_MAX, this.pitch + kick);
    this.recoilPitch += kick;
    this.yaw += (Math.random() - 0.5) * kick * 0.35;
  }

  private updateCamera(dt: number): void {
    const pos = this.getPosition();
    this.eyeHeight = THREE.MathUtils.lerp(this.eyeHeight, this.isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT, Math.min(1, dt * 10));
    this.shoulderBlend = THREE.MathUtils.lerp(this.shoulderBlend, this.shoulderSide, Math.min(1, dt * 8));

    const targetDist = this.isAiming ? 1.9 : this.isSprinting ? 3.9 : 3.4;
    const shoulder = (this.isAiming ? 0.55 : 0.5) * this.shoulderBlend;

    // Look direction from yaw/pitch; camera orbits behind it around a shoulder pivot
    const cp = Math.cos(this.pitch);
    const lookDir = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const pivot = pos
      .clone()
      .add(new THREE.Vector3(0, this.eyeHeight + 0.15, 0))
      .addScaledVector(right, shoulder);
    const boomDir = lookDir.clone().negate();

    let allowed = targetDist;
    if (this.cameraOccluders.length > 0) {
      // Check from the head first (so the shoulder offset itself can't poke through a wall)
      const head = pos.clone().setY(this.eyeHeight + 0.15);
      const toPivot = pivot.clone().sub(head);
      this.camRaycaster.set(head, toPivot.clone().normalize());
      this.camRaycaster.far = toPivot.length() + 0.2;
      if (this.camRaycaster.intersectObjects(this.cameraOccluders, true).length > 0) pivot.copy(head);

      this.camRaycaster.set(pivot, boomDir);
      this.camRaycaster.far = targetDist + 0.3;
      const hit = this.camRaycaster.intersectObjects(this.cameraOccluders, true)[0];
      if (hit) allowed = Math.max(0.5, hit.distance - 0.3);
    }
    const k = allowed < this.camDistance ? 1 : Math.min(1, dt * 5);
    this.camDistance += (Math.min(allowed, targetDist) - this.camDistance) * k;

    const desired = pivot.clone().addScaledVector(boomDir, this.camDistance);
    desired.y = Math.max(0.35, desired.y);

    // The camera sits rigidly on its boom. The pivot follows the (interpolated, already smooth)
    // player position and rotation is 1:1 with the mouse, so no extra position smoothing is needed;
    // only the boom length eases (in when blocked, out when clear).
    this.currentCamPos.copy(desired);

    const shake = this.trauma * this.trauma * 0.12;
    const t = performance.now() * 0.001;
    this.camera.position
      .copy(this.currentCamPos)
      .add(new THREE.Vector3(Math.sin(t * 47) * shake, Math.sin(t * 53 + 1.3) * shake, Math.sin(t * 41 + 2.1) * shake));
    this.camera.lookAt(this.camera.position.clone().add(lookDir));

    const targetFov = this.isAiming ? (this.equippedWeapon.id === 'sniper' ? 32 : 50) : this.isSprinting ? 70 : 65;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 10));
      this.camera.updateProjectionMatrix();
    }
  }
}
