import * as THREE from 'three';
import { AssetManager } from './AssetManager';

export type SoundEmissionListener = (origin: THREE.Vector3, radius: number) => void;
export type HitFeedback = 'hit' | 'head' | 'kill';
export type Surface = 'concrete' | 'grass' | 'wood';

export interface LoopHandle {
  setVolume(v: number, smoothing?: number): void;
  setPosition(p: THREE.Vector3): void;
  setRate(r: number): void;
  stop(fade?: number): void;
}

const MUSIC_DIR = '/assets/music/JDSherbert - Ambiences Music Pack - ';
/**
 * Tracks chosen by measured character (onset density / loudness), gains normalise each track to
 * about -21 LUFS so crossfades don't jump in level.
 */
const MUSIC = {
  title: { file: 'Frost Mountain Aura.ogg', gain: 0.67 },
  day: { file: 'Dark Dark Woods.ogg', gain: 1.58 },
  night: { file: 'Bloodrat Sewers.ogg', gain: 1.46 },
  combat: { file: 'Tiger Temple Trial.ogg', gain: 0.85 },
  siege: { file: 'Swamp of Digeridoos.ogg', gain: 0.46 },
  jukebox: { file: 'Junction Jazz.ogg', gain: 0.8 },
} as const;
type MusicLayer = 'title' | 'day' | 'night' | 'combat' | 'siege';

/** Randomised alternatives for one-shots, so repeated sounds don't machine-gun the same sample. */
const VARIANTS: Record<string, string[]> = {
  gun_pistol: ['gun_pistol', 'gun_pistol2'],
  gun_smg: ['gun_smg', 'gun_smg2'],
  gun_rifle: ['gun_rifle', 'gun_rifle2'],
  gun_shotgun: ['gun_shotgun', 'gun_shotgun2', 'gun_shotgun3'],
  casing: ['casing1', 'casing2', 'casing3'],
  melee_swing: ['melee_swing', 'melee_swing2'],
  impact_flesh: ['impact_flesh1', 'impact_flesh2'],
  impact_metal: ['impact_metal', 'impact_metal2'],
  impact_concrete: ['impact_concrete', 'impact_concrete2'],
  zombie_groan: ['zombie_groan1', 'zombie_groan2', 'zombie_groan3'],
  zombie_hurt: ['zombie_hurt1', 'zombie_hurt2', 'zombie_hurt3'],
  zombie_shriek: ['zombie_shriek1', 'zombie_shriek2'],
  brute_grunt: ['brute_grunt1', 'brute_grunt2'],
  step_concrete: ['step_concrete1', 'step_concrete2', 'step_concrete3', 'step_concrete4'],
  step_grass: ['step_grass1', 'step_grass2', 'step_grass3'],
  step_wood: ['step_wood1', 'step_wood2', 'step_wood3', 'step_wood4'],
};

/**
 * Audio graph:
 *   sfx / music / ambience buses ──┐
 *   reverb send ─> convolver ──────┴─> listener.gain (master) -> muffle low-pass -> compressor -> out
 *
 * One-shots are raw AudioBufferSourceNodes that disconnect themselves on end, so nothing
 * accumulates in the graph over a long session.
 */
export class AudioManager {
  public readonly listener = new THREE.AudioListener();
  private assets: AssetManager;
  private ctx: AudioContext;

  private sfxBus: GainNode;
  private musicBus: GainNode;
  private ambienceBus: GainNode;
  private reverbBus: GainNode;
  private muffle: BiquadFilterNode;
  private compressor: DynamicsCompressorNode;

  private music = new Map<MusicLayer, { el: HTMLAudioElement; gain: GainNode; base: number }>();
  private musicWeights: Record<MusicLayer, number> = { title: 0, day: 0, night: 0, combat: 0, siege: 0 };
  private titleStarted = false;
  private gameMusicStarted = false;
  private nightAmount = 0;
  private combatAmount = 0;
  private combatTarget = 0;
  private siege = false;

  private wind: LoopHandle | null = null;
  private crickets: LoopHandle | null = null;
  private eerie: LoopHandle | null = null;
  private rain: LoopHandle | null = null;
  private rainAmount = 0;

  private masterVolume = 0.8;
  private muted = false;
  private muffleAmount = 0;
  private muffleTarget = 0;

