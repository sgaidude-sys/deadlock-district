import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
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

/** Baked weapon node inside the Zombie Apocalypse Kit rig, and muzzle offset along the aim. */
const BAKED_WEAPON: Record<WeaponId, { node: string; muzzle: number; scale: number }> = {
  axe: { node: 'Axe', muzzle: 0, scale: 1 },
  pistol: { node: 'Pistol', muzzle: 0.32, scale: 1 },
  shotgun: { node: 'Shotgun', muzzle: 0.75, scale: 1 },
  smg: { node: 'SMG', muzzle: 0.5, scale: 1 },
  rifle: { node: 'Rifle', muzzle: 0.75, scale: 1 },
  sniper: { node: 'Rifle', muzzle: 0.85, scale: 1.12 },
};
const ALL_BAKED = ['Axe', 'Guitar', 'Knife', 'Pistol', 'Rifle', 'Shotgun', 'SMG', 'Spear', 'WoodenBat_Barbed', 'WoodenBat_Saw'];

const STAND_HEIGHT = 1.68;
const CROUCH_HEIGHT = 1.25;

export class PlayerController {
  public group = new THREE.Group();
  public body: CANNON.Body;

  public yaw = 0;
  public pitch = -0.12;
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
  private raycaster = new THREE.Raycaster();
  private camRaycaster = new THREE.Raycaster();
  private onShotHit?: ShotHitCallback;
  private onMelee?: MeleeCallback;
  private cameraOccluders: THREE.Object3D[] = [];

  // Camera smoothing
  private currentCamPos = new THREE.Vector3();
  private currentLookAt = new THREE.Vector3();
  private camDistance = 4.2;
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

    this.body = new CANNON.Body({
      mass: 75,
      shape: new CANNON.Sphere(0.45),
      position: new CANNON.Vec3(spawnPos.x, 0.45, spawnPos.z),
      linearDamping: 0.9,
      fixedRotation: true,
    });
    physicsWorld.addBody(this.body);

    const modelKey = `survivor_${survivorId}`;
    this.modelGroup = this.assets.cloneModel(modelKey);

    // The kit rig carries every weapon on the hand bone; we show only the equipped one so it
    // follows the hand through every animation.
    this.modelGroup.traverse((child) => {
      if (ALL_BAKED.includes(child.name)) {
        child.visible = false;
        if (!this.bakedWeapons.has(child.name)) this.bakedWeapons.set(child.name, child);
      }
    });

    this.group.add(this.modelGroup);
    this.scene.add(this.group);

