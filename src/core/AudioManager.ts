import * as THREE from 'three';
import { AssetManager } from './AssetManager';

export type SoundEmissionListener = (origin: THREE.Vector3, radius: number) => void;
export type HitFeedback = 'hit' | 'head' | 'kill';

const MUSIC_DAY = '/assets/music/JDSherbert - Ambiences Music Pack - Dark Dark Woods.ogg';
const MUSIC_NIGHT = '/assets/music/JDSherbert - Ambiences Music Pack - Bloodrat Sewers.ogg';

/**
 * Audio graph:
 *   sfx / music / ambience buses -> listener.gain (master volume)
 *     -> muffle low-pass (low health / pause) -> compressor -> destination
 *
 * One-shots are raw AudioBufferSourceNodes that disconnect themselves on end,
 * so nothing accumulates in the graph over a long session.
 */
export class AudioManager {
  public readonly listener = new THREE.AudioListener();
  private assets: AssetManager;
  private ctx: AudioContext;

  private sfxBus: GainNode;
  private musicBus: GainNode;
  private ambienceBus: GainNode;
  private muffle: BiquadFilterNode;
  private compressor: DynamicsCompressorNode;

  private dayMusic: HTMLAudioElement | null = null;
  private nightMusic: HTMLAudioElement | null = null;
  private dayGain: GainNode | null = null;
  private nightGain: GainNode | null = null;
  private targetTension = 0; // 0 = day/exploration, 1 = night/horde
  private currentTension = 0;
  private musicStarted = false;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer;

  private masterVolume = 0.8;
  private muted = false;
  private muffleAmount = 0;
  private muffleTarget = 0;

  private heartbeatIntensity = 0;
  private heartbeatTimer = 0;

  private soundListeners: SoundEmissionListener[] = [];

  constructor(assets: AssetManager) {
    this.assets = assets;
    this.ctx = this.listener.context;

    // Re-route the listener's master gain through a muffle filter + compressor.
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.7;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.2;
    this.listener.gain.disconnect();
    this.listener.gain.connect(this.muffle);
    this.muffle.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);
    this.listener.setMasterVolume(this.masterVolume);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.75;
    this.sfxBus.connect(this.listener.getInput());
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.32;
    this.musicBus.connect(this.listener.getInput());
    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.gain.value = 1;
    this.ambienceBus.connect(this.listener.getInput());

    // 2 seconds of white noise shared by wind, dry-fire and impact synths
    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  public attachToCamera(camera: THREE.Camera): void {
    camera.add(this.listener);
  }

