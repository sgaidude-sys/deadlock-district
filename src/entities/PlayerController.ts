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

export class PlayerController {
  public group = new THREE.Group();
  public body: CANNON.Body;

  public yaw = 0;
  public pitch = -0.18;
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

  private weaponSocket = new THREE.Group();
  private weaponMesh: THREE.Group | null = null;
  private flashlight: THREE.SpotLight;
  private flashlightTarget = new THREE.Object3D();
  private volumetricCone: THREE.Mesh;

  private fireCooldown = 0;
  private stepTimer = 0;
  private raycaster = new THREE.Raycaster();
  private onShotHit?: ShotHitCallback;

  // Camera smoothing
  private currentCamPos = new THREE.Vector3();
  private currentLookAt = new THREE.Vector3();

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

    // Physics body (sphere at feet/center)
    this.body = new CANNON.Body({
      mass: 75,
      shape: new CANNON.Sphere(0.55),
      position: new CANNON.Vec3(spawnPos.x, 0.6, spawnPos.z),
      linearDamping: 0.9,
      fixedRotation: true,
    });
    physicsWorld.addBody(this.body);

    // Load survivor model
    const modelKey = `survivor_${survivorId}`;
    this.modelGroup = this.assets.cloneModel(modelKey);

    // Hide all baked-in weapons from Zombie Apocalypse Kit character rig
    const bakedWeaponNames = new Set([
      'Axe',
      'Guitar',
      'Knife',
      'Pistol',
      'Rifle',
      'Shotgun',
      'SMG',
      'Spear',
      'WoodenBat_Barbed',
      'WoodenBat_Saw',
    ]);
    this.modelGroup.traverse((child) => {
      if (bakedWeaponNames.has(child.name)) {
        child.visible = false;
      }
    });

    this.group.add(this.modelGroup);
    this.scene.add(this.group);

    // Weapon socket on right hand side
    this.weaponSocket.position.set(-0.34, 1.18, 0.42);
    this.group.add(this.weaponSocket);