  private heartbeatIntensity = 0;
  private heartbeatTimer = 0;
  private ambientEventTimer = 10;
  private listenerPos = new THREE.Vector3();

  private noiseBuffer: AudioBuffer;
  private soundListeners: SoundEmissionListener[] = [];

  constructor(assets: AssetManager) {
    this.assets = assets;
    this.ctx = this.listener.context;

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

    this.sfxBus = this.makeBus(0.8);
    this.musicBus = this.makeBus(0.3);
    this.ambienceBus = this.makeBus(1);

    // Street-echo reverb: procedural impulse response (decaying, darkening noise)
    this.reverbBus = this.ctx.createGain();
    this.reverbBus.gain.value = 0.55;
    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.makeImpulse(2.6, 2.8);
    this.reverbBus.connect(convolver).connect(this.listener.getInput());

    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Browsers only allow audio after a gesture; unlock + start the title theme on the first one.
    const unlock = () => {
      this.resume();
      this.startTitleMusic();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private makeBus(gain: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.listener.getInput());
    return g;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // one-pole low-pass that closes over time = high frequencies die first, like open air
        const k = 0.6 - 0.5 * t;
        lp = lp + k * ((Math.random() * 2 - 1) - lp);
        const early = i < rate * 0.09 && Math.random() < 0.004 ? 2.5 : 1; // a few slap-back reflections
        d[i] = lp * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  }

  public attachToCamera(camera: THREE.Camera): void {
    camera.add(this.listener);
  }

  public resume(): void {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  public onSoundEmitted(cb: SoundEmissionListener): void {
    this.soundListeners.push(cb);
  }

  public emitNoise(origin: THREE.Vector3, radius: number): void {
    for (const cb of this.soundListeners) cb(origin, radius);
  }

  // ───────────────────────────── Music ─────────────────────────────

  private ensureTrack(layer: MusicLayer): void {
    if (this.music.has(layer)) return;
    const spec = MUSIC[layer];
    const el = new Audio(MUSIC_DIR + spec.file);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    try {
      this.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(this.musicBus);
    } catch {
      /* element will play directly */
    }
    el.play().catch(() => {});
    this.music.set(layer, { el, gain, base: spec.gain });
  }

  public startTitleMusic(): void {
    if (this.titleStarted || this.gameMusicStarted) return;
    this.titleStarted = true;
    this.ensureTrack('title');
    this.musicWeights.title = 1;
  }

  public startMusic(): void {
    this.resume();
    if (this.gameMusicStarted) return;
    this.gameMusicStarted = true;
    for (const layer of ['day', 'night', 'combat', 'siege'] as MusicLayer[]) this.ensureTrack(layer);
    this.musicWeights.title = 0;
    this.startAmbience();
  }

  /** night: 0 day … 1 night; combat: 0 calm … 1 hunted; siege: extraction holdout. */
  public setMusicState(night: number, combat: number, siege: boolean): void {
    this.nightAmount = THREE.MathUtils.clamp(night, 0, 1);
    this.combatTarget = THREE.MathUtils.clamp(combat, 0, 1);
    this.siege = siege;
  }

  // ───────────────────────────── Ambience & loops ─────────────────────────────

  private startAmbience(): void {
    this.wind = this.createLoop('loop_wind', null, 0, 1, this.ambienceBus);
    this.crickets = this.createLoop('loop_crickets', null, 0, 1, this.ambienceBus);
    this.eerie = this.createLoop('loop_eerie', null, 0, 1, this.ambienceBus);
    this.rain = this.createLoop('loop_rain', null, 0, 1, this.ambienceBus);
  }

  /** Looping sample, optionally positioned in the world. Returns a handle to control/stop it. */
  public createLoop(
    key: string,
    position: THREE.Vector3 | null,
    volume: number,
    refDistance = 6,
    bus: GainNode = this.sfxBus
  ): LoopHandle {
    const buf = this.assets.getAudioBuffer(key);
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    let panner: PannerNode | null = null;
    if (position) {
      panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = refDistance;
      panner.maxDistance = 80;
      panner.rolloffFactor = 1.3;
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
      gain.connect(panner).connect(bus);
    } else {
      gain.connect(bus);
    }
    let src: AudioBufferSourceNode | null = null;
    if (buf) {
      src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start(0, Math.random() * buf.duration);
    }
    let stopped = false;
    return {
      setVolume: (v, smoothing = 0.3) => {
        if (!stopped) gain.gain.setTargetAtTime(v, this.ctx.currentTime, smoothing);
      },
      setPosition: (p) => {
        if (!panner) return;
        panner.positionX.value = p.x;
        panner.positionY.value = p.y;
        panner.positionZ.value = p.z;
      },
      setRate: (r) => {
        if (src) src.playbackRate.value = r;
      },
      stop: (fade = 0.4) => {
        if (stopped) return;
        stopped = true;
        gain.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
        setTimeout(() => {
          src?.stop();
          src?.disconnect();
          gain.disconnect();
          panner?.disconnect();
        }, fade * 1000 + 100);
      },
    };
  }

  /** In-world music source (the diner jukebox): muffled, positional, with record crackle. */
  public createJukebox(position: THREE.Vector3): void {
    const el = new Audio(MUSIC_DIR + MUSIC.jukebox.file);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180; // tinny old speaker
    const gain = this.ctx.createGain();
    gain.gain.value = MUSIC.jukebox.gain * 0.9;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 3;
    panner.rolloffFactor = 1.6;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    try {
      this.ctx.createMediaElementSource(el).connect(hp).connect(lp).connect(gain).connect(panner).connect(this.sfxBus);
    } catch {
      return;
    }
    el.play().catch(() => {});
    this.createLoop('loop_record', position, 0.25, 2.5);
  }

  public setWeather(rain: number): void {
    this.rainAmount = THREE.MathUtils.clamp(rain, 0, 1);
  }

  public playThunder(distance: number): void {
    // Closer strikes are louder, brighter and arrive sooner
    const vol = THREE.MathUtils.clamp(1.2 - distance / 120, 0.25, 1);
    setTimeout(() => this.playUI('thunder', vol, 0.9 + Math.random() * 0.2, 0.6), (distance / 343) * 1000);
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
  }

  public setMuffle(amount: number): void {
    this.muffleTarget = THREE.MathUtils.clamp(amount, 0, 1);
  }

  public setHeartbeat(intensity: number): void {
    this.heartbeatIntensity = THREE.MathUtils.clamp(intensity, 0, 1);
  }

  // ───────────────────────────── Per-frame ─────────────────────────────

  public update(dt: number, isNight = false, listenerPos?: THREE.Vector3): void {
    const now = this.ctx.currentTime;
    if (listenerPos) this.listenerPos.copy(listenerPos);

    // Music mix
    this.combatAmount += (this.combatTarget - this.combatAmount) * Math.min(1, dt * (this.combatTarget > this.combatAmount ? 1.5 : 0.35));
    const w = this.musicWeights;
    if (this.gameMusicStarted) {
      w.title = 0;
      if (this.siege) {
        w.siege = 1;
        w.day = w.night = w.combat = 0;
      } else {
        const base = 1 - 0.65 * this.combatAmount;
        w.day = (1 - this.nightAmount) * base;
        w.night = this.nightAmount * base;
        w.combat = this.combatAmount;
        w.siege = 0;
      }
    }
    for (const [layer, track] of this.music) {
      track.gain.gain.setTargetAtTime(w[layer] * track.base, now, layer === 'combat' ? 0.4 : 1.2);
    }

    // Ambience beds
    const r = this.rainAmount;
    this.wind?.setVolume((0.14 + 0.1 * this.nightAmount + 0.12 * r) * 0.9, 1.5);
    this.crickets?.setVolume(0.1 * this.nightAmount * (1 - r), 2);
    this.eerie?.setVolume(0.16 * this.nightAmount, 2);
    this.rain?.setVolume(0.45 * r, 1.5);

    this.muffleAmount = THREE.MathUtils.lerp(this.muffleAmount, this.muffleTarget, Math.min(1, dt * 4));
    this.muffle.frequency.setTargetAtTime(20000 * Math.pow(700 / 20000, this.muffleAmount), now, 0.05);

    // Sampled heartbeat at low health
    if (this.heartbeatIntensity > 0.01) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 1.1 - this.heartbeatIntensity * 0.5;
        this.playUI('heartbeat', 0.35 + 0.5 * this.heartbeatIntensity, 0.9 + this.heartbeatIntensity * 0.25);
      }
    } else {
      this.heartbeatTimer = 0;
    }

    // Distant life (and death) of the city
    if (this.gameMusicStarted) {
      this.ambientEventTimer -= dt;
      if (this.ambientEventTimer <= 0) {
        this.ambientEventTimer = 14 + Math.random() * 22;
        this.playDistantEvent(isNight);
      }
    }
  }

