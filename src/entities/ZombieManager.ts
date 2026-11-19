import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { applySilhouetteRim } from '../core/EnvironmentFX';
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
  attackPhase: 'none' | 'windup' | 'strike' | 'recover';
  attackPhaseTimer: number;
  flinchPitch: number;
  flinchRoll: number;
  hitFlashTimer: number;
  dissolveEmitTimer: number;
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
  modelKey: string;
  bones: {
    head?: THREE.Object3D;
    neck?: THREE.Object3D;
    upperArmL?: THREE.Object3D;
    lowerArmL?: THREE.Object3D;
    upperArmR?: THREE.Object3D;
    lowerArmR?: THREE.Object3D;
    upperLegL?: THREE.Object3D;
    lowerLegL?: THREE.Object3D;
    upperLegR?: THREE.Object3D;
    lowerLegR?: THREE.Object3D;
  };
  hitboxes: Partial<Record<HitZone, THREE.Mesh>>;
  dismembered: {
    head: boolean;
    armL: boolean;
    armR: boolean;
    legL: boolean;
    legR: boolean;
  };
  bleedSockets: { bone: THREE.Object3D; localOffset: THREE.Vector3; timer: number; acc: number }[];
  deathTimer: number;
  deathFall: number;
  facing: number;
}

export type HitZone = 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r';
export type DismemberPart = 'head' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r' | 'gib';

export interface ZombieHitResult {
  killed: boolean;
  headshot: boolean;
  dismembered?: DismemberPart;
}

export interface DamageOptions {
  heavy?: boolean;
  melee?: boolean;
  explosion?: boolean;
  hitZone?: HitZone;
}

