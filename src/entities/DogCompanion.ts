import * as THREE from 'three';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { ZombieInstance, ZombieManager } from './ZombieManager';

export class DogCompanion {
  public group: THREE.Group;
  public recruited = false;
  public alertTimer = 0;

  private assets: AssetManager;
  private audio: AudioManager;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private currentAnim = '';

  private barkCooldown = 0;
  private pinCooldown = 0;

  constructor(
    spawnPos: THREE.Vector3,
    scene: THREE.Scene,
    assets: AssetManager,
    audio: AudioManager
  ) {
    this.assets = assets;
    this.audio = audio;

    this.group = this.assets.cloneModel('dog_shepherd');
    this.group.position.copy(spawnPos);
    scene.add(this.group);

    const clips = this.assets.getClips('dog_shepherd');
    if (clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.group);
      for (const clip of clips) {
        const lower = clip.name.toLowerCase();
        const act = this.mixer.clipAction(clip);
        if (lower.includes('idle')) this.actions['idle'] = act;
        else if (lower.includes('run') || lower.includes('gallop')) this.actions['run'] = act;
        else if (lower.includes('walk')) this.actions['walk'] = act;
        else if (lower.includes('attack') || lower.includes('bite')) this.actions['attack'] = act;
      }
      this.playAnim('idle');
    }
  }

  public recruit(): void {
    if (this.recruited) return;
    this.recruited = true;
    this.audio.playPositional('dog_bark', this.group.position, 0.85, 0.05);
  }

  private playAnim(name: string): void {
    if (!this.mixer) return;
    const act = this.actions[name] ?? this.actions['walk'] ?? this.actions['idle'];
    if (!act || this.currentAnim === name) return;
    const prev = this.actions[this.currentAnim];
    if (prev && prev !== act) prev.fadeOut(0.15);
    act.reset().fadeIn(0.15).play();
    this.currentAnim = name;
  }

  public update(dt: number, playerPos: THREE.Vector3, zombieManager: ZombieManager): void {
    if (this.mixer) this.mixer.update(dt);
    this.barkCooldown = Math.max(0, this.barkCooldown - dt);
    this.pinCooldown = Math.max(0, this.pinCooldown - dt);
    this.alertTimer = Math.max(0, this.alertTimer - dt);

    if (!this.recruited) {
      this.playAnim('idle');
      return;
    }

    // Check for nearby zombies to warn player & optionally pin lone zombie
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

    if (nearestZ && this.barkCooldown <= 0) {
      this.barkCooldown = 5.5;
      this.alertTimer = 2.5;
      this.audio.playPositional('dog_bark', this.group.position, 0.8, 0.08);
    }

    // Pin lone zombie if close and off cooldown
    if (nearestZ && nearestDist < 10 && this.pinCooldown <= 0) {
      const distDogToZ = this.group.position.distanceTo(nearestZ.group.position);
      if (distDogToZ > 1.3) {
        const dir = nearestZ.group.position.clone().sub(this.group.position).setY(0).normalize();
        this.group.position.addScaledVector(dir, 7.2 * dt);
        this.group.rotation.y = Math.atan2(dir.x, dir.z);
        this.playAnim('run');
      } else {
        zombieManager.pinZombie(nearestZ, 3.0);
        this.pinCooldown = 9.0;
        this.audio.playPositional('dog_bark', this.group.position, 0.9, 0.05);
        this.playAnim('attack');
      }
      return;
    }

    // Follow player at heel offset
    const target = playerPos.clone().add(new THREE.Vector3(-1.6, 0, -1.2));
    const diff = target.sub(this.group.position);
    diff.y = 0;
    const dist = diff.length();

    if (dist > 1.8) {
      diff.normalize();
      const speed = dist > 6 ? 7.5 : 4.8;
      this.group.position.addScaledVector(diff, speed * dt);
      this.group.rotation.y = Math.atan2(diff.x, diff.z);
      this.playAnim(dist > 6 ? 'run' : 'walk');
    } else {
      this.playAnim('idle');
    }
  }
}
