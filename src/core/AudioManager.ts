import * as THREE from 'three';
import { AssetManager } from './AssetManager';

export type SoundEmissionListener = (origin: THREE.Vector3, radius: number) => void;

export class AudioManager {
  public readonly listener = new THREE.AudioListener();
  private assets: AssetManager;
  private scene: THREE.Scene;

  private dayMusic: HTMLAudioElement | null = null;
  private nightMusic: HTMLAudioElement | null = null;
  private targetTension = 0; // 0 = day/exploration, 1 = night/horde
  private currentTension = 0;
  private musicVolume = 0.28;
  private sfxVolume = 0.65;
  private muted = false;
  private musicStarted = false;

  private soundListeners: SoundEmissionListener[] = [];

  constructor(assets: AssetManager, scene: THREE.Scene) {
    this.assets = assets;
    this.scene = scene;
  }

  public attachToCamera(camera: THREE.Camera): void {
    camera.add(this.listener);
  }

  public onSoundEmitted(cb: SoundEmissionListener): void {
    this.soundListeners.push(cb);
  }

  public emitNoise(origin: THREE.Vector3, radius: number): void {
    for (const cb of this.soundListeners) {
      cb(origin, radius);
    }
  }

  public startMusic(): void {
    if (this.musicStarted) return;
    this.musicStarted = true;

    if (this.listener.context.state === 'suspended') {
      this.listener.context.resume().catch(() => {});
    }

    this.dayMusic = new Audio('/assets/music/JDSherbert - Ambiences Music Pack - Dark Dark Woods.ogg');
    this.dayMusic.loop = true;
    this.dayMusic.volume = this.muted ? 0 : this.musicVolume;

    this.nightMusic = new Audio('/assets/music/JDSherbert - Ambiences Music Pack - Bloodrat Sewers.ogg');
    this.nightMusic.loop = true;
    this.nightMusic.volume = 0;

    this.dayMusic.play().catch(() => {});
    this.nightMusic.play().catch(() => {});
  }

  public setTension(tension: number): void {
    this.targetTension = THREE.MathUtils.clamp(tension, 0, 1);
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.dayMusic && this.nightMusic) {
      if (muted) {
        this.dayMusic.volume = 0;
        this.nightMusic.volume = 0;
      }
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public update(dt: number): void {
    if (!this.dayMusic || !this.nightMusic) return;
    this.currentTension = THREE.MathUtils.lerp(this.currentTension, this.targetTension, Math.min(1, dt * 1.2));

    if (this.muted) {
      this.dayMusic.volume = 0;
      this.nightMusic.volume = 0;
      return;
    }

    this.dayMusic.volume = this.musicVolume * (1 - this.currentTension);
    this.nightMusic.volume = this.musicVolume * 1.15 * this.currentTension;
  }

  public playUI(key: string, volume = 0.45): void {
    if (this.muted) return;
    const buf = this.assets.getAudioBuffer(key);
    if (!buf) return;
    const audio = new THREE.Audio(this.listener);
    audio.setBuffer(buf);
    audio.setVolume(volume * this.sfxVolume);
    audio.play();
  }

  public playPositional(
    key: string,
    position: THREE.Vector3,
    volume = 0.8,
    pitchJitter = 0.08,
    refDistance = 8
  ): void {
    if (this.muted) return;
    const buf = this.assets.getAudioBuffer(key);
    if (!buf) return;

    const anchor = new THREE.Object3D();
    anchor.position.copy(position);
    this.scene.add(anchor);

    const sound = new THREE.PositionalAudio(this.listener);
    sound.setBuffer(buf);
    sound.setRefDistance(refDistance);
    sound.setMaxDistance(90);
    sound.setRolloffFactor(1.2);
    sound.setVolume(volume * this.sfxVolume);

    if (pitchJitter > 0) {
      sound.setPlaybackRate(1 + (Math.random() * 2 - 1) * pitchJitter);
    }

    anchor.add(sound);
    sound.play();

    const durationMs = (buf.duration / sound.getPlaybackRate()) * 1000 + 150;
    setTimeout(() => {
      sound.disconnect();
      this.scene.remove(anchor);
    }, durationMs);
  }
}
