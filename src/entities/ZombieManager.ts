import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { VFXManager } from '../core/VFXManager';
import { ZombieAIState, ZombieArchetype } from '../types/game';
import { BarricadeInstance } from '../world/CityGenerator';

export interface ZombieInstance {
  id: string;
  archetype: ZombieArchetype;
  state: ZombieAIState;
  group: THREE.Group;
  body: CANNON.Body;
  radius: number;
  height: number;
  mixer: THREE.AnimationMixer | null;
  actions: Record<string, THREE.AnimationAction>;
  currentAnim: string;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  attackCooldown: number;
  attackWindup: number;
  hitFlashTimer: number;
  staggerTimer: number;
  pinTimer: number;
  groanTimer: number;
  investigateTarget: THREE.Vector3 | null;
  patrolTarget: THREE.Vector3;
  lastKnownPlayer: THREE.Vector3 | null;
  sightTimer: number;
  canSeePlayer: boolean;
  stuckTimer: number;
  avoidTimer: number;
  avoidDir: THREE.Vector3;
  lastPos: THREE.Vector3;
  meshes: THREE.Mesh[];
  deathTimer: number;
  deathFall: number;
  facing: number;
}

export interface ZombieHitResult {
  killed: boolean;
  headshot: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);

export class ZombieManager {
  public zombies: ZombieInstance[] = [];
  public kills = 0;
  public headshots = 0;

  private scene: THREE.Scene;
  private physicsWorld: CANNON.World;
  private assets: AssetManager;
  private audio: AudioManager;
  private vfx: VFXManager;
  private spawnPoints: THREE.Vector3[];
  private sightBlockers: THREE.Object3D[];
  private barricades: BarricadeInstance[] = [];
  private onBarricadeBroken?: (b: BarricadeInstance) => void;

  private spawnTimer = 2.0;
  private idCounter = 0;
  private sightRay = new THREE.Raycaster();

  constructor(
    scene: THREE.Scene,
    physicsWorld: CANNON.World,
    assets: AssetManager,
    audio: AudioManager,
    vfx: VFXManager,
    spawnPoints: THREE.Vector3[],
    sightBlockers: THREE.Object3D[],
    playerSpawn: THREE.Vector3
  ) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.audio = audio;
    this.vfx = vfx;
    this.spawnPoints = spawnPoints;
    this.sightBlockers = sightBlockers;