const UP = new THREE.Vector3(0, 1, 0);
/** Raycast-only material & shared locational hitbox geometries for accurate limb/head dismemberment. */
const HITBOX_MAT = new THREE.MeshBasicMaterial({ visible: false });
const HB_HEAD_GEO = new THREE.SphereGeometry(0.42, 8, 8);
const HB_TORSO_GEO = new THREE.CylinderGeometry(0.36, 0.34, 0.58, 8);
const HB_ARM_GEO = new THREE.BoxGeometry(0.38, 0.54, 0.62);
const HB_LEG_GEO = new THREE.CylinderGeometry(0.2, 0.18, 0.48, 6);
const HB_CRAWLER_GEO = new THREE.BoxGeometry(0.76, 0.56, 1.25);

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
    const bones: ZombieInstance['bones'] = {};
    group.traverse((o) => {
      o.userData.zombieId = id;
      if (o.name === 'Head') bones.head = o;
      else if (o.name === 'Neck') bones.neck = o;
      else if (o.name === 'UpperArm.L') bones.upperArmL = o;
      else if (o.name === 'LowerArm.L') bones.lowerArmL = o;
      else if (o.name === 'UpperArm.R') bones.upperArmR = o;
      else if (o.name === 'LowerArm.R') bones.lowerArmR = o;
      else if (o.name === 'UpperLeg.L') bones.upperLegL = o;
      else if (o.name === 'LowerLeg.L') bones.lowerLegL = o;
      else if (o.name === 'UpperLeg.R') bones.upperLegR = o;
      else if (o.name === 'LowerLeg.R') bones.lowerLegR = o;
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

    // Subtle Fresnel silhouette rim for readability in midnight fog & rain
    const rimHex = opts.boss ? 0xef4444 : archetype === 'brute' ? 0xf87171 : archetype === 'sprinter' ? 0xfca5a5 : 0x99f6e4;
    const rimStr = opts.boss ? 0.85 : archetype === 'brute' ? 0.62 : archetype === 'sprinter' ? 0.5 : 0.36;
    applySilhouetteRim(group, rimHex, rimStr, 3.1);

    // Multi-part locational hitboxes strictly on the zombie so shooting head, arms, torso, or legs
    // registers crisply and detaches the exact zombie body part hit.
    const hbH = spec.height;
    const hitboxes: Partial<Record<HitZone, THREE.Mesh>> = {};
    const addZone = (zone: HitZone, geo: THREE.BufferGeometry, x: number, y: number, zOff: number, s = 1) => {
      const m = new THREE.Mesh(geo, HITBOX_MAT);
      m.position.set(x, y, zOff);
      if (s !== 1) m.scale.setScalar(s);
      m.userData.zombieId = id;
      m.userData.hitZone = zone;
      group.add(m);
      hitboxes[zone] = m;
    };

    if (archetype === 'crawler') {
      addZone('torso', HB_CRAWLER_GEO, 0, 0.28, 0.15);
      addZone('head', HB_HEAD_GEO, 0, 0.42, 0.62, 0.85);
    } else {
      const wScale = archetype === 'brute' ? 1.2 : 1.0;
      addZone('head', HB_HEAD_GEO, 0, hbH * 0.92, 0.05, wScale);
      addZone('torso', HB_TORSO_GEO, 0, hbH * 0.56, 0, wScale);
      addZone('arm_l', HB_ARM_GEO, 0.42 * wScale, hbH * 0.6, 0.18, wScale);
      addZone('arm_r', HB_ARM_GEO, -0.42 * wScale, hbH * 0.6, 0.18, wScale);
      addZone('leg_l', HB_LEG_GEO, 0.19 * wScale, hbH * 0.22, 0, wScale);
      addZone('leg_r', HB_LEG_GEO, -0.19 * wScale, hbH * 0.22, 0, wScale);
    }

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
      attackPhase: 'none',
      attackPhaseTimer: 0,
      flinchPitch: 0,
      flinchRoll: 0,
      hitFlashTimer: 0,
      dissolveEmitTimer: 0,
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
      modelKey,
      bones,
      hitboxes,
      dismembered: { head: false, armL: false, armR: false, legL: false, legR: false },
      bleedSockets: [],
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

  /** Re-enforces collapsed bone scales after AnimationMixer updates so severed zombie limbs never pop back. */
  private enforceSeveredBones(z: ZombieInstance): void {
    if (z.dismembered.head && z.bones.head) z.bones.head.scale.setScalar(0.001);
    if (z.dismembered.armL) {
      const b = z.bones.upperArmL ?? z.bones.lowerArmL;
      if (b) b.scale.setScalar(0.001);
    }
    if (z.dismembered.armR) {
      const b = z.bones.upperArmR ?? z.bones.lowerArmR;
      if (b) b.scale.setScalar(0.001);
    }
    if (z.dismembered.legL) {
      const b = z.bones.upperLegL ?? z.bones.lowerLegL;
      if (b) b.scale.setScalar(0.001);
    }
    if (z.dismembered.legR) {
      const b = z.bones.upperLegR ?? z.bones.lowerLegR;
      if (b) b.scale.setScalar(0.001);
    }
  }

  /** Emits arterial spurts from live & freshly killed severed zombie bone sockets. */
  private updateBleedSockets(z: ZombieInstance, dt: number): void {
    if (z.bleedSockets.length === 0) return;
    const worldPos = new THREE.Vector3();
    const sprayDir = new THREE.Vector3();
    for (let i = z.bleedSockets.length - 1; i >= 0; i--) {
      const s = z.bleedSockets[i];
      s.timer -= dt;
      if (s.timer <= 0) {
        z.bleedSockets.splice(i, 1);
        continue;
      }
      s.acc -= dt;
      if (s.acc <= 0) {
        s.acc = z.state === 'dead' ? 0.085 : 0.11;
        worldPos.copy(s.localOffset);
        s.bone.localToWorld(worldPos);
        sprayDir.set((Math.random() - 0.5) * 0.7, 1.0, (Math.random() - 0.5) * 0.7).normalize();
        this.vfx.spawnBleedDrip(worldPos, sprayDir);
      }
    }
  }

  /** Severs a head, arm, or leg directly off a zombie skeleton, attaches a bloody bone stump, and launches the Blender .glb gib. */
  private severPart(
    z: ZombieInstance,
    part: 'head' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r',
    impulseDir: THREE.Vector3,
    power = 1.0
  ): boolean {
    if (part === 'head' && z.dismembered.head) return false;
    if (part === 'arm_l' && z.dismembered.armL) return false;
    if (part === 'arm_r' && z.dismembered.armR) return false;
    if (part === 'leg_l' && z.dismembered.legL) return false;
    if (part === 'leg_r' && z.dismembered.legR) return false;

    const targetBone =
      part === 'head'
        ? z.bones.head
        : part === 'arm_l'
        ? z.bones.upperArmL ?? z.bones.lowerArmL
        : part === 'arm_r'
        ? z.bones.upperArmR ?? z.bones.lowerArmR
        : part === 'leg_l'
        ? z.bones.upperLegL ?? z.bones.lowerLegL
        : z.bones.upperLegR ?? z.bones.lowerLegR;

    const worldPos = new THREE.Vector3();
    if (targetBone) {
      targetBone.getWorldPosition(worldPos);
      targetBone.scale.setScalar(0.001);
    } else {
      const yFrac = part === 'head' ? 0.85 : part.startsWith('arm') ? 0.58 : 0.26;
      worldPos.copy(z.group.position).add(new THREE.Vector3(0, z.height * yFrac, 0));
    }

    // Remove the severed limb's hitbox so shots pass through empty air where the limb used to be
    const hb = z.hitboxes[part];
    if (hb) {
      z.group.remove(hb);
      delete z.hitboxes[part];
    }

    if (part === 'head') {
      z.dismembered.head = true;
    } else if (part === 'arm_l') {
      z.dismembered.armL = true;
      z.damage = Math.max(5, Math.round(z.damage * 0.8));
    } else if (part === 'arm_r') {
      z.dismembered.armR = true;
      z.damage = Math.max(5, Math.round(z.damage * 0.8));
    } else if (part === 'leg_l') {
      z.dismembered.legL = true;
      z.speed = Math.max(0.65, z.speed * 0.45);
    } else {
      z.dismembered.legR = true;
      z.speed = Math.max(0.65, z.speed * 0.45);
    }

    // Attach glistening Blender-sculpted bloody bone stump to parent bone so it isn't scaled down
    if (targetBone && targetBone.parent && this.assets.hasModel('gib_stump')) {
      const stump = this.assets.cloneModel('gib_stump');
      stump.position.copy(targetBone.position);
      stump.scale.setScalar(part === 'head' ? 0.96 : 0.78);
      if (part === 'head') {
        stump.rotation.x = Math.PI / 2;
      } else {
        const outDir = targetBone.position.clone();
        if (outDir.lengthSq() > 0.0001) {
          stump.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), outDir.normalize());
        }
      }
      stump.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          m.material = Array.isArray(m.material) ? m.material.map((mm) => mm.clone()) : m.material.clone();
          m.raycast = () => {};
          z.meshes.push(m);
        }
      });
      targetBone.parent.add(stump);
      z.bleedSockets.push({
        bone: targetBone.parent,
        localOffset: targetBone.position.clone(),
        timer: part === 'head' ? 2.2 : 3.6,
        acc: 0,
      });
    }

    const gibScale = z.group.scale.x * (z.archetype === 'brute' ? 0.98 : 0.94);
    const gibKey =
      part === 'head'
        ? z.archetype === 'brute'
          ? 'gib_brute_head'
          : 'gib_head'
        : part === 'arm_l'
        ? 'gib_arm_l'
        : part === 'arm_r'
        ? 'gib_arm_r'
        : part === 'leg_l'
        ? 'gib_leg_l'
        : 'gib_leg_r';

    if (targetBone || part === 'head') {
      this.vfx.spawnGib(gibKey, worldPos, impulseDir, gibScale, power);
    } else {
      this.vfx.spawnGib('gib_chunk', worldPos, impulseDir, gibScale, power);
    }

    // Extra visceral meat chunk on decapitation or heavy power shots
    if (part === 'head' || power > 1.1) {
      this.vfx.spawnGib('gib_chunk', worldPos, impulseDir, gibScale * 0.92, power * 1.1);
    }

    const sprayDir = impulseDir.clone().multiplyScalar(0.75).add(new THREE.Vector3(0, 0.72, 0)).normalize();
    this.vfx.spawnArterialSpray(worldPos, sprayDir, part === 'head' ? 24 : 18, part === 'head' ? 5.4 : 4.6);
    this.vfx.spawnBloodSplat(
      new THREE.Vector3(worldPos.x + impulseDir.x * 0.7, 0.078, worldPos.z + impulseDir.z * 0.7),
      UP,
      part === 'head' ? 1.35 : 1.0
    );
    this.audio.playDismember(worldPos, part === 'head' || power > 1.15);
    return true;
  }

  /** Picks the closest intact limb to a hit position so bullets blow off the exact zombie limb shot. */
  private pickLimbNear(
    z: ZombieInstance,
    hitPoint: THREE.Vector3,
    maxDist: number,
    includeLegs = false
  ): 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r' | null {
    const tmp = new THREE.Vector3();
    let best: 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r' | null = null;
    let bestD = maxDist;

    const candidates: ['arm_l' | 'arm_r' | 'leg_l' | 'leg_r', boolean, THREE.Object3D | undefined][] = [
      ['arm_l', z.dismembered.armL, z.bones.upperArmL ?? z.bones.lowerArmL],
      ['arm_r', z.dismembered.armR, z.bones.upperArmR ?? z.bones.lowerArmR],
    ];
    if (includeLegs) {
      candidates.push(
        ['leg_l', z.dismembered.legL, z.bones.upperLegL ?? z.bones.lowerLegL],
        ['leg_r', z.dismembered.legR, z.bones.upperLegR ?? z.bones.lowerLegR]
      );
    }

    for (const [key, gone, bone] of candidates) {
      if (gone || !bone) continue;
      bone.getWorldPosition(tmp);
      const d = tmp.distanceTo(hitPoint);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }

  private applyDamage(
    z: ZombieInstance,
    damage: number,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    impulseDir: THREE.Vector3,
    headshot: boolean,
    opts: DamageOptions = {}
  ): ZombieHitResult {
    const dmg = headshot ? damage * 2.4 : damage;
    z.hp -= dmg;
    z.hitFlashTimer = 0.13;
    z.staggerTimer = Math.max(z.staggerTimer, z.archetype === 'brute' ? 0.08 : headshot ? 0.34 : 0.2);
    // Interrupt normal windup on stagger (Brutes have hyper-armor once slamming!)
    if (z.archetype !== 'brute' && z.attackPhase === 'windup') {
      z.attackPhase = 'none';
      z.attackPhaseTimer = 0;
    }
    if (z.state !== 'attack') z.state = 'chase';
    // Crisp bright white-hot impact flash (shifts to crimson as it decays)
    this.setEmissive(z, 0xffffff, 2.6);

    // Directional hit flinch proportional to impact force
    const localForward = new THREE.Vector3(Math.sin(z.facing), 0, Math.cos(z.facing));
    const localRight = new THREE.Vector3(Math.cos(z.facing), 0, -Math.sin(z.facing));
    const flinchScale = (z.archetype === 'brute' ? 0.14 : 0.34) * Math.min(1.5, dmg / 30);
    z.flinchPitch = THREE.MathUtils.clamp(z.flinchPitch - impulseDir.dot(localForward) * flinchScale, -0.45, 0.45);
    z.flinchRoll = THREE.MathUtils.clamp(z.flinchRoll + impulseDir.dot(localRight) * flinchScale, -0.4, 0.4);

    const knock = (z.archetype === 'brute' ? 2.5 : 6.2) * Math.min(1.6, dmg / 30);
    z.body.velocity.x += impulseDir.x * knock;
    z.body.velocity.z += impulseDir.z * knock;

    this.vfx.spawnBloodBurst(hitPoint, hitNormal, headshot ? 20 : opts.heavy ? 16 : 12);
    const now = performance.now();
    if (now - this.lastFleshSound > 45) {
      this.lastFleshSound = now;
      this.audio.playPositional('impact_flesh', hitPoint, 0.58, 0.12, 6);
    }

    let dismembered: DismemberPart | undefined;
    const zone = opts.hitZone;

    // Live zombie dismemberment: shooting a zombie's arm or leg immediately breaks that limb off!
    if (!opts.explosion && z.hp > 0) {
      if (zone === 'arm_l' || zone === 'arm_r') {
        if (this.severPart(z, zone, impulseDir, opts.heavy ? 1.25 : 1.05)) {
          dismembered = zone;
          z.staggerTimer = Math.max(z.staggerTimer, z.archetype === 'brute' ? 0.28 : 0.48);
        }
      } else if (zone === 'leg_l' || zone === 'leg_r') {
        if ((dmg >= 20 || z.hp <= z.maxHp * 0.78) && this.severPart(z, zone, impulseDir, opts.heavy ? 1.25 : 1.05)) {
          dismembered = zone;
          z.staggerTimer = Math.max(z.staggerTimer, z.archetype === 'brute' ? 0.32 : 0.55);
          // Losing both legs kills the zombie outright
          if (z.dismembered.legL && z.dismembered.legR) z.hp = 0;
        }
      } else if (!headshot && (opts.heavy || opts.melee || z.hp <= z.maxHp * 0.65)) {
        // Torso hits around half health, shotgun blasts, or axe swings snap off the closest intact arm
        const side = this.pickLimbNear(z, hitPoint, 1.8, false);
        if (side && this.severPart(z, side, impulseDir, opts.heavy ? 1.25 : 1.0)) {
          dismembered = side;
          z.staggerTimer = Math.max(z.staggerTimer, z.archetype === 'brute' ? 0.25 : 0.46);
        }
      }
    }

    if (z.hp > 0 && now > z.hurtVoiceAt) {
      z.hurtVoiceAt = now + 650;
      z.groanTimer = Math.max(z.groanTimer, 1.5);
      this.audio.playPositional(z.archetype === 'brute' ? 'brute_hurt' : 'zombie_hurt', z.group.position, 0.6, 0.12);
    }

    if (z.hp > 0 && z.archetype !== 'brute') this.playZombieAnim(z, 'hit', 1.4, true);
    if (z.hp <= 0) {
      if (headshot) this.headshots++;
      if (opts.explosion) {
        // Catastrophic blast gibbing: blow zombie completely apart
        this.severPart(z, 'head', impulseDir, 1.45);
        this.severPart(z, 'arm_l', impulseDir, 1.35);
        this.severPart(z, 'arm_r', impulseDir, 1.35);
        this.severPart(z, 'leg_l', impulseDir, 1.25);
        for (let k = 0; k < 3; k++) {
          this.vfx.spawnGib('gib_chunk', hitPoint, impulseDir, z.group.scale.x, 1.35);
        }
        dismembered = 'gib';
      } else if (headshot) {
        // Fatal headshots pop the zombie's head right off with an arterial neck fountain
        if (this.severPart(z, 'head', impulseDir, opts.heavy ? 1.35 : 1.1)) {
          dismembered = 'head';
        }
      } else if (zone === 'arm_l' || zone === 'arm_r' || zone === 'leg_l' || zone === 'leg_r') {
        if (this.severPart(z, zone, impulseDir, opts.heavy ? 1.3 : 1.05)) {
          dismembered = zone;
        }
      } else if (!dismembered) {
        // On every body kill, visibly break off a limb or head + bloody gore chunk so zombies fall apart dramatically
        const limb = this.pickLimbNear(z, hitPoint, 2.4, true);
        if (limb && this.severPart(z, limb, impulseDir, opts.heavy ? 1.3 : 1.05)) {
          dismembered = limb;
        } else if (this.severPart(z, 'head', impulseDir, 1.2)) {
          dismembered = 'head';
        } else {
          this.vfx.spawnGib('gib_chunk', hitPoint, impulseDir, z.group.scale.x * 0.95, 1.05);
          dismembered = 'gib';
        }
        // Shotgun / Sniper / Axe kills blow off an extra part too!
        if (opts.heavy || opts.melee) {
          const second = this.pickLimbNear(z, hitPoint, 2.8, true);
          if (second) this.severPart(z, second, impulseDir, 1.25);
          else this.severPart(z, 'head', impulseDir, 1.25);
        }
      }
      this.killZombie(z, impulseDir);
      return { killed: true, headshot, dismembered };
    }
    return { killed: false, headshot, dismembered };
  }

  public damageZombieByObject(
    obj: THREE.Object3D,
    damage: number,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    impulseDir: THREE.Vector3,
    opts: DamageOptions = {}
  ): ZombieHitResult | null {
    const id = obj.userData.zombieId as string | undefined;
    if (!id) return null;
    const z = this.zombies.find((item) => item.id === id);
    if (!z) return null;
    if (z.state === 'dead') return { killed: false, headshot: false };
    const hitZone = obj.userData.hitZone as HitZone | undefined;
    const headY = z.height * 0.72;
    const headshot = hitZone === 'head' || (!hitZone && hitPoint.y - z.group.position.y > headY);
    return this.applyDamage(z, damage, hitPoint, hitNormal, impulseDir, headshot, { ...opts, hitZone });
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
      const hitPoint = z.group.position.clone().setY(z.height * 0.68);
      const normal = forward.clone().negate();
      results.push(this.applyDamage(z, damage, hitPoint, normal, forward, false, { melee: true }));
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
      const res = this.applyDamage(z, damage * falloff, hitPoint, dir.clone().setY(0.4).normalize(), dir, false, {
        heavy: true,
        explosion: true,
      });
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
        // Collapse plays once and holds, then smoothly disintegrates into glowing embers & ash
        z.deathTimer -= dt;
        if (z.mixer && z.deathTimer > 3.6) z.mixer.update(dt);
        this.enforceSeveredBones(z);
        this.updateBleedSockets(z, dt);
        if (z.deathTimer < 1.8) {
          const alpha = THREE.MathUtils.clamp(z.deathTimer / 1.8, 0, 1);
          z.dissolveEmitTimer -= dt;
          if (z.dissolveEmitTimer <= 0) {
            z.dissolveEmitTimer = 0.14;
            this.vfx.spawnDissolveEmbers(z.group.position);
          }
          for (const m of z.meshes) {
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              if (mat instanceof THREE.MeshStandardMaterial) {
                if (!mat.transparent) {
                  mat.transparent = true;
                  mat.needsUpdate = true;
                }
                mat.opacity = alpha;
                mat.emissive.setHex(0xc2410c);
                mat.emissiveIntensity = (1 - alpha) * 1.1;
              }
            }
          }
        }
        if (z.deathTimer <= 0) {
          this.disposeZombie(z);
          this.zombies.splice(i, 1);
        }
        continue;
      }

      if (z.mixer) z.mixer.update(dt);
      this.enforceSeveredBones(z);
      this.updateBleedSockets(z, dt);

      // Decay directional hit flinch smoothly
      z.flinchPitch = THREE.MathUtils.lerp(z.flinchPitch, 0, Math.min(1, dt * 11));
      z.flinchRoll = THREE.MathUtils.lerp(z.flinchRoll, 0, Math.min(1, dt * 11));

      if (z.hitFlashTimer > 0) {
        z.hitFlashTimer -= dt;
        if (z.hitFlashTimer <= 0) {
          this.setEmissive(z, 0x000000, 0);
        } else if (z.hitFlashTimer < 0.07) {
          // Transition from crisp white impact flash to deep crimson
          this.setEmissive(z, 0xdc2626, (z.hitFlashTimer / 0.07) * 1.3);
        }
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

      // Throttled line-of-sight + directional 150-degree vision cone checks (enables sneaking behind zombies!)
      z.sightTimer -= dt;
      if (z.sightTimer <= 0) {
        z.sightTimer = 0.25 + Math.random() * 0.1;
        const proxSense = playerCrouching ? 2.1 : 3.8;
        if (distToPlayer < proxSense) {
          z.canSeePlayer = true;
        } else if (distToPlayer < visionRange) {
          const toP = playerPos.clone().sub(zPos).setY(0).normalize();
          const zFwd = new THREE.Vector3(Math.sin(z.facing), 0, Math.cos(z.facing));
          const inCone = z.state === 'chase' || z.state === 'attack' || zFwd.dot(toP) > 0.22;
          z.canSeePlayer = inCone && this.hasLineOfSight(zPos, playerPos);
        } else {
          z.canSeePlayer = false;
        }
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
        const startAttackRange = z.archetype === 'brute' ? 2.1 + z.radius : 1.55 + z.radius;
        if (distToPlayer < startAttackRange && z.attackCooldown <= 0) {
          z.state = 'attack';
          z.attackPhase = 'windup';
          const isBoss = z.id === this.bossId;
          const isHeavy = z.archetype === 'brute';
          z.attackPhaseTimer = isBoss ? 0.85 : isHeavy ? 0.72 : z.archetype === 'sprinter' ? 0.36 : 0.5;
          this.audio.playZombieTelegraph(zPos, isHeavy);
          if (isHeavy) {
            this.vfx.spawnWarningRing(zPos, isBoss ? 3.5 : 2.8, z.attackPhaseTimer);
          }
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

      // 3-Phase Telegraphed Attack State Machine: Anticipation (windup) -> Execution (strike) -> Recovery (recover)
      if (z.state === 'attack') {
        const isBoss = z.id === this.bossId;
        const isHeavy = z.archetype === 'brute';
        const toP = playerPos.clone().sub(zPos).setY(0);
        const toDir = toP.lengthSq() > 0.001 ? toP.clone().normalize() : new THREE.Vector3(Math.sin(z.facing), 0, Math.cos(z.facing));
        z.attackPhaseTimer -= dt;

        if (z.attackPhase === 'windup') {
          z.body.velocity.x *= 0.65;
          z.body.velocity.z *= 0.65;
          this.turnToward(z, Math.atan2(toDir.x, toDir.z), dt, 10);
          // Lean back visibly during anticipation and pulse amber/crimson warning glint
          z.flinchPitch = THREE.MathUtils.lerp(z.flinchPitch, isHeavy ? -0.32 : -0.22, Math.min(1, dt * 10));
          this.playZombieAnim(z, 'idle', 0.8);
          if (z.hitFlashTimer <= 0) {
            const pulse = 0.5 + 0.5 * Math.sin(z.attackPhaseTimer * 28);
            this.setEmissive(z, isHeavy ? 0xef4444 : 0xf59e0b, 0.35 + pulse * 0.65);
          }
          if (z.attackPhaseTimer <= 0) {
            // Transition -> Energetic Strike Execution
            z.attackPhase = 'strike';
            z.attackPhaseTimer = 0.16;
            if (z.hitFlashTimer <= 0) this.setEmissive(z, 0x000000, 0);
            const lunge = isHeavy ? 3.5 : z.archetype === 'sprinter' ? 7.8 : 5.2;
            z.body.velocity.x = toDir.x * lunge;
            z.body.velocity.z = toDir.z * lunge;
            z.flinchPitch = isHeavy ? 0.36 : 0.28;
            this.playZombieAnim(z, 'attack', isHeavy ? 1.05 : 1.3, true);

            const hitRange = isBoss ? 3.5 : isHeavy ? 2.8 : 2.1 + z.radius;
            if (isHeavy) {
              this.vfx.spawnSlamShockwave(zPos, hitRange);
              this.audio.playSlamImpact(zPos);
            }
            if (distToPlayer < hitRange) {
              onPlayerHit(z.damage, zPos);
            }
          }
        } else if (z.attackPhase === 'strike') {
          z.body.velocity.x *= 0.82;
          z.body.velocity.z *= 0.82;
          if (z.attackPhaseTimer <= 0) {
            z.attackPhase = 'recover';
            z.attackPhaseTimer = isHeavy ? 0.72 : z.archetype === 'sprinter' ? 0.38 : 0.48;
            z.attackCooldown = isHeavy ? 1.15 : z.archetype === 'sprinter' ? 0.65 : 0.85;
          }
        } else {
          // Recovery window: vulnerable follow-through
          z.body.velocity.x *= 0.6;
          z.body.velocity.z *= 0.6;
          if (z.attackPhaseTimer <= 0) {
            z.attackPhase = 'none';
            z.state = 'chase';
          }
        }
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
              const outDir = zPos.clone().sub(b.position).setY(0.2).normalize();
              this.vfx.spawnWoodSplinters(b.position.clone().setY(1.2), outDir, 5, false);
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
    z.group.rotation.set(z.flinchPitch, z.facing, z.flinchRoll, 'YXZ');
  }
}
