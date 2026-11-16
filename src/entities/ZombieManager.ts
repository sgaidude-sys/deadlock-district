import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { VFXManager } from '../core/VFXManager';
import { ZombieAIState, ZombieArchetype } from '../types/game';
import { BarricadeInstance } from '../world/CityGenerator';
import type { RouteStep } from '../systems/FortificationSystem';

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
  stepTimer: number;
  hurtVoiceAt: number;
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
/** Raycast-only material: the mesh stays "visible" to the raycaster but never draws. */
const HITBOX_MAT = new THREE.MeshBasicMaterial({ visible: false });

type AnimRole = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death';

interface ArchetypeSpec {
  /** Kit model keys; one is picked at random per spawn. */
  models: string[];
  hp: number;
  /** Chase speed (m/s). Patrol is 40 % of this. */
  speed: number;
  damage: number;
  radius: number;
  scale: number;
  /** Native standing height of the kit model (metres). */
  height: number;
  /** Ground speed (m/s) each loop clip covers at timeScale 1 (measured from planted-foot travel). */
  clipSpeed: { walk: number; run: number };
  clips: Record<AnimRole, string>;
}

const CLIP_FALLBACKS: Record<AnimRole, string[]> = {
  idle: ['Idle'],
  walk: ['Walk'],
  run: ['Run_Arms', 'Run', 'Walk'],
  attack: ['Punch', 'Run_Attack', 'Idle_Attack', 'Jump'],
  hit: ['HitReact'],
  death: ['Death'],
};