  private playDistantEvent(isNight: boolean): void {
    const pool = isNight
      ? [
          ['scream_distant', 0.55, 1],
          ['zombie_roar', 0.7, 0.75],
          ['explosion_distant', 0.8, 1],
          ['zombie_groan', 0.7, 0.7],
        ]
      : [
          ['raven', 0.5, 1],
          ['raven', 0.5, 1.1],
          ['explosion_distant', 0.6, 1],
          ['zombie_groan', 0.5, 0.8],
        ];
    const [key, vol, rate] = pool[Math.floor(Math.random() * pool.length)] as [string, number, number];
    const a = Math.random() * Math.PI * 2;
    const pos = this.listenerPos.clone().add(new THREE.Vector3(Math.cos(a) * 30, 3, Math.sin(a) * 30));
    this.playPositional(key, pos, vol, 0.05, 18, 0.8, rate);
  }

  // ───────────────────────────── One-shots ─────────────────────────────

  private resolve(key: string): string {
    const v = VARIANTS[key];
    return v ? v[Math.floor(Math.random() * v.length)] : key;
  }

  private playBuffer(key: string, volume: number, rate: number, dest: AudioNode, reverb: number): void {
    if (this.muted) return;
    const buf = this.assets.getAudioBuffer(this.resolve(key));
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(dest);
    let send: GainNode | null = null;
    if (reverb > 0) {
      send = this.ctx.createGain();
      send.gain.value = reverb * volume;
      src.connect(send).connect(this.reverbBus);
    }
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      send?.disconnect();
      if (dest !== this.sfxBus) dest.disconnect();
    };
    src.start();
  }

  public playUI(key: string, volume = 0.45, rate = 1, reverb = 0): void {
    this.playBuffer(key, volume, rate, this.sfxBus, reverb);
  }

  public playPositional(
    key: string,
    position: THREE.Vector3,
    volume = 0.8,
    pitchJitter = 0.08,
    refDistance = 8,
    reverb = 0,
    rate = 1
  ): void {
    if (this.muted) return;
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
    this.playBuffer(key, volume, rate * (1 + (Math.random() * 2 - 1) * pitchJitter), panner, reverb);
  }

  public playFootstep(surface: Surface, volume: number, heavy = false): void {
    const key = surface === 'grass' ? 'step_grass' : surface === 'wood' ? 'step_wood' : 'step_concrete';
    const vol = surface === 'grass' ? volume * 0.8 : volume;
    this.playUI(key, vol, (heavy ? 0.85 : 0.95) + Math.random() * 0.12);
  }

  // ───────────────────────────── Synthesised feedback ─────────────────────────────

  private envTone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
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
    const send = this.ctx.createGain();
    send.gain.value = 0.9;
    lp.connect(out).connect(this.ambienceBus);
    lp.connect(send).connect(this.reverbBus);
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
      send.disconnect();
      out.disconnect();
    }, (dur + 3) * 1000);
  }

  public playHitFeedback(kind: HitFeedback): void {
    if (kind === 'hit') {
      this.envTone('triangle', 1500, 1100, 0.05, 0.1);
    } else if (kind === 'head') {
      this.envTone('triangle', 2300, 1900, 0.07, 0.14);
      this.envTone('sine', 3400, 3000, 0.09, 0.07, 0.02);
    } else {
      this.envTone('square', 320, 110, 0.13, 0.06);
      this.envTone('triangle', 1700, 1200, 0.06, 0.11);
    }
  }

  public playDryFire(): void {
    this.playUI('gun_empty', 0.5, 1 + Math.random() * 0.1);
  }

  public playHurt(): void {
    this.playUI('player_hurt1', 0.6, 0.9 + Math.random() * 0.2);
    this.playUI('zombie_bite', 0.45, 0.9 + Math.random() * 0.2);
  }

  public playObjectiveChime(): void {
    this.playUI('objective_pickup', 0.6);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.envTone('triangle', f, f, 0.35, 0.06, 0.05 + i * 0.09));
  }

  public playDefeatSting(): void {
    this.playUI('ui_game_over', 0.7);
  }

  public playVictorySting(): void {
    this.playUI('ui_complete', 0.7);
  }
}