    // Setup animations (exact clip name matching so Jump_Idle doesn't overwrite Idle)
    const clips = this.assets.getClips(modelKey);
    if (clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.modelGroup);
      for (const clip of clips) {
        const action = this.mixer.clipAction(clip);
        this.actions[clip.name] = action;
      }
      this.playAnim('Idle_Gun');
    }

    // Flashlight + volumetric cone
    this.flashlight = new THREE.SpotLight(0xfff5db, 5.5, 38, Math.PI / 5.5, 0.48, 1.4);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.position.set(-0.22, 1.35, 0.35);
    this.group.add(this.flashlight);
    this.group.add(this.flashlightTarget);
    this.flashlightTarget.position.set(0, 1.2, 10);
    this.flashlight.target = this.flashlightTarget;

    this.volumetricCone = this.vfx.createFlashlightConeMesh();
    this.volumetricCone.position.copy(this.flashlight.position);
    this.group.add(this.volumetricCone);

    this.equipWeapon('pistol');
    this.currentCamPos.copy(spawnPos).add(new THREE.Vector3(0.72, 2.0, 4.2));
    this.currentLookAt.copy(spawnPos).add(new THREE.Vector3(0.36, 1.5, -6));
  }

  public setOnShotHit(cb: ShotHitCallback): void {
    this.onShotHit = cb;
  }

  public getPosition(): THREE.Vector3 {
    return new THREE.Vector3(this.body.position.x, 0, this.body.position.z);
  }

  public toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.visible = this.flashlightOn;
    this.volumetricCone.visible = this.flashlightOn;
    this.audio.playUI('ui_click', 0.35);
  }

  public toggleCrouch(): void {
    this.isCrouching = !this.isCrouching;
  }

  public unlockWeapon(id: WeaponId): void {
    if (!this.unlockedWeapons.includes(id)) {
      this.unlockedWeapons.push(id);
    }
  }

  public equipWeapon(id: WeaponId): void {
    if (!this.unlockedWeapons.includes(id)) return;
    if (this.isReloading) {
      this.isReloading = false;
      this.reloadTimer = 0;
    }
    this.equippedWeapon = WEAPONS[id];

    if (this.weaponMesh) {
      this.weaponSocket.remove(this.weaponMesh);
    }
    this.weaponMesh = this.assets.cloneModel(this.equippedWeapon.modelKey);
    this.weaponMesh.scale.setScalar(1.1);
    this.weaponMesh.rotation.y = Math.PI;
    this.weaponSocket.add(this.weaponMesh);
    this.audio.playUI('ui_click', 0.25);
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
    this.playAnim('HitReact', true);
  }

  public addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  private playAnim(name: string, oneShot = false): void {
    if (!this.mixer) return;
    const target = this.actions[name] ?? this.actions['Idle_Gun'] ?? this.actions['Idle'] ?? this.actions['Walk'];
    if (!target) return;
    if (this.currentAnim === name && !oneShot) return;

    const prev = this.actions[this.currentAnim];
    if (prev && prev !== target) {
      prev.fadeOut(0.16);
    }
    target.reset().fadeIn(0.14);
    if (oneShot) {
      target.setLoop(THREE.LoopOnce, 1);
      target.clampWhenFinished = false;
    } else {
      target.setLoop(THREE.LoopRepeat, Infinity);
    }
    target.play();
    this.currentAnim = name;
  }

  public update(
    dt: number,
    raycastTargets: THREE.Object3D[],
    inventoryOpen: boolean
  ): void {
    if (this.mixer) {
      this.mixer.update(dt);
    }

    // Hunger & Thirst slow drain
    this.hunger = Math.max(0, this.hunger - dt * 0.22);
    this.thirst = Math.max(0, this.thirst - dt * 0.30);
    if (this.hunger <= 0 || this.thirst <= 0) {
      this.health = Math.max(0, this.health - dt * 1.5);
    }

    // Noise decay
    this.noiseLevel = Math.max(0, this.noiseLevel - dt * 45);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.8);

    // Reloading timer
    if (this.isReloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.finishReload();
      }
    }

    // Mouse look + Arrow key fallback
    if (!inventoryOpen && this.input.isPointerLocked) {
      const { dx, dy } = this.input.consumeMouseDelta();
      this.yaw -= dx;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -0.75, 0.65);
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

    this.isAiming = !inventoryOpen && this.input.rightMouseDown;

    // Movement
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const moveDir = new THREE.Vector3();

    if (!inventoryOpen) {
      if (this.input.isDown('KeyW')) moveDir.add(forward);
      if (this.input.isDown('KeyS')) moveDir.sub(forward);
      if (this.input.isDown('KeyD')) moveDir.add(right);
      if (this.input.isDown('KeyA')) moveDir.sub(right);
    }

    const isMoving = moveDir.lengthSq() > 0.001;
    const wantsSprint = this.input.isDown('ShiftLeft') && !this.isAiming && !this.isCrouching && isMoving;
    const isSprinting = wantsSprint && this.stamina > 2;

    if (isSprinting) {
      this.stamina = Math.max(0, this.stamina - dt * 22);
    } else {
      this.stamina = Math.min(this.maxStamina, this.stamina + dt * 14);
    }

    let speed = 5.4;
    if (isSprinting) speed = 8.4;
    else if (this.isCrouching) speed = 3.1;
    else if (this.isAiming) speed = 3.8;

    const holdingGun = !this.equippedWeapon.isMelee;
    if (isMoving) {
      moveDir.normalize();
      this.body.velocity.x = moveDir.x * speed;
      this.body.velocity.z = moveDir.z * speed;

      if (isSprinting) {
        this.playAnim(holdingGun ? 'Run_Gun' : 'Run');
        this.noiseLevel = Math.max(this.noiseLevel, 30);
      } else {
        this.playAnim(holdingGun ? 'Walk_Gun' : 'Walk');
        this.noiseLevel = Math.max(this.noiseLevel, this.isCrouching ? 5 : 14);
      }

      // Footstep SFX
      this.stepTimer -= dt * (isSprinting ? 1.5 : 1.0);
      if (this.stepTimer <= 0) {
        this.stepTimer = 0.38;
        this.audio.playUI(Math.random() < 0.5 ? 'step_concrete1' : 'step_concrete2', this.isCrouching ? 0.12 : 0.25);
      }
    } else {
      this.body.velocity.x *= 0.72;
      this.body.velocity.z *= 0.72;
      this.playAnim(this.isCrouching ? 'Duck' : holdingGun ? 'Idle_Gun' : 'Idle');
    }

    // Keep player grounded
    this.body.position.y = 0.6;
    this.body.velocity.y = 0;

    // Sync group transform
    this.group.position.set(this.body.position.x, 0, this.body.position.z);
    // Survivor model faces +Z in Zombie Apocalypse Kit, so rotate yaw + PI
    this.group.rotation.y = this.yaw + Math.PI;

    // Aiming pitch for flashlight
    const aimOffset = Math.sin(this.pitch) * 10;
    this.flashlightTarget.position.set(0, 1.25 + aimOffset, 10);
    this.volumetricCone.rotation.x = -this.pitch;

    // Shooting
    if (!inventoryOpen && this.input.isPointerLocked && this.input.leftMouseDown) {
      this.tryFire(raycastTargets);
    }

    // Update over-the-shoulder camera
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
  }

  private tryFire(raycastTargets: THREE.Object3D[]): void {
    if (this.fireCooldown > 0 || this.isReloading) return;
    const w = this.equippedWeapon;

    if (!w.isMelee) {
      if (this.magAmmo[w.id] <= 0) {
        this.startReload();
        return;
      }
      this.magAmmo[w.id]--;
    }

    this.fireCooldown = 1 / w.fireRate;
    if (w.isMelee) {
      this.playAnim('Slash', true);
    }
    this.addTrauma(w.trauma);
    this.noiseLevel = Math.max(this.noiseLevel, Math.min(100, w.noiseRadius * 1.4));

    const playerPos = this.getPosition();
    this.audio.playPositional(w.sfxKey, playerPos, 0.85, 0.08);
    this.audio.emitNoise(playerPos, w.noiseRadius);

    // Muzzle world position
    const muzzlePos = new THREE.Vector3();
    this.weaponSocket.getWorldPosition(muzzlePos);

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);

    if (!w.isMelee) {
      this.vfx.spawnMuzzleFlash(muzzlePos, camDir);
      const rightDir = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();
      this.vfx.spawnShellCasing(muzzlePos, rightDir);
    }

    // Raycast from camera center (with spread)
    const spreadScale = this.isAiming ? 0.45 : 1.0;
    for (let p = 0; p < w.pellets; p++) {
      const dir = camDir.clone();
      dir.x += (Math.random() - 0.5) * w.spread * spreadScale;
      dir.y += (Math.random() - 0.5) * w.spread * spreadScale;
      dir.z += (Math.random() - 0.5) * w.spread * spreadScale;
      dir.normalize();

      this.raycaster.set(this.camera.position, dir);
      this.raycaster.far = w.range + 5;

      const hits = this.raycaster.intersectObjects(raycastTargets, true);
      let endPoint = this.camera.position.clone().addScaledVector(dir, w.range);

      // Ignore player's own mesh
      const validHit = hits.find((h) => !this.isDescendantOf(h.object, this.group));
      if (validHit) {
        endPoint = validHit.point;
        const normal = validHit.face?.normal
          ? validHit.face.normal.clone().transformDirection(validHit.object.matrixWorld)
          : dir.clone().negate();

        if (this.onShotHit) {
          this.onShotHit(validHit.point, normal, validHit.object, w.damage, dir, w);
        }
      }

      if (!w.isMelee) {
        this.vfx.spawnTracer(muzzlePos, endPoint);
      }
    }

    // Apply subtle vertical recoil
    this.pitch = Math.min(0.65, this.pitch + w.recoil * (this.isAiming ? 0.5 : 1.0));
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
    const targetDist = this.isAiming ? 2.4 : 4.2;
    const shoulderOffset = this.isAiming ? 0.85 : 0.72;
    const heightOffset = this.isCrouching ? 1.25 : 1.68;

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const desiredCamPos = pos
      .clone()
      .add(new THREE.Vector3(0, heightOffset - Math.sin(this.pitch) * 1.4, 0))
      .addScaledVector(forward, -targetDist * Math.cos(this.pitch))
      .addScaledVector(right, shoulderOffset);

    desiredCamPos.y = Math.max(0.6, desiredCamPos.y);

    const desiredLookAt = pos
      .clone()
      .add(new THREE.Vector3(0, heightOffset + Math.sin(this.pitch) * 4.5, 0))
      .addScaledVector(forward, 10)
      .addScaledVector(right, shoulderOffset * 0.5);

    this.currentCamPos.lerp(desiredCamPos, Math.min(1, dt * 15));
    this.currentLookAt.lerp(desiredLookAt, Math.min(1, dt * 18));

    // Trauma shake
    const shake = this.trauma * this.trauma * 0.16;
    const shakeVec = new THREE.Vector3(
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake
    );

    this.camera.position.copy(this.currentCamPos).add(shakeVec);
    this.camera.lookAt(this.currentLookAt);

    // Smooth FOV zoom on ADS
    const targetFov = this.isAiming ? 50 : 65;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 12));
      this.camera.updateProjectionMatrix();
    }
  }
}