    // Initial population, kept away from the player's spawn
    const far = this.spawnPoints.filter((p) => p.distanceTo(playerSpawn) > 25);
    for (let i = 0; i < 12; i++) {
      const pt = far[i % far.length];
      this.spawnZombie(pt, i % 4 === 0 ? 'sprinter' : i % 7 === 3 ? 'crawler' : 'shambler');
    }
  }

  public setBarricades(list: BarricadeInstance[], onBroken: (b: BarricadeInstance) => void): void {
    this.barricades = list;
    this.onBarricadeBroken = onBroken;
  }

  public getRaycastMeshes(): THREE.Object3D[] {
    return this.zombies.filter((z) => z.state !== 'dead').map((z) => z.group);
  }

  public aliveCount(): number {
    let n = 0;
    for (const z of this.zombies) if (z.state !== 'dead') n++;
    return n;
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

    const modelKey = 'zombie_animated';
    let hp = 85;
    let speed = 2.1;
    let damage = 12;
    let radius = 0.42;
    let scaleMod = 1.0;
    let tintHex = 0xd5ded2;

    if (archetype === 'sprinter') {
      hp = 60;
      speed = 5.0;
      damage = 14;
      scaleMod = 0.96;
      tintHex = 0xffb4a8;
    } else if (archetype === 'brute') {
      hp = 260;
      speed = 1.8;
      damage = 26;
      radius = 0.62;
      scaleMod = 1.38;
      tintHex = 0x9c6a6a;
    } else if (archetype === 'crawler') {
      hp = 50;
      speed = 2.6;
      damage = 10;
      scaleMod = 0.92;
      tintHex = 0x9aa8b8;
    }

    const group = this.assets.cloneModel(modelKey);
    group.position.set(pos.x + (Math.random() - 0.5) * 3, 0, pos.z + (Math.random() - 0.5) * 3);
    group.scale.multiplyScalar(scaleMod * (0.94 + Math.random() * 0.12));
    group.rotation.order = 'YXZ';
    group.userData.zombieId = id;
    this.scene.add(group);

    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      o.userData.zombieId = id;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        // Clone material so hit-flash and archetype tint only affect this zombie
        m.material = Array.isArray(m.material) ? m.material.map((mm) => mm.clone()) : m.material.clone();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) mat.color.setHex(tintHex);
        }
        m.frustumCulled = false; // skinned bounds don't follow animation
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
        if (lower.includes('crawl')) actions['crawl'] = act;
        else if (lower.includes('idle')) actions['idle'] = act;
        else if (lower.includes('run')) actions['run'] = act;
        else if (lower.includes('walk')) actions['walk'] = act;
        else if (lower.includes('bite') || lower.includes('attack')) actions['attack'] = act;
      }
      if (Object.keys(actions).length === 0) actions['walk'] = mixer.clipAction(clips[0]);
    }

    const z: ZombieInstance = {
      id,
      archetype,
      state: 'patrol',
      group,
      body,
      radius,
      height: 1.85 * scaleMod,
      mixer,
      actions,
      currentAnim: '',
      hp,
      maxHp: hp,
      speed: speed * (0.9 + Math.random() * 0.2),
      damage,
      attackCooldown: 0,
      attackWindup: 0,
      hitFlashTimer: 0,
      staggerTimer: 0,
      pinTimer: 0,
      groanTimer: 2 + Math.random() * 6,
      investigateTarget: null,
      patrolTarget: this.randomPatrolNear(group.position),
      lastKnownPlayer: null,
      sightTimer: Math.random() * 0.3,
      canSeePlayer: false,
      stuckTimer: 0,
      avoidTimer: 0,
      avoidDir: new THREE.Vector3(),
      lastPos: group.position.clone(),
      meshes,
      deathTimer: 0,
      deathFall: 0,
      facing: Math.random() * Math.PI * 2,
    };

    this.playZombieAnim(z, this.moveAnim(z, false));
    // Desync animation phases so crowds don't march in lockstep
    if (mixer) mixer.update(Math.random() * 3);
    this.zombies.push(z);
    return z;
  }

  private moveAnim(z: ZombieInstance, chasing: boolean): string {
    if (z.archetype === 'crawler') return 'crawl';
    if (chasing && z.archetype === 'sprinter') return 'run';
    return 'walk';
  }

  private randomPatrolNear(pos: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(
      THREE.MathUtils.clamp(pos.x + (Math.random() - 0.5) * 18, -62, 62),
      0,
      THREE.MathUtils.clamp(pos.z + (Math.random() - 0.5) * 18, -62, 62)
    );
  }

  private playZombieAnim(z: ZombieInstance, name: string, timeScale = 1): void {
    if (!z.mixer) return;
    const target = z.actions[name] ?? z.actions['walk'] ?? z.actions['idle'];
    if (!target) return;
    if (z.currentAnim === name) {
      target.setEffectiveTimeScale(timeScale);
      return;
    }
    const prev = z.actions[z.currentAnim];
    if (prev && prev !== target) prev.fadeOut(0.2);
    target.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(0.2);
    target.setLoop(THREE.LoopRepeat, Infinity);
    target.play();
    z.currentAnim = name;
  }

  private setEmissive(z: ZombieInstance, hex: number, intensity: number): void {
    for (const m of z.meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.emissive.setHex(hex);
          mat.emissiveIntensity = intensity;
        }
      }
    }
  }

  private applyDamage(
    z: ZombieInstance,
    damage: number,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    impulseDir: THREE.Vector3,
    headshot: boolean
  ): ZombieHitResult {
    const dmg = headshot ? damage * 2.2 : damage;
    z.hp -= dmg;
    z.hitFlashTimer = 0.09;
    z.staggerTimer = Math.max(z.staggerTimer, z.archetype === 'brute' ? 0.08 : headshot ? 0.32 : 0.18);
    z.attackWindup = 0;
    if (z.state !== 'attack') z.state = 'chase';
    this.setEmissive(z, 0xff2a2a, 1.4);

    const knock = (z.archetype === 'brute' ? 2.5 : 6.0) * Math.min(1.6, dmg / 30);
    z.body.velocity.x += impulseDir.x * knock;
    z.body.velocity.z += impulseDir.z * knock;

    this.vfx.spawnBloodBurst(hitPoint, hitNormal, headshot ? 16 : 8);

    if (z.hp <= 0) {
      if (headshot) this.headshots++;
      this.killZombie(z, impulseDir);
      return { killed: true, headshot };
    }
    return { killed: false, headshot };
  }

  public damageZombieByObject(
    obj: THREE.Object3D,
    damage: number,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    impulseDir: THREE.Vector3
  ): ZombieHitResult | null {
    const id = obj.userData.zombieId as string | undefined;
    if (!id) return null;
    const z = this.zombies.find((item) => item.id === id);
    if (!z) return null;
    if (z.state === 'dead') return { killed: false, headshot: false };
    const headY = z.archetype === 'crawler' ? 0.5 : z.height * 0.8;
    const headshot = hitPoint.y - z.group.position.y > headY;
    return this.applyDamage(z, damage, hitPoint, hitNormal, impulseDir, headshot);
  }

  /** Melee sweep: hits up to 2 zombies in a frontal arc. */
  public meleeSweep(origin: THREE.Vector3, forward: THREE.Vector3, range: number, damage: number): ZombieHitResult[] {
    const candidates: { z: ZombieInstance; d: number }[] = [];
    for (const z of this.zombies) {
      if (z.state === 'dead') continue;
      const to = z.group.position.clone().sub(origin).setY(0);
      const d = to.length();
      if (d > range + z.radius) continue;
      if (d > 0.3 && to.normalize().dot(forward) < 0.35) continue;
      candidates.push({ z, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    const results: ZombieHitResult[] = [];
    for (const { z } of candidates.slice(0, 2)) {
      const hitPoint = z.group.position.clone().setY(1.3 * (z.height / 1.85));
      const normal = forward.clone().negate();
      results.push(this.applyDamage(z, damage, hitPoint, normal, forward, false));
      z.staggerTimer = Math.max(z.staggerTimer, 0.45);
    }
    return results;
  }

  public pinZombie(z: ZombieInstance, duration: number): void {
    if (z.state === 'dead') return;
    z.pinTimer = duration;
    z.staggerTimer = duration;
  }

  private killZombie(z: ZombieInstance, impulseDir: THREE.Vector3): void {
    z.state = 'dead';
    z.deathTimer = 6;
    z.deathFall = 0;
    this.kills++;
    this.physicsWorld.removeBody(z.body);
    this.audio.playPositional(z.archetype === 'brute' ? 'zombie_roar' : 'zombie_groan2', z.group.position, 0.7, 0.15);
    // Fall away from the shot
    z.facing = Math.atan2(impulseDir.x, impulseDir.z);
    z.hitFlashTimer = 0;
    this.setEmissive(z, 0x000000, 0);
    this.vfx.spawnBloodDecal(z.group.position);
  }

  private disposeZombie(z: ZombieInstance): void {
    this.scene.remove(z.group);
    z.mixer?.stopAllAction();
    for (const m of z.meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat) => mat.dispose());
    }
  }

  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    if (this.sightBlockers.length === 0) return true;
    const a = from.clone().setY(1.5);
    const b = to.clone().setY(1.4);
    const dir = b.clone().sub(a);
    const dist = dir.length();
    this.sightRay.set(a, dir.normalize());
    this.sightRay.far = dist;
    return this.sightRay.intersectObjects(this.sightBlockers, false).length === 0;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerCrouching: boolean,
    isNight: boolean,
    extractionActive: boolean,
    onPlayerHit: (damage: number, from: THREE.Vector3) => void
  ): void {
    // Horde Director spawning
    const alive = this.aliveCount();
    const maxZombies = extractionActive ? 34 : isNight ? 26 : 16;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && alive < maxZombies) {
      this.spawnTimer = extractionActive ? 2.0 : isNight ? 3.5 : 6.0;
      const options = this.spawnPoints.filter((p) => p.distanceTo(playerPos) > 22);
      if (options.length > 0) {
        const pt = options[Math.floor(Math.random() * options.length)];
        const roll = Math.random();
        let arch: ZombieArchetype = 'shambler';
        if (isNight || extractionActive) {
          if (roll < 0.36) arch = 'sprinter';
          else if (roll < 0.52) arch = 'brute';
          else if (roll < 0.66) arch = 'crawler';
        } else {
          if (roll < 0.18) arch = 'sprinter';
          else if (roll < 0.28) arch = 'crawler';
          else if (roll < 0.33) arch = 'brute';
        }
        const spawned = this.spawnZombie(pt, arch);
        if (extractionActive) {
          spawned.state = 'chase';
          spawned.lastKnownPlayer = playerPos.clone();
        }
      }
    }

    const visionRange = (isNight ? 26 : 20) * (playerCrouching ? 0.6 : 1);

    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];

      if (z.state === 'dead') {
        // Procedural collapse (the pack has no death clip): ease into the ground
        z.deathTimer -= dt;
        if (z.deathFall < 1) {
          z.deathFall = Math.min(1, z.deathFall + dt * 2.6);
          const e = 1 - Math.pow(1 - z.deathFall, 3);
          z.group.rotation.set(-e * Math.PI * 0.48, z.facing + Math.PI, 0);
          z.group.position.y = e * 0.08;
          if (z.mixer) z.mixer.update(dt * (1 - e));
        }
        if (z.deathTimer < 1.2) z.group.position.y -= dt * 0.35;
        if (z.deathTimer <= 0) {
          this.disposeZombie(z);
          this.zombies.splice(i, 1);
        }
        continue;
      }

      if (z.mixer) z.mixer.update(dt);

      if (z.hitFlashTimer > 0) {
        z.hitFlashTimer -= dt;
        if (z.hitFlashTimer <= 0) this.setEmissive(z, 0x000000, 0);
      }

      z.attackCooldown = Math.max(0, z.attackCooldown - dt);
      z.staggerTimer = Math.max(0, z.staggerTimer - dt);
      z.pinTimer = Math.max(0, z.pinTimer - dt);

      const zPos = new THREE.Vector3(z.body.position.x, 0, z.body.position.z);
      const distToPlayer = zPos.distanceTo(playerPos);

      // Periodic positional groans
      z.groanTimer -= dt;
      if (z.groanTimer <= 0 && distToPlayer < 30) {
        z.groanTimer = (z.state === 'chase' ? 2.5 : 5) + Math.random() * 5;
        const r = Math.random();
        const sfx = z.archetype === 'brute' ? 'zombie_roar' : r < 0.33 ? 'zombie_groan1' : r < 0.66 ? 'zombie_groan2' : 'zombie_groan3';
        this.audio.playPositional(sfx, zPos, z.state === 'chase' ? 0.6 : 0.4, 0.14);
      }

      if (z.staggerTimer > 0 || z.pinTimer > 0) {
        z.body.velocity.x *= 0.85;
        z.body.velocity.z *= 0.85;
        this.syncTransform(z, dt);
        continue;
      }

      // Throttled line-of-sight checks
      z.sightTimer -= dt;
      if (z.sightTimer <= 0) {
        z.sightTimer = 0.25 + Math.random() * 0.1;
        z.canSeePlayer = distToPlayer < 4 || (distToPlayer < visionRange && this.hasLineOfSight(zPos, playerPos));
        if (z.canSeePlayer) z.lastKnownPlayer = playerPos.clone();
      }

      // State transitions
      const wasChasing = z.state === 'chase' || z.state === 'attack';
      if (extractionActive || z.canSeePlayer) {
        if (!wasChasing && distToPlayer < 18 && Math.random() < 0.5) {
          this.audio.playPositional(z.archetype === 'brute' ? 'zombie_roar' : 'zombie_groan1', zPos, 0.55, 0.1);
        }
        if (z.state !== 'attack') z.state = 'chase';
        z.lastKnownPlayer = playerPos.clone();
      } else if (wasChasing && z.lastKnownPlayer) {
        // Lost sight: hunt the last known position
        z.state = 'investigate';
        z.investigateTarget = z.lastKnownPlayer;
        z.lastKnownPlayer = null;
      }

      let targetPos = z.patrolTarget;
      let moveSpeed = z.speed * 0.4;

      if (z.state === 'chase') {
        targetPos = playerPos;
        moveSpeed = z.speed * (isNight ? 1.15 : 1.0);
        if (distToPlayer < 1.5 + z.radius) {
          z.state = 'attack';
          z.attackWindup = 0.45; // telegraph before the first bite
        }
      } else if (z.state === 'investigate' && z.investigateTarget) {
        targetPos = z.investigateTarget;
        moveSpeed = z.speed * 0.75;
        if (zPos.distanceTo(z.investigateTarget) < 2.0) {
          z.investigateTarget = null;
          z.state = 'patrol';
          z.patrolTarget = this.randomPatrolNear(zPos);
        }
      } else if (zPos.distanceTo(z.patrolTarget) < 1.5) {
        z.patrolTarget = this.randomPatrolNear(zPos);
      }

      if (z.state === 'attack') {
        z.body.velocity.x *= 0.6;
        z.body.velocity.z *= 0.6;
        const toP = playerPos.clone().sub(zPos);
        this.turnToward(z, Math.atan2(toP.x, toP.z), dt, 10);
        this.playZombieAnim(z, z.archetype === 'crawler' ? 'crawl' : 'attack', 1.6);
        if (z.attackWindup > 0) {
          z.attackWindup -= dt;
        } else if (z.attackCooldown <= 0 && distToPlayer < 1.9 + z.radius) {
          z.attackCooldown = z.archetype === 'sprinter' ? 0.9 : 1.2;
          onPlayerHit(z.damage, zPos);
        }
        if (distToPlayer >= 2.2 + z.radius) z.state = 'chase';
        this.syncTransform(z, dt);
        continue;
      }

      // Barricades in the way get torn down
      const barricade = this.nearbyBarricade(zPos);
      if (barricade && (z.state === 'chase' || z.state === 'investigate')) {
        z.body.velocity.x *= 0.5;
        z.body.velocity.z *= 0.5;
        const toB = barricade.position.clone().sub(zPos);
        this.turnToward(z, Math.atan2(toB.x, toB.z), dt, 8);
        this.playZombieAnim(z, 'attack', 1.4);
        if (z.attackCooldown <= 0) {
          z.attackCooldown = 1.3;
          barricade.hp -= z.damage;
          this.audio.playPositional('wood_break', barricade.position, 0.45, 0.15);
          if (barricade.hp <= 0) this.onBarricadeBroken?.(barricade);
        }
        this.syncTransform(z, dt);
        continue;
      }

      const dir = targetPos.clone().sub(zPos).setY(0);
      if (dir.lengthSq() > 0.01) {
        dir.normalize();

        // Stuck detection → side-step around the obstacle for a moment
        const moved = zPos.distanceTo(z.lastPos);
        z.lastPos.copy(zPos);
        if (moved < moveSpeed * dt * 0.25) z.stuckTimer += dt;
        else z.stuckTimer = Math.max(0, z.stuckTimer - dt * 2);
        if (z.stuckTimer > 0.45 && z.avoidTimer <= 0) {
          z.avoidTimer = 0.8 + Math.random() * 0.6;
          z.avoidDir.copy(dir).applyAxisAngle(UP, (Math.random() < 0.5 ? 1 : -1) * Math.PI * 0.5);
          z.stuckTimer = 0;
          if (z.state === 'patrol') z.patrolTarget = this.randomPatrolNear(zPos);
        }
        if (z.avoidTimer > 0) {
          z.avoidTimer -= dt;
          dir.lerp(z.avoidDir, 0.8).normalize();
        }

        // Gentle separation so hordes don't stack into one blob
        for (const o of this.zombies) {
          if (o === z || o.state === 'dead') continue;
          const dx = z.body.position.x - o.body.position.x;
          const dz = z.body.position.z - o.body.position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < 1.4 && d2 > 0.0001) {
            const inv = 0.35 / Math.sqrt(d2);
            dir.x += dx * inv;
            dir.z += dz * inv;
          }
        }
        dir.normalize();

        const k = Math.min(1, dt * 8);
        z.body.velocity.x += (dir.x * moveSpeed - z.body.velocity.x) * k;
        z.body.velocity.z += (dir.z * moveSpeed - z.body.velocity.z) * k;
        this.turnToward(z, Math.atan2(dir.x, dir.z), dt, 6);
      }
      const chasing = z.state === 'chase';
      const anim = this.moveAnim(z, chasing);
      const base = anim === 'run' ? 5.0 : anim === 'crawl' ? 1.6 : 1.3;
      this.playZombieAnim(z, anim, THREE.MathUtils.clamp(moveSpeed / base, 0.5, 1.8));
      this.syncTransform(z, dt);
    }
  }

  private nearbyBarricade(zPos: THREE.Vector3): BarricadeInstance | null {
    for (const b of this.barricades) {
      if (b.hp > 0 && b.position.distanceToSquared(zPos) < 2.2 * 2.2) return b;
    }
    return null;
  }

  private turnToward(z: ZombieInstance, target: number, dt: number, rate: number): void {
    let diff = target - z.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    z.facing += diff * Math.min(1, dt * rate);
  }

  private syncTransform(z: ZombieInstance, _dt: number): void {
    z.body.position.y = z.radius;
    z.body.velocity.y = 0;
    z.group.position.set(z.body.position.x, 0.03, z.body.position.z);
    z.group.rotation.set(0, z.facing, 0);
  }
}