/** All zombie types are Zombie Apocalypse Kit rigs with their own clips. */
const ARCHETYPES: Record<ZombieArchetype, ArchetypeSpec> = {
  shambler: {
    models: ['zombie_basic'],
    hp: 85,
    speed: 2.2,
    damage: 12,
    radius: 0.38,
    scale: 1.1,
    height: 1.25,
    clipSpeed: { walk: 0.65, run: 2.8 },
    clips: { idle: 'Idle', walk: 'Walk', run: 'Run_Arms', attack: 'Punch', hit: 'HitReact', death: 'Death' },
  },
  sprinter: {
    models: ['zombie_arm', 'zombie_ribcage'],
    hp: 60,
    speed: 4.0,
    damage: 14,
    radius: 0.36,
    scale: 1.1,
    height: 1.4,
    clipSpeed: { walk: 0.65, run: 2.5 },
    clips: { idle: 'Idle', walk: 'Walk', run: 'Run', attack: 'Punch', hit: 'HitReact', death: 'Death' },
  },
  brute: {
    models: ['zombie_chubby'],
    hp: 260,
    speed: 1.7,
    damage: 26,
    radius: 0.55,
    scale: 1.25,
    height: 1.55,
    clipSpeed: { walk: 0.7, run: 0.7 },
    clips: { idle: 'Idle', walk: 'Walk', run: 'Walk', attack: 'Punch', hit: 'HitReact', death: 'Death' },
  },
  crawler: {
    models: ['zombie_basic'],
    hp: 55,
    speed: 1.1,
    damage: 10,
    radius: 0.36,
    scale: 1.1,
    height: 0.6,
    clipSpeed: { walk: 0.6, run: 0.6 },
    clips: { idle: 'Crawl', walk: 'Crawl', run: 'Crawl', attack: 'Idle_Attack', hit: 'HitReact', death: 'Death' },
  },
};

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
  private router?: (from: THREE.Vector3, to: THREE.Vector3) => RouteStep | null;
  private onBarricadeBroken?: (b: BarricadeInstance) => void;
  private bossId: string | null = null;
  private onBossKilled?: (pos: THREE.Vector3) => void;

  private spawnTimer = 2.0;
  private idCounter = 0;
  private sightRay = new THREE.Raycaster();
  private lastFleshSound = 0;

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

  /** Fortification routing: walk to openings, vault open windows, smash barricades in the way. */
  public setRouter(
    router: (from: THREE.Vector3, to: THREE.Vector3) => RouteStep | null,
    onBroken: (b: BarricadeInstance) => void
  ): void {
    this.router = router;
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

  public spawnZombie(
    pos: THREE.Vector3,
    archetype: ZombieArchetype,
    opts: { scale?: number; hp?: number; damage?: number; speed?: number; tint?: number; boss?: boolean } = {}
  ): ZombieInstance {
    this.idCounter++;
    const id = `zombie_${this.idCounter}`;
    const spec = ARCHETYPES[archetype];
    const modelKey = spec.models[Math.floor(Math.random() * spec.models.length)];
    const hp = opts.hp ?? spec.hp;
    const speed = opts.speed ?? spec.speed;
    const damage = opts.damage ?? spec.damage;
    const scaleMod = opts.scale ?? spec.scale;
    const radius = spec.radius * (scaleMod / spec.scale);

    const group = this.assets.cloneModel(modelKey);
    group.position.set(pos.x + (Math.random() - 0.5) * 3, 0, pos.z + (Math.random() - 0.5) * 3);
    group.scale.multiplyScalar(scaleMod * (0.95 + Math.random() * 0.1));
    group.userData.zombieId = id;
    this.scene.add(group);

    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      o.userData.zombieId = id;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        // Own material per zombie so the hit flash only affects this one
        m.material = Array.isArray(m.material) ? m.material.map((mm) => mm.clone()) : m.material.clone();
        m.frustumCulled = false; // skinned bounds don't follow animation
        m.raycast = () => {}; // bullets use the hitbox below, never the skinned mesh
        if (opts.tint !== undefined) {
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            if (mat instanceof THREE.MeshStandardMaterial) mat.color.multiply(new THREE.Color(opts.tint));
          }
        }
        meshes.push(m);
      }
    });

    // Invisible hitbox: SkinnedMesh raycasts use a stale bind-pose bounding sphere (missed shots)
    // and are expensive. A simple shape in the zombie's local space is reliable and cheap.
    const hbH = spec.height; // local units; the group's scale applies on top
    const hitbox =
      archetype === 'crawler'
        ? new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 1.1), HITBOX_MAT)
        : new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, hbH, 8), HITBOX_MAT);
    hitbox.position.set(0, archetype === 'crawler' ? 0.25 : hbH / 2, archetype === 'crawler' ? 0.15 : 0);
    hitbox.userData.zombieId = id;
    group.add(hitbox);
    group.userData.hitbox = hitbox;

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
      for (const [role, clipName] of Object.entries(spec.clips)) {
        // Not every kit rig has every clip (the skeleton has no Punch), so fall back sensibly
        const candidates = [clipName, ...CLIP_FALLBACKS[role as AnimRole]];
        const clip = candidates.map((n) => clips.find((c) => c.name === n)).find(Boolean);
        if (clip) actions[role] = mixer.clipAction(clip);
      }
    }

    const z: ZombieInstance = {
      id,
      archetype,
      state: 'patrol',
      group,
      body,
      radius,
      height: spec.height * scaleMod,
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
      stepTimer: Math.random() * 0.5,
      hurtVoiceAt: 0,
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

    if (opts.boss) this.bossId = id;
    this.playZombieAnim(z, this.moveAnim(z, false));
    // Desync animation phases so crowds don't march in lockstep
    if (mixer) mixer.update(Math.random() * 3);
    this.zombies.push(z);
    return z;
  }

  private moveAnim(z: ZombieInstance, chasing: boolean): AnimRole {
    return chasing ? 'run' : 'walk';
  }

  /** Last known player position, so idle wandering drifts toward where the action is. */
  private playerHint = new THREE.Vector3();

  private randomPatrolNear(pos: THREE.Vector3): THREE.Vector3 {
    // A third of patrol legs head toward the player's neighbourhood; otherwise they mill about.
    const towardPlayer = Math.random() < 0.35 && this.playerHint.lengthSq() > 0;
    const base = towardPlayer ? this.playerHint : pos;
    const spread = towardPlayer ? 24 : 18;
    return new THREE.Vector3(
      THREE.MathUtils.clamp(base.x + (Math.random() - 0.5) * spread, -62, 62),
      0,
      THREE.MathUtils.clamp(base.z + (Math.random() - 0.5) * spread, -62, 62)
    );
  }

  private playZombieAnim(z: ZombieInstance, name: AnimRole, timeScale = 1, oneShot = false): void {
    if (!z.mixer) return;
    const target = z.actions[name] ?? z.actions['walk'] ?? z.actions['idle'];
    if (!target) return;
    if (z.currentAnim === name && !oneShot) {
      target.setEffectiveTimeScale(timeScale);
      return;
    }
    const prev = z.actions[z.currentAnim];
    if (prev && prev !== target) prev.fadeOut(0.15);
    target.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(0.12);
    if (oneShot) {
      target.setLoop(THREE.LoopOnce, 1);
      target.clampWhenFinished = true;
    } else {
      target.setLoop(THREE.LoopRepeat, Infinity);
    }
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
    const now = performance.now();
    if (now - this.lastFleshSound > 45) {
      this.lastFleshSound = now;
      this.audio.playPositional('impact_flesh', hitPoint, 0.5, 0.12, 6);
    }
    if (z.hp > 0 && now > z.hurtVoiceAt) {
      z.hurtVoiceAt = now + 650;
      z.groanTimer = Math.max(z.groanTimer, 1.5);
      this.audio.playPositional(z.archetype === 'brute' ? 'brute_hurt' : 'zombie_hurt', z.group.position, 0.6, 0.12);
    }

    if (z.hp > 0 && z.archetype !== 'brute') this.playZombieAnim(z, 'hit', 1.4, true);
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
    const headY = z.height * 0.78;
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
      const hitPoint = z.group.position.clone().setY(z.height * 0.65);
      const normal = forward.clone().negate();
      results.push(this.applyDamage(z, damage, hitPoint, normal, forward, false));
      z.staggerTimer = Math.max(z.staggerTimer, 0.45);
    }
    return results;
  }

  /** Area damage with falloff and outward knockback. Returns how many zombies it killed. */
  public explosionAt(center: THREE.Vector3, radius: number, damage: number): number {
    let kills = 0;
    for (const z of this.zombies) {
      if (z.state === 'dead') continue;
      const to = z.group.position.clone().sub(center).setY(0);
      const d = to.length();
      if (d > radius) continue;
      const falloff = Math.pow(1 - d / radius, 0.6);
      const dir = d > 0.01 ? to.normalize() : new THREE.Vector3(1, 0, 0);
      const hitPoint = z.group.position.clone().setY(z.height * 0.6);
      const res = this.applyDamage(z, damage * falloff, hitPoint, dir.clone().setY(0.4).normalize(), dir, false);
      if (res.killed) kills++;
      else {
        z.body.velocity.x += dir.x * 12 * falloff;
        z.body.velocity.z += dir.z * 12 * falloff;
        z.staggerTimer = Math.max(z.staggerTimer, 0.9 * falloff);
      }
    }
    return kills;
  }

  public setOnBossKilled(cb: (pos: THREE.Vector3) => void): void {
    this.onBossKilled = cb;
  }

  public getBoss(): ZombieInstance | null {
    return this.zombies.find((z) => z.id === this.bossId && z.state !== 'dead') ?? null;
  }

  public pinZombie(z: ZombieInstance, duration: number): void {
    if (z.state === 'dead' || z.id === this.bossId) return;
    z.pinTimer = duration;
    z.staggerTimer = duration;
  }

  private killZombie(z: ZombieInstance, impulseDir: THREE.Vector3): void {
    z.state = 'dead';
    z.deathTimer = z.id === this.bossId ? 12 : 6;
    if (z.id === this.bossId) {
      this.onBossKilled?.(z.group.position.clone());
      this.bossId = null;
    }
    z.deathFall = 0;
    this.kills++;
    this.physicsWorld.removeBody(z.body);
    const deathVoice = z.archetype === 'brute' ? 'brute_roar' : z.archetype === 'sprinter' ? 'zombie_shriek' : 'zombie_death';
    this.audio.playPositional(deathVoice, z.group.position, 0.7, 0.12, 8, 0.25, z.archetype === 'brute' ? 0.8 : 1);
    const fallPos = z.group.position.clone();
    setTimeout(() => this.audio.playPositional('step_heavy', fallPos, z.archetype === 'brute' ? 0.9 : 0.45, 0.1, 5), 450);
    // Face the shooter so the kit's Death clip falls away from the shot
    z.facing = Math.atan2(-impulseDir.x, -impulseDir.z);
    z.group.rotation.set(0, z.facing, 0);
    this.playZombieAnim(z, 'death', 1, true);
    z.hitFlashTimer = 0;
    this.setEmissive(z, 0x000000, 0);
    this.vfx.spawnBloodDecal(z.group.position);
  }

  private disposeZombie(z: ZombieInstance): void {
    this.scene.remove(z.group);
    z.mixer?.stopAllAction();
    (z.group.userData.hitbox as THREE.Mesh | undefined)?.geometry.dispose();
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
    this.playerHint.copy(playerPos);
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
        // Kit Death clip plays once and holds; corpse sinks away at the end
        z.deathTimer -= dt;
        if (z.mixer && z.deathTimer > 4) z.mixer.update(dt);
        if (z.deathTimer < 1.2) z.group.position.y -= dt * 0.3;
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
        const sfx = distToPlayer < 4 ? 'zombie_breath' : z.archetype === 'brute' ? 'brute_grunt' : 'zombie_groan';
        this.audio.playPositional(sfx, zPos, z.state === 'chase' ? 0.6 : 0.4, 0.14, 8, 0.15, z.archetype === 'crawler' ? 1.2 : 1);
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
          const aggro = z.archetype === 'brute' ? 'brute_roar' : z.archetype === 'sprinter' ? 'zombie_aggro' : 'zombie_roar';
          this.audio.playPositional(aggro, zPos, 0.65, 0.1, 8, 0.4, z.archetype === 'brute' ? 0.85 : 1);
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
        this.playZombieAnim(z, 'attack', 1.15);
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

      // Walls in the way: head for an opening; climb through open windows; smash barricades
      if (this.router && (z.state === 'chase' || z.state === 'investigate')) {
        const step = this.router(zPos, targetPos);
        if (step) {
          if (step.attack && zPos.distanceTo(step.point) < 1.5) {
            const b = step.attack;
            z.body.velocity.x *= 0.5;
            z.body.velocity.z *= 0.5;
            const toB = b.position.clone().sub(zPos);
            this.turnToward(z, Math.atan2(toB.x, toB.z), dt, 8);
            this.playZombieAnim(z, 'attack', 1.0);
            if (z.attackCooldown <= 0) {
              z.attackCooldown = 1.3;
              b.hp -= z.damage * (z.archetype === 'brute' ? 1.1 : 0.55); // planks ≈ 20 s vs one shambler
              this.audio.playPositional(Math.random() < 0.5 ? 'wood_hit' : 'impact_wood', b.position, 0.6, 0.15, 6);
              if (b.hp <= 0) this.onBarricadeBroken?.(b);
            }
            this.syncTransform(z, dt);
            continue;
          }
          if (step.vaultTo && zPos.distanceTo(step.point) < 1.1) {
            // Clamber through the window
            z.body.position.set(step.vaultTo.x, z.radius, step.vaultTo.z);
            z.body.previousPosition.copy(z.body.position);
            z.body.interpolatedPosition.copy(z.body.position);
            z.body.velocity.set(0, 0, 0);
            z.staggerTimer = 0.45;
            this.playZombieAnim(z, 'hit', 1.1, true);
            this.audio.playPositional('gear_rustle', step.vaultTo, 0.6, 0.15, 5);
            this.syncTransform(z, dt);
            continue;
          }
          targetPos = step.point;
        }
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
      if (z.archetype === 'brute' && distToPlayer < 24) {
        const v = Math.hypot(z.body.velocity.x, z.body.velocity.z);
        if (v > 0.4) {
          z.stepTimer -= dt;
          if (z.stepTimer <= 0) {
            z.stepTimer = 0.62 / Math.min(2, v);
            this.audio.playPositional('step_heavy', zPos, 0.55, 0.1, 6);
          }
        }
      }
      const chasing = z.state === 'chase';
      const anim = this.moveAnim(z, chasing);
      const spec = ARCHETYPES[z.archetype];
      const base = (anim === 'run' ? spec.clipSpeed.run : spec.clipSpeed.walk) * z.group.scale.x;
      const actualSpeed = Math.hypot(z.body.velocity.x, z.body.velocity.z);
      this.playZombieAnim(z, anim, THREE.MathUtils.clamp(actualSpeed / base, 0.35, 3.2));
      this.syncTransform(z, dt);
    }
  }


  private turnToward(z: ZombieInstance, target: number, dt: number, rate: number): void {
    let diff = target - z.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    z.facing += diff * Math.min(1, dt * rate);
  }

  private syncTransform(z: ZombieInstance, _dt: number): void {
    z.body.position.y = z.radius;
    z.body.velocity.y = 0;
    z.group.position.set(z.body.interpolatedPosition.x, 0.06, z.body.interpolatedPosition.z);
    z.group.rotation.set(0, z.facing, 0);
  }
}
