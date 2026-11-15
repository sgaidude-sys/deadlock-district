import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { VFXManager } from '../core/VFXManager';
import { ZombieAIState, ZombieArchetype } from '../types/game';

export interface ZombieInstance {
  id: string;
  archetype: ZombieArchetype;
  state: ZombieAIState;
  group: THREE.Group;
  body: CANNON.Body;
  mixer: THREE.AnimationMixer | null;
  actions: Record<string, THREE.AnimationAction>;
  currentAnim: string;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  attackCooldown: number;
  hitFlashTimer: number;
  staggerTimer: number;
  pinTimer: number;
  groanTimer: number;
  investigateTarget: THREE.Vector3 | null;
  patrolTarget: THREE.Vector3;
  meshes: THREE.Mesh[];
  deathTimer: number;
}

export class ZombieManager {
  public zombies: ZombieInstance[] = [];
  public kills = 0;

  private scene: THREE.Scene;
  private physicsWorld: CANNON.World;
  private assets: AssetManager;
  private audio: AudioManager;
  private vfx: VFXManager;
  private spawnPoints: THREE.Vector3[];

  private spawnTimer = 2.0;
  private idCounter = 0;
  private hitMaterialCache = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  constructor(
    scene: THREE.Scene,
    physicsWorld: CANNON.World,
    assets: AssetManager,
    audio: AudioManager,
    vfx: VFXManager,
    spawnPoints: THREE.Vector3[]
  ) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.audio = audio;
    this.vfx = vfx;
    this.spawnPoints = spawnPoints;