    const clips = this.assets.getClips(modelKey);
    if (clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.modelGroup);
      for (const clip of clips) {
        this.actions[clip.name] = this.mixer.clipAction(clip);
      }
      this.mixer.addEventListener('finished', () => {
        this.animLockTimer = 0;
      });
      this.playAnim('Idle_Gun');
    }

    // Flashlight + volumetric cone
    this.flashlight = new THREE.SpotLight(0xfff5db, 7, 40, Math.PI / 6, 0.5, 1.3);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.bias = -0.002;
    this.flashlight.position.set(-0.22, 1.4, 0.35);
    this.group.add(this.flashlight);
    this.group.add(this.flashlightTarget);
    this.flashlightTarget.position.set(0, 1.2, 10);
    this.flashlight.target = this.flashlightTarget;

    this.volumetricCone = this.vfx.createFlashlightConeMesh();
    this.volumetricCone.position.copy(this.flashlight.position);
    this.group.add(this.volumetricCone);

    this.equipWeapon('pistol', true);
    this.currentCamPos.copy(spawnPos).add(new THREE.Vector3(0.72, 2.0, 4.2));
    this.currentLookAt.copy(spawnPos).add(new THREE.Vector3(0.36, 1.5, -6));
  }

  public setOnShotHit(cb: ShotHitCallback): void {
    this.onShotHit = cb;
  }

  public setOnMelee(cb: MeleeCallback): void {
    this.onMelee = cb;
  }

  public setCameraOccluders(list: THREE.Object3D[]): void {
    this.cameraOccluders = list;
  }

  public getPosition(): THREE.Vector3 {
    return new THREE.Vector3(this.body.position.x, 0, this.body.position.z);
  }

  public getForward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  public toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.visible = this.flashlightOn;
    this.volumetricCone.visible = this.flashlightOn;
    this.audio.playUI('ui_click', 0.35, 1.4);
  }

  public toggleCrouch(): void {
    this.isCrouching = !this.isCrouching;
  }

  public unlockWeapon(id: WeaponId): void {
    if (!this.unlockedWeapons.includes(id)) {
      this.unlockedWeapons.push(id);
    }
  }

  public cycleWeapon(dir: number): void {
    const order: WeaponId[] = ['axe', 'pistol', 'shotgun', 'smg', 'rifle', 'sniper'];
    const owned = order.filter((w) => this.unlockedWeapons.includes(w));
    const idx = owned.indexOf(this.equippedWeapon.id);
    const next = owned[(idx + dir + owned.length) % owned.length];
    this.equipWeapon(next);
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
    if (!silent) this.audio.playUI('reload', 0.22, 1.6);
  }

  public startReload(): void {
    const w = this.equippedWeapon;
    if (w.isMelee || this.isReloading || !w.ammoType) return;
    const currentMag = this.magAmmo[w.id];
    const reserve = this.reserveAmmo[w.ammoType];
    if (currentMag >= w.magSize || reserve <= 0) return;

    this.isReloading = true;
    this.reloadTimer = w.reloadTime;
    this.audio.playUI('reload', 0.6);
  }

  public takeDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
    this.trauma = Math.min(1, this.trauma + 0.45);
    this.audio.playHurt();
    if (this.animLockTimer <= 0) this.playAnim('HitReact', true, 0.35);
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
    if (prev && prev !== target) {
      prev.fadeOut(0.16);
    }
    target.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(0.12);
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

  /** Locomotion anims never interrupt a running one-shot (swing / hit react). */
  private playLocomotion(name: string, timeScale = 1): void {
    if (this.animLockTimer > 0) return;
    this.playAnim(name);
    const a = this.actions[name];
    if (a) a.setEffectiveTimeScale(timeScale);
  }

  public update(dt: number, raycastTargets: THREE.Object3D[], inventoryOpen: boolean): void {
    if (this.mixer) this.mixer.update(dt);
    this.animLockTimer = Math.max(0, this.animLockTimer - dt);

    // Hunger & Thirst slow drain
    this.hunger = Math.max(0, this.hunger - dt * 0.2);
    this.thirst = Math.max(0, this.thirst - dt * 0.27);
    if (this.hunger <= 0 || this.thirst <= 0) {
      this.health = Math.max(0, this.health - dt * 1.5);
    }

    this.noiseLevel = Math.max(0, this.noiseLevel - dt * 45);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.dryFireCooldown = Math.max(0, this.dryFireCooldown - dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.8);

    if (this.isReloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }

    // Recoil recovers back toward where the player was aiming
    if (this.recoilPitch > 0) {
      const rec = Math.min(this.recoilPitch, dt * 0.9);
      this.recoilPitch -= rec;
      this.pitch -= rec * 0.6;
    }

    // Mouse look + arrow-key fallback
    if (!inventoryOpen && this.input.isPointerLocked) {
      const { dx, dy } = this.input.consumeMouseDelta();
      const adsScale = this.isAiming ? 0.6 : 1;
      this.yaw -= dx * adsScale;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * adsScale, -0.75, 0.65);
    } else {
      this.input.consumeMouseDelta();
    }

    if (!inventoryOpen) {
      const keyLookSpeed = 2.2 * dt;
      if (this.input.isDown('ArrowLeft')) this.yaw += keyLookSpeed;
      if (this.input.isDown('ArrowRight')) this.yaw -= keyLookSpeed;
      if (this.input.isDown('ArrowUp')) this.pitch = Math.min(0.65, this.pitch + keyLookSpeed * 0.7);
      if (this.input.isDown('ArrowDown')) this.pitch = Math.max(-0.75, this.pitch - keyLookSpeed * 0.7);
    }

    this.isAiming = !inventoryOpen && this.input.rightMouseDown && !this.equippedWeapon.isMelee;

    // Movement
    const forward = this.getForward();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const moveDir = new THREE.Vector3();
    if (!inventoryOpen) {
      if (this.input.isDown('KeyW')) moveDir.add(forward);
      if (this.input.isDown('KeyS')) moveDir.sub(forward);
      if (this.input.isDown('KeyD')) moveDir.add(right);
      if (this.input.isDown('KeyA')) moveDir.sub(right);
    }

    const isMoving = moveDir.lengthSq() > 0.001;
    const sprintHeld = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
    const movingForward = isMoving && moveDir.dot(forward) > 0.2;
    const wantsSprint = sprintHeld && !this.isAiming && movingForward;
    if (wantsSprint && this.isCrouching) this.isCrouching = false;
    this.isSprinting = wantsSprint && this.stamina > 2;

    if (this.isSprinting) {
      this.stamina = Math.max(0, this.stamina - dt * 20);
    } else {
      this.stamina = Math.min(this.maxStamina, this.stamina + dt * (isMoving ? 12 : 18));
    }

    let speed = 5.2;
    if (this.isSprinting) speed = 8.2;
    else if (this.isCrouching) speed = 2.8;
    else if (this.isAiming) speed = 3.4;

    const holdingGun = !this.equippedWeapon.isMelee;
    if (isMoving) {
      moveDir.normalize();
      // Smooth acceleration feels less "on rails"
      const k = Math.min(1, dt * 14);
      this.body.velocity.x += (moveDir.x * speed - this.body.velocity.x) * k;
      this.body.velocity.z += (moveDir.z * speed - this.body.velocity.z) * k;

      if (this.isSprinting) {
        this.playLocomotion(holdingGun ? 'Run_Gun' : 'Run', 1.05);
        this.noiseLevel = Math.max(this.noiseLevel, 30);
      } else {
        this.playLocomotion(holdingGun ? 'Walk_Gun' : 'Walk', this.isCrouching ? 0.6 : speed / 5.2);
        this.noiseLevel = Math.max(this.noiseLevel, this.isCrouching ? 4 : 14);
      }

      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = this.isSprinting ? 0.29 : this.isCrouching ? 0.6 : 0.42;
        this.audio.playUI(
          Math.random() < 0.5 ? 'step_concrete1' : 'step_concrete2',
          this.isCrouching ? 0.1 : this.isSprinting ? 0.32 : 0.22,
          0.9 + Math.random() * 0.2
        );
      }
    } else {
      this.body.velocity.x *= 0.7;
      this.body.velocity.z *= 0.7;
      this.stepTimer = 0.05;
      this.playLocomotion(this.isCrouching ? 'Duck' : holdingGun ? 'Idle_Gun' : 'Idle');
    }

    // Keep player grounded
    this.body.position.y = 0.45;
    this.body.velocity.y = 0;

    this.group.position.set(this.body.position.x, 0.03, this.body.position.z);
    this.group.rotation.y = this.yaw + Math.PI;

    // Flashlight follows aim pitch
    const aimOffset = Math.sin(this.pitch) * 10;
    this.flashlightTarget.position.set(0, 1.25 + aimOffset, 10);
    this.volumetricCone.rotation.x = -this.pitch;

    // Delayed melee impact lines up with the swing animation
    if (this.pendingMelee >= 0) {
      this.pendingMelee -= dt;
      if (this.pendingMelee < 0) {
        const hit = this.onMelee?.(this.getPosition(), this.getForward(), this.equippedWeapon) ?? false;
        if (!hit) this.audio.playUI('melee_swing', 0.25, 0.8);
      }
    }

    if (!inventoryOpen && this.input.isPointerLocked && this.input.leftMouseDown) {
      this.tryFire(raycastTargets);
    }

    this.updateCamera(dt);
  }

  private finishReload(): void {
    const w = this.equippedWeapon;
    if (!w.ammoType) return;
    const needed = w.magSize - this.magAmmo[w.id];
    const available = this.reserveAmmo[w.ammoType];
    const load = Math.min(needed, available);
    this.magAmmo[w.id] += load;
    this.reserveAmmo[w.ammoType] -= load;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.audio.playUI('ui_back', 0.5, 0.8);
  }

  private getMuzzlePosition(aimDir: THREE.Vector3): THREE.Vector3 {
    const pos = new THREE.Vector3();
    if (this.activeWeaponNode) {
      this.activeWeaponNode.getWorldPosition(pos);
      pos.addScaledVector(aimDir, BAKED_WEAPON[this.equippedWeapon.id].muzzle);
    } else {
      pos.copy(this.getPosition()).add(new THREE.Vector3(0, 1.3, 0)).addScaledVector(aimDir, 0.6);
    }
    return pos;
  }

  private tryFire(raycastTargets: THREE.Object3D[]): void {
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
    this.audio.playPositional(w.sfxKey, playerPos, w.id === 'sniper' ? 1.0 : 0.85, 0.07, 10);
    if (w.id === 'sniper') this.audio.playPositional('explosion', playerPos, 0.18, 0.05, 12);
    this.audio.emitNoise(playerPos, w.noiseRadius);

    if (w.isMelee) {
      this.playAnim('Slash', true, 0.5, 1.5);
      this.audio.playUI('melee_swing', 0.5, 0.95 + Math.random() * 0.1);
      this.pendingMelee = 0.16;
      return;
    }

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const muzzlePos = this.getMuzzlePosition(camDir);
    this.vfx.spawnMuzzleFlash(muzzlePos, camDir, w.id === 'shotgun' || w.id === 'sniper');
    const rightDir = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();
    this.vfx.spawnShellCasing(muzzlePos, rightDir);

    // Ray starts level with the player (not at the camera) so walls *behind* us never eat shots.
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

      const hits = this.raycaster.intersectObjects(raycastTargets, true);
      let endPoint = origin.clone().addScaledVector(dir, w.range);

      const validHit = hits.find((h) => h.object.visible && !this.isDescendantOf(h.object, this.group));
      if (validHit) {
        endPoint = validHit.point;
        const normal = validHit.face?.normal
          ? validHit.face.normal.clone().transformDirection(validHit.object.matrixWorld)
          : dir.clone().negate();
        this.onShotHit?.(validHit.point, normal, validHit.object, w.damage, dir, w);
      }
      if (p < 3) this.vfx.spawnTracer(muzzlePos, endPoint);
    }

    // Vertical kick (partially recovers) + a little horizontal wander
    const kick = w.recoil * (this.isAiming ? 0.55 : 1.0);
    this.pitch = Math.min(0.65, this.pitch + kick);
    this.recoilPitch += kick;
    this.yaw += (Math.random() - 0.5) * kick * 0.35;
  }

  private isDescendantOf(obj: THREE.Object3D, parent: THREE.Object3D): boolean {
    let curr: THREE.Object3D | null = obj;
    while (curr) {
      if (curr === parent) return true;
      curr = curr.parent;
    }
    return false;
  }

  private updateCamera(dt: number): void {
    const pos = this.getPosition();
    const targetDist = this.isAiming ? 2.3 : this.isSprinting ? 4.6 : 4.2;
    const shoulderOffset = this.isAiming ? 0.8 : 0.7;
    this.eyeHeight = THREE.MathUtils.lerp(this.eyeHeight, this.isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT, Math.min(1, dt * 10));

    const forward = this.getForward();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // Pivot over the shoulder, then pull the boom back (shortened if a wall is in the way)
    const pivot = pos.clone().add(new THREE.Vector3(0, this.eyeHeight, 0)).addScaledVector(right, shoulderOffset * 0.6);
    const boomDir = new THREE.Vector3()
      .addScaledVector(forward, -Math.cos(this.pitch))
      .add(new THREE.Vector3(0, -Math.sin(this.pitch) * 0.33, 0))
      .addScaledVector(right, (shoulderOffset * 0.4) / targetDist)
      .normalize();

    let allowed = targetDist;
    if (this.cameraOccluders.length > 0) {
      this.camRaycaster.set(pivot, boomDir);
      this.camRaycaster.far = targetDist + 0.3;
      const hit = this.camRaycaster.intersectObjects(this.cameraOccluders, true)[0];
      if (hit) allowed = Math.max(0.6, hit.distance - 0.3);
    }
    // Snap in quickly when blocked, ease back out when clear
    const k = allowed < this.camDistance ? 1 : Math.min(1, dt * 4);
    this.camDistance += (Math.min(allowed, targetDist) - this.camDistance) * k;

    const desiredCamPos = pivot.clone().addScaledVector(boomDir, this.camDistance);
    desiredCamPos.y = Math.max(0.5, desiredCamPos.y);

    const desiredLookAt = pos
      .clone()
      .add(new THREE.Vector3(0, this.eyeHeight + Math.sin(this.pitch) * 4.5, 0))
      .addScaledVector(forward, 10)
      .addScaledVector(right, shoulderOffset * 0.5);

    this.currentCamPos.lerp(desiredCamPos, Math.min(1, dt * 18));
    // Never let smoothing drag the camera through the wall we just collided with
    if (this.currentCamPos.distanceTo(pivot) > this.camDistance + 0.05) {
      this.currentCamPos.copy(pivot).add(this.currentCamPos.clone().sub(pivot).setLength(this.camDistance));
    }
    this.currentLookAt.lerp(desiredLookAt, Math.min(1, dt * 20));

    const shake = this.trauma * this.trauma * 0.14;
    const t = performance.now() * 0.001;
    const shakeVec = new THREE.Vector3(
      Math.sin(t * 47) * shake,
      Math.sin(t * 53 + 1.3) * shake,
      Math.sin(t * 41 + 2.1) * shake
    );

    this.camera.position.copy(this.currentCamPos).add(shakeVec);
    this.camera.lookAt(this.currentLookAt);

    const targetFov = this.isAiming ? (this.equippedWeapon.id === 'sniper' ? 32 : 50) : this.isSprinting ? 70 : 65;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 10));
      this.camera.updateProjectionMatrix();
    }
  }
}