  /** Must be called from a user gesture (click / key) to unlock audio. */
  public resume(): void {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public onSoundEmitted(cb: SoundEmissionListener): void {
    this.soundListeners.push(cb);
  }

  public emitNoise(origin: THREE.Vector3, radius: number): void {
    for (const cb of this.soundListeners) {
      cb(origin, radius);
    }
  }

  // ───────────────────────────── Music & ambience ─────────────────────────────

  public startMusic(): void {
    this.resume();
    if (this.musicStarted) return;
    this.musicStarted = true;

    const makeTrack = (url: string): [HTMLAudioElement, GainNode] => {
      const el = new Audio(url);
      el.loop = true;
      el.crossOrigin = 'anonymous';
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      try {
        this.ctx.createMediaElementSource(el).connect(gain);
        gain.connect(this.musicBus);
      } catch {
        // Fallback: element plays directly (volume driven in update)
      }
      el.play().catch(() => {});
      return [el, gain];
    };

    [this.dayMusic, this.dayGain] = makeTrack(MUSIC_DAY);
    [this.nightMusic, this.nightGain] = makeTrack(MUSIC_NIGHT);
    this.startWind();
  }

  private startWind(): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.55;
    // Slow LFO sweeps the filter for gusts
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(filter.frequency);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime + 3);
    src.connect(filter).connect(gain).connect(this.ambienceBus);
    src.start();
    lfo.start();
    this.windGain = gain;
    this.windFilter = filter;
  }

  public setTension(tension: number): void {
    this.targetTension = THREE.MathUtils.clamp(tension, 0, 1);
  }

  /** The "Blood Siren": a distant air-raid siren that wails at nightfall. */
  public playSiren(): void {
    if (this.muted) return;
    const t0 = this.ctx.currentTime + 0.05;
    const dur = 7.5;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(0.11, t0 + 0.8);
    out.gain.setValueAtTime(0.11, t0 + dur - 1.5);
    out.gain.linearRampToValueAtTime(0, t0 + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    // Distance echo
    const delay = this.ctx.createDelay(1);
    delay.delayTime.value = 0.32;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.35;
    delay.connect(fb).connect(delay);
    lp.connect(out);
    lp.connect(delay);
    delay.connect(out);
    out.connect(this.ambienceBus);

    for (const detune of [0, 7]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detune;
      const f = osc.frequency;
      f.setValueAtTime(330, t0);
      for (let c = 0; c < 3; c++) {
        const s = t0 + c * 2.4;
        f.linearRampToValueAtTime(820, s + 1.3);
        f.linearRampToValueAtTime(360, s + 2.4);
      }
      osc.connect(lp);
      osc.start(t0);
      osc.stop(t0 + dur);
      osc.onended = () => osc.disconnect();
    }
    setTimeout(() => {
      lp.disconnect();
      delay.disconnect();
      fb.disconnect();
      out.disconnect();
    }, (dur + 2) * 1000);
  }

  // ───────────────────────────── Settings ─────────────────────────────

  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterVolume();
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMasterVolume(v: number): void {
    this.masterVolume = THREE.MathUtils.clamp(v, 0, 1);
    this.applyMasterVolume();
  }

  public getMasterVolume(): number {
    return this.masterVolume;
  }

  private applyMasterVolume(): void {
    this.listener.gain.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.ctx.currentTime, 0.05);
    if (this.dayMusic && !this.dayGain) this.dayMusic.muted = this.muted;
    if (this.nightMusic && !this.nightGain) this.nightMusic.muted = this.muted;
  }

  /** 0 = clear, 1 = heavily muffled (low health / paused). */
  public setMuffle(amount: number): void {
    this.muffleTarget = THREE.MathUtils.clamp(amount, 0, 1);
  }

  /** 0 = off, 1 = pounding (near death). */
  public setHeartbeat(intensity: number): void {
    this.heartbeatIntensity = THREE.MathUtils.clamp(intensity, 0, 1);
  }

  public update(dt: number, isNight = false): void {
    this.currentTension = THREE.MathUtils.lerp(this.currentTension, this.targetTension, Math.min(1, dt * 1.2));
    const now = this.ctx.currentTime;
    if (this.dayGain && this.nightGain) {
      this.dayGain.gain.setTargetAtTime(1 - this.currentTension, now, 0.1);
      this.nightGain.gain.setTargetAtTime(1.15 * this.currentTension, now, 0.1);
    }

    if (this.windGain && this.windFilter) {
      this.windGain.gain.setTargetAtTime(isNight ? 0.085 : 0.05, now, 1.5);
    }

    this.muffleAmount = THREE.MathUtils.lerp(this.muffleAmount, this.muffleTarget, Math.min(1, dt * 4));
    const freq = 20000 * Math.pow(700 / 20000, this.muffleAmount);
    this.muffle.frequency.setTargetAtTime(freq, now, 0.05);

    if (this.heartbeatIntensity > 0.01) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 1.15 - this.heartbeatIntensity * 0.55;
        this.thump(0, 0.55 * this.heartbeatIntensity);
        this.thump(0.17, 0.4 * this.heartbeatIntensity);
      }
    } else {
      this.heartbeatTimer = 0;
    }
  }

  // ───────────────────────────── One-shots ─────────────────────────────

  private playBuffer(key: string, volume: number, rate: number, dest: AudioNode): void {
    if (this.muted) return;
    const buf = this.assets.getAudioBuffer(key);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(dest);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      if (dest !== this.sfxBus) dest.disconnect();
    };
    src.start();
  }

  public playUI(key: string, volume = 0.45, rate = 1): void {
    this.playBuffer(key, volume, rate, this.sfxBus);
  }

  public playPositional(
    key: string,
    position: THREE.Vector3,
    volume = 0.8,
    pitchJitter = 0.08,
    refDistance = 8
  ): void {
    if (this.muted || !this.assets.getAudioBuffer(key)) return;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = 90;
    panner.rolloffFactor = 1.2;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y + 1;
    panner.positionZ.value = position.z;
    panner.connect(this.sfxBus);
    const rate = 1 + (Math.random() * 2 - 1) * pitchJitter;
    this.playBuffer(key, volume, rate, panner);
  }

  // ───────────────────────────── Synthesised feedback ─────────────────────────────

  private envTone(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    vol: number,
    delay = 0
  ): void {
    if (this.muted) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  private noiseBurst(dur: number, vol: number, hp: number, delay = 0): void {
    if (this.muted) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  private thump(delay: number, vol: number): void {
    this.envTone('sine', 68, 38, 0.16, vol, delay);
  }

  public playHitFeedback(kind: HitFeedback): void {
    if (kind === 'hit') {
      this.envTone('triangle', 1500, 1100, 0.05, 0.12);
    } else if (kind === 'head') {
      this.envTone('triangle', 2300, 1900, 0.07, 0.16);
      this.envTone('sine', 3400, 3000, 0.09, 0.08, 0.02);
    } else {
      this.envTone('square', 320, 110, 0.13, 0.07);
      this.envTone('triangle', 1700, 1200, 0.06, 0.12);
    }
  }

  public playDryFire(): void {
    this.noiseBurst(0.035, 0.25, 3000);
    this.envTone('square', 2400, 1800, 0.02, 0.04);
  }

  public playHurt(): void {
    this.playUI('melee_hit', 0.4, 0.72);
    this.noiseBurst(0.12, 0.12, 200);
  }

  /** Rising arpeggio for objectives / extraction progress. */
  public playObjectiveChime(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.envTone('triangle', f, f, 0.35, 0.09, i * 0.09));
  }

  public playDefeatSting(): void {
    [220, 196, 174.6, 130.8].forEach((f, i) => this.envTone('sawtooth', f, f * 0.98, 0.7, 0.05, i * 0.22));
  }
}