    // Initial zombie population across the district
    for (let i = 0; i < 12; i++) {
      const pt = this.spawnPoints[i % this.spawnPoints.length];
      this.spawnZombie(pt, i % 4 === 0 ? 'sprinter' : 'shambler');
    }
  }

  public getRaycastMeshes(): THREE.Object3D[] {
    return this.zombies.filter((z) => z.state !== 'dead').map((z) => z.group);
  }

  public onSoundEmitted(origin: THREE.Vector3, radius: number): void {
    for (const z of this.zombies) {
      if (z.state === 'dead') continue;
      const dist = z.group.position.distanceTo(origin);
      if (dist <= radius) {
        z.investigateTarget = origin.clone();
        if (z.state === 'patrol') {
          z.state = 'investigate';
        }
      }
    }
  }

  public spawnZombie(pos: THREE.Vector3, archetype: ZombieArchetype): ZombieInstance {
    this.idCounter++;
    const id = `zombie_${this.idCounter}`;

    let modelKey = 'zombie_basic';
    let hp = 85;
    let speed = 2.3;
    let damage = 14;
    let radius = 0.45;
    let scaleMod = 1.0;

    if (archetype === 'sprinter') {
      modelKey = 'zombie_animated';
      hp = 65;
      speed = 5.1;
      damage = 16;
    } else if (archetype === 'brute') {
      modelKey = 'zombie_chubby';
      hp = 240;
      speed = 1.9;
      damage = 28;
      radius = 0.68;
      scaleMod = 1.15;
    } else if (archetype === 'crawler') {
      modelKey = 'zombie_ribcage';
      hp = 55;
      speed = 3.4;
      damage = 12;
      scaleMod = 0.88;
    }

    const group = this.assets.cloneModel(modelKey);
    group.position.set(
      pos.x + (Math.random() - 0.5) * 3,
      0,
      pos.z + (Math.random() - 0.5) * 3
    );
    group.scale.multiplyScalar(scaleMod);
    group.userData.zombieId = id;
    this.scene.add(group);

    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      o.userData.zombieId = id;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        // Clone material so hit-flash only affects this zombie
        if (m.material) {
          m.material = Array.isArray(m.material)
            ? m.material.map((mm) => mm.clone())
            : m.material.clone();
        }
        meshes.push(m);
      }
    });

    const body = new CANNON.Body({
      mass: archetype === 'brute' ? 130 : 65,
      shape: new CANNON.Sphere(radius),
      position: new CANNON.Vec3(group.position.x, radius, group.position.z),
      linearDamping: 0.85,
      fixedRotation: true,
    });
    this.physicsWorld.addBody(body);

    const clips = this.assets.getClips(modelKey);
    let mixer: THREE.AnimationMixer | null = null;
    const actions: Record<string, THREE.AnimationAction> = {};

    if (clips.length > 0) {
      mixer = new THREE.AnimationMixer(group);
      for (const clip of clips) {
        const lower = clip.name.toLowerCase();
        const act = mixer.clipAction(clip);
        if (lower.includes('idle')) actions['idle'] = act;
        else if (lower.includes('run')) actions['run'] = act;
        else if (lower.includes('walk')) actions['walk'] = act;
        else if (lower.includes('attack') || lower.includes('bite') || lower.includes('punch')) {
          actions['attack'] = act;
        } else if (lower.includes('death') || lower.includes('die')) {
          actions['death'] = act;
        }
      }
      // Fallback if FBX has single unnamed clip
      if (Object.keys(actions).length === 0) {
        actions['walk'] = mixer.clipAction(clips[0]);
      }
    }

    const z: ZombieInstance = {
      id,
      archetype,
      state: 'patrol',
      group,
      body,
      mixer,
      actions,
      currentAnim: '',
      hp,
      maxHp: hp,
      speed,
      damage,
      attackCooldown: 0,
      hitFlashTimer: 0,
      staggerTimer: 0,
      pinTimer: 0,
      groanTimer: 2 + Math.random() * 6,
      investigateTarget: null,
      patrolTarget: this.randomPatrolNear(group.position),
      meshes,
      deathTimer: 0,
    };

    this.playZombieAnim(z, 'walk');
    this.zombies.push(z);
    return z;
  }

  private randomPatrolNear(pos: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(
      THREE.MathUtils.clamp(pos.x + (Math.random() - 0.5) * 18, -62, 62),
      0,
      THREE.MathUtils.clamp(pos.z + (Math.random() - 0.5) * 18, -62, 62)
    );
  }

  private playZombieAnim(z: ZombieInstance, name: string, oneShot = false): void {
    if (!z.mixer) return;
    const target =
      z.actions[name] ??
      z.actions['walk'] ??
      z.actions['run'] ??
      z.actions['idle'];
    if (!target) return;
    if (z.currentAnim === name && !oneShot) return;

    const prev = z.actions[z.currentAnim];
    if (prev && prev !== target) {
      prev.fadeOut(0.18);
    }
    target.reset().fadeIn(0.15);
    if (oneShot) {
      target.setLoop(THREE.LoopOnce, 1);
      target.clampWhenFinished = true;
    } else {
      target.setLoop(THREE.LoopRepeat, Infinity);
    }
    target.play();
    z.currentAnim = name;
  }

  public damageZombieByObject(
    obj: THREE.Object3D,
    damage: number,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    impulseDir: THREE.Vector3
  ): boolean {
    const id = obj.userData.zombieId as string | undefined;
    if (!id) return false;
    const z = this.zombies.find((item) => item.id === id);
    if (!z || z.state === 'dead') return false;

    z.hp -= damage;
    z.hitFlashTimer = 0.11;
    z.staggerTimer = 0.18;
    z.state = 'chase';

    // Emissive hit flash
    for (const m of z.meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.emissive.setHex(0xff2a2a);
          mat.emissiveIntensity = 1.8;
        }
      }
    }

    // Knockback
    const knock = z.archetype === 'brute' ? 3.5 : 7.0;
    z.body.velocity.x += impulseDir.x * knock;
    z.body.velocity.z += impulseDir.z * knock;

    // Blood burst VFX
    this.vfx.spawnBloodBurst(hitPoint, hitNormal, 10);

    if (z.hp <= 0) {
      this.killZombie(z);
    }
    return true;
  }

  public pinZombie(z: ZombieInstance, duration: number): void {
    if (z.state === 'dead') return;
    z.pinTimer = duration;
    z.staggerTimer = duration;
  }

  private killZombie(z: ZombieInstance): void {
    z.state = 'dead';
    z.deathTimer = 4.5;
    this.kills++;
    this.physicsWorld.removeBody(z.body);
    this.audio.playPositional('zombie_groan2', z.group.position, 0.7, 0.15);

    if (z.actions['death']) {
      this.playZombieAnim(z, 'death', true);
    } else {
      z.group.rotation.x = -Math.PI / 2;
      z.group.position.y = 0.25;
    }
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    isNight: boolean,
    extractionActive: boolean,
    onPlayerHit: (damage: number) => void
  ): void {
    // Horde Director spawning
    const maxZombies = extractionActive ? 34 : isNight ? 26 : 16;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.zombies.filter((z) => z.state !== 'dead').length < maxZombies) {
      this.spawnTimer = extractionActive ? 2.2 : isNight ? 3.5 : 6.0;
      const pt = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
      if (pt.distanceTo(playerPos) > 16) {
        const roll = Math.random();
        let arch: ZombieArchetype = 'shambler';
        if (isNight || extractionActive) {
          if (roll < 0.42) arch = 'sprinter';
          else if (roll < 0.62) arch = 'brute';
          else if (roll < 0.78) arch = 'crawler';
        } else {
          if (roll < 0.2) arch = 'sprinter';
          else if (roll < 0.3) arch = 'crawler';
          else if (roll < 0.36) arch = 'brute';
        }
        const spawned = this.spawnZombie(pt, arch);
        if (extractionActive) {
          spawned.state = 'chase';
        }
      }
    }

    const visionRange = isNight ? 28 : 19;

    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];
      if (z.mixer) z.mixer.update(dt);

      if (z.state === 'dead') {
        z.deathTimer -= dt;
        if (z.deathTimer <= 0) {
          this.scene.remove(z.group);
          this.zombies.splice(i, 1);
        }
        continue;
      }

      // Hit-flash decay
      if (z.hitFlashTimer > 0) {
        z.hitFlashTimer -= dt;
        if (z.hitFlashTimer <= 0) {
          for (const m of z.meshes) {
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              if (mat instanceof THREE.MeshStandardMaterial) {
                mat.emissive.setHex(0x000000);
                mat.emissiveIntensity = 0;
              }
            }
          }
        }
      }

      z.attackCooldown = Math.max(0, z.attackCooldown - dt);
      z.staggerTimer = Math.max(0, z.staggerTimer - dt);
      z.pinTimer = Math.max(0, z.pinTimer - dt);

      const zPos = new THREE.Vector3(z.body.position.x, 0, z.body.position.z);
      const distToPlayer = zPos.distanceTo(playerPos);

      // Periodic 3D positional zombie groans
      z.groanTimer -= dt;
      if (z.groanTimer <= 0 && distToPlayer < 28) {
        z.groanTimer = 4 + Math.random() * 6;
        const sfx = z.archetype === 'brute' ? 'zombie_roar' : Math.random() < 0.5 ? 'zombie_groan1' : 'zombie_groan2';
        this.audio.playPositional(sfx, zPos, 0.55, 0.14);
      }

      if (z.staggerTimer > 0 || z.pinTimer > 0) {
        z.body.velocity.x *= 0.8;
        z.body.velocity.z *= 0.8;
        z.group.position.set(z.body.position.x, 0, z.body.position.z);
        continue;
      }

      // State transitions
      if (extractionActive || distToPlayer < visionRange) {
        z.state = 'chase';
      } else if (z.state === 'chase' && distToPlayer > visionRange + 12) {
        z.state = 'patrol';
      }

      let targetPos = z.patrolTarget;
      let moveSpeed = z.speed * 0.45;

      if (z.state === 'chase') {
        targetPos = playerPos;
        moveSpeed = z.speed * (isNight ? 1.15 : 1.0);
        if (distToPlayer < 1.75) {
          z.state = 'attack';
        }
      } else if (z.state === 'investigate' && z.investigateTarget) {
        targetPos = z.investigateTarget;
        moveSpeed = z.speed * 0.8;
        if (zPos.distanceTo(z.investigateTarget) < 2.0) {
          z.investigateTarget = null;
          z.state = 'patrol';
        }
      } else if (zPos.distanceTo(z.patrolTarget) < 1.5) {
        z.patrolTarget = this.randomPatrolNear(zPos);
      }

      if (z.state === 'attack') {
        z.body.velocity.x *= 0.6;
        z.body.velocity.z *= 0.6;
        this.playZombieAnim(z, 'attack');
        if (z.attackCooldown <= 0 && distToPlayer < 2.05) {
          z.attackCooldown = 1.1;
          onPlayerHit(z.damage);
        }
        if (distToPlayer >= 2.15) {
          z.state = 'chase';
        }
      } else {
        const dir = targetPos.clone().sub(zPos);
        dir.y = 0;
        if (dir.lengthSq() > 0.01) {
          dir.normalize();
          z.body.velocity.x = dir.x * moveSpeed;
          z.body.velocity.z = dir.z * moveSpeed;
          const angle = Math.atan2(dir.x, dir.z);
          z.group.rotation.y = angle;
        }
        this.playZombieAnim(z, z.state === 'chase' && z.archetype === 'sprinter' ? 'run' : 'walk');
      }

      z.body.position.y = z.body.shapes[0] instanceof CANNON.Sphere ? (z.body.shapes[0] as CANNON.Sphere).radius : 0.45;
      z.body.velocity.y = 0;
      z.group.position.set(z.body.position.x, 0, z.body.position.z);
    }
  }
}
