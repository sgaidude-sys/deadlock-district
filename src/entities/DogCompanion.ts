import * as THREE from 'three';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { ZombieInstance, ZombieManager } from './ZombieManager';

const CLIP_MAP: Record<string, string> = {
  idle: 'Idle',
  idle_alt: 'Idle_2_HeadLow',
  run: 'Run',
  walk: 'Walk',
  attack: 'Attack',
};

export class DogCompanion {
  public group: THREE.Group;
  public recruited = false;
  public alertTimer = 0;

  private audio: AudioManager;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private currentAnim = '';

  private barkCooldown = 0;
  private pinCooldown = 0;
  private attackAnimTimer = 0;
  private lastAlertedId: string | null = null;
  private wagTimer = 0;

  constructor(spawnPos: THREE.Vector3, scene: THREE.Scene, assets: AssetManager, audio: AudioManager) {
    this.audio = audio;

    this.group = assets.cloneModel('dog_shepherd');
    this.group.position.copy(spawnPos).setY(0.06);
    this.group.rotation.y = Math.PI * 0.8;
    scene.add(this.group);

    const clips = assets.getClips('dog_shepherd');
    if (clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.group);
      for (const [key, clipName] of Object.entries(CLIP_MAP)) {
        const clip = clips.find((c) => c.name === clipName);
        if (clip) this.actions[key] = this.mixer.clipAction(clip);
      }
      this.playAnim('idle_alt');
    }
  }

  public recruit(): void {
    if (this.recruited) return;
    this.recruited = true;
    this.audio.playPositional('dog_bark', this.group.position, 0.85, 0.05);
  }

  private playAnim(name: string, timeScale = 1): void {
    if (!this.mixer) return;
    const act = this.actions[name] ?? this.actions['idle'];
    if (!act) return;
    if (this.currentAnim === name) {
      act.setEffectiveTimeScale(timeScale);
      return;
    }
    const prev = this.actions[this.currentAnim];
    if (prev && prev !== act) prev.fadeOut(0.18);
    act.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(0.18).play();
    this.currentAnim = name;
  }

  private faceToward(dir: THREE.Vector3, dt: number): void {
    const target = Math.atan2(dir.x, dir.z);
    let diff = target - this.group.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.group.rotation.y += diff * Math.min(1, dt * 10);
  }

  public update(dt: number, playerPos: THREE.Vector3, playerYaw: number, zombieManager: ZombieManager): void {
    if (this.mixer) this.mixer.update(dt);
    this.barkCooldown = Math.max(0, this.barkCooldown - dt);
    this.pinCooldown = Math.max(0, this.pinCooldown - dt);
    this.alertTimer = Math.max(0, this.alertTimer - dt);
    this.attackAnimTimer = Math.max(0, this.attackAnimTimer - dt);

    if (!this.recruited) {
      // Idle loop, occasionally looks up at the player when they're close
      this.wagTimer -= dt;
      const near = this.group.position.distanceTo(playerPos) < 6;
      if (near) {
        this.faceToward(playerPos.clone().sub(this.group.position), dt * 0.4);
        this.playAnim('idle');
      } else if (this.wagTimer <= 0) {
        this.wagTimer = 4;
        this.playAnim('idle_alt');
      }
      return;
    }

    // If the dog gets stuck far behind (no physics), let it catch up
    if (this.group.position.distanceTo(playerPos) > 28) {
      const behind = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw)).multiplyScalar(2.5);
      this.group.position.copy(playerPos).add(behind).setY(0.06);
    }

    // Nearest threat to the player
    let nearestZ: ZombieInstance | null = null;
    let nearestDist = 18;
    for (const z of zombieManager.zombies) {
      if (z.state === 'dead') continue;
      const d = z.group.position.distanceTo(playerPos);
      if (d < nearestDist) {
        nearestDist = d;
        nearestZ = z;
      }
    }

    // Bark when a *new* threat closes in, or a hunter is actively chasing
    if (nearestZ && this.barkCooldown <= 0) {
      const isNew = nearestZ.id !== this.lastAlertedId && nearestDist < 14;
      const isHunting = nearestZ.state === 'chase' && nearestDist < 12;
      if (isNew || isHunting) {
        this.barkCooldown = 6;
        this.alertTimer = 2.5;
        this.lastAlertedId = nearestZ.id;
        this.audio.playPositional('dog_bark', this.group.position, 0.8, 0.08);
      }
    }

    if (this.attackAnimTimer > 0) return;

    // Pin a close zombie
    if (nearestZ && nearestDist < 9 && this.pinCooldown <= 0) {
      const toZ = nearestZ.group.position.clone().sub(this.group.position).setY(0);
      if (toZ.length() > 1.3) {
        toZ.normalize();
        this.group.position.addScaledVector(toZ, 7.5 * dt);
        this.faceToward(toZ, dt);
        this.playAnim('run', 1.1);
      } else {
        zombieManager.pinZombie(nearestZ, 3.0);
        this.pinCooldown = 9.0;
        this.attackAnimTimer = 1.0;
        this.audio.playPositional('dog_bark', this.group.position, 0.9, 0.05);
        this.playAnim('attack');
      }
      return;
    }

    // Follow at heel (behind-left of the player's facing)
    const back = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw));
    const left = new THREE.Vector3(-Math.cos(playerYaw), 0, Math.sin(playerYaw));
    const target = playerPos.clone().addScaledVector(back, 1.6).addScaledVector(left, 1.2);
    const diff = target.sub(this.group.position).setY(0);
    const dist = diff.length();

    if (dist > 1.2) {
      diff.normalize();
      const speed = dist > 6 ? 8.0 : dist > 3 ? 5.2 : 3.0;
      this.group.position.addScaledVector(diff, speed * dt);
      this.faceToward(diff, dt);
      this.playAnim(dist > 6 ? 'run' : 'walk', dist > 6 ? 1.0 : speed / 3.4);
    } else {
      this.playAnim('idle');
    }
  }
}
