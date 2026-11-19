import * as THREE from 'three';
import { AssetManager } from './AssetManager';

export type SoundEmissionListener = (origin: THREE.Vector3, radius: number) => void;
export type HitFeedback = 'hit' | 'head' | 'kill';
export type Surface = 'concrete' | 'grass' | 'wood';
export type AudioBus = 'music' | 'sfx' | 'ambience';

export interface LoopHandle {
  setVolume(v: number, smoothing?: number): void;
  setPosition(p: THREE.Vector3): void;
  setRate(r: number): void;
  stop(fade?: number): void;
}

/** Randomised alternatives for one-shots, paired with a no-repeat shuffle guard. */
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

const MAX_CONCURRENT_ONESHOTS = 36;
// D minor / Phrygian survival palette (Hz)
const MARIMBA_SCALE = [293.66, 311.13, 349.23, 440.0, 466.16, 523.25, 587.33];
const BASS_PATTERN = [73.42, 73.42, 87.31, 73.42, 65.41, 73.42, 98.0, 82.41];

/**
 * Multi-bus mastering audio engine combining loaded SFX with a 100% self-contained procedural
 * Web Audio adaptive soundtrack, procedural SFX fallbacks, and speechSynthesis radio voice comms:
 *
 *   sfxBus ─────────────────────────────────────────┐
 *   musicBus (procedural synth) ──> duckGain ───────┼─> listener.gain (master) -> muffle LP -> compressor -> out
 *   ambienceBus -> indoorLP -> duckGain ────────────┤
 *   reverbBus -> convolver ─────────────────────────┘
 */
export class AudioManager {
  public readonly listener = new THREE.AudioListener();
  private assets: AssetManager;
  private ctx: AudioContext;

  private sfxBus: GainNode;
  private musicBus: GainNode;
  private ambienceBus: GainNode;
  private musicDuck: GainNode;
  private ambienceDuck: GainNode;
  private indoorFilter: BiquadFilterNode;
  private reverbBus: GainNode;
  private muffle: BiquadFilterNode;
  private compressor: DynamicsCompressorNode;

  // Procedural adaptive soundtrack state
  private droneOsc1: OscillatorNode | null = null;
  private droneOsc2: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private titleStarted = false;
  private gameMusicStarted = false;
  private nightAmount = 0;
  private combatAmount = 0;
  private combatTarget = 0;
  private siege = false;
  private beatAccum = 0;
  private stepIndex = 0;
  private marimbaTimer = 1.4;

  // Ambience & active loops
  private wind: LoopHandle | null = null;
  private crickets: LoopHandle | null = null;
  private eerie: LoopHandle | null = null;
  private rain: LoopHandle | null = null;
  private activeLoops: LoopHandle[] = [];
  private rainAmount = 0;

  private masterVolume = 0.8;
  private busVolumes: Record<AudioBus, number> = { music: 0.8, sfx: 0.9, ambience: 0.85 };
  private muted = false;
  private voiceEnabled = true;
  private disposed = false;

  private muffleAmount = 0;
  private muffleTarget = 0;
  private indoorsAmount = 0;
  private indoorsTarget = 0;
  private duckAmount = 0;
  private duckHoldTimer = 0;

  private heartbeatIntensity = 0;
  private heartbeatTimer = 0;
  private ambientEventTimer = 10;
  private listenerPos = new THREE.Vector3();

  private activeOneShots = 0;
  private lastVariant = new Map<string, number>();
  private noiseBuffer: AudioBuffer;
  private soundListeners: SoundEmissionListener[] = [];
  private unlockHandler: () => void;

  constructor(assets: AssetManager) {
    this.assets = assets;
    this.ctx = this.listener.context;

    // Master chain: low-pass muffle (pause / low-health) -> soft-knee mastering compressor/limiter
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.7;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 8;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.18;

    this.listener.gain.disconnect();
    this.listener.gain.connect(this.muffle);
    this.muffle.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);
    this.listener.setMasterVolume(this.masterVolume);

    // Independent Gain Buses + Sidechain Ducking & Indoor Filtering
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.listener.getInput());

    this.musicDuck = this.ctx.createGain();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.listener.getInput());
    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.musicDuck);

    this.indoorFilter = this.ctx.createBiquadFilter();
    this.indoorFilter.type = 'lowpass';
    this.indoorFilter.frequency.value = 18000;
    this.indoorFilter.Q.value = 0.6;
    this.ambienceDuck = this.ctx.createGain();
    this.ambienceDuck.gain.value = 1;
    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.connect(this.indoorFilter).connect(this.ambienceDuck).connect(this.listener.getInput());

    this.applyBusVolumes();

    // Street-echo reverb: procedural impulse response (decaying, darkening reflections)
    this.reverbBus = this.ctx.createGain();
    this.reverbBus.gain.value = 0.48;
    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.makeImpulse(2.4, 2.8);
    this.reverbBus.connect(convolver).connect(this.listener.getInput());

    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.unlockHandler = () => {
      if (this.disposed) return;
      this.resume();
      this.startTitleMusic();
      window.removeEventListener('pointerdown', this.unlockHandler);
      window.removeEventListener('keydown', this.unlockHandler);
    };
    window.addEventListener('pointerdown', this.unlockHandler);
    window.addEventListener('keydown', this.unlockHandler);
  }

  public dispose(): void {
    this.disposed = true;
    this.stopSpeech();
    window.removeEventListener('pointerdown', this.unlockHandler);
    window.removeEventListener('keydown', this.unlockHandler);
    for (const loop of this.activeLoops) loop.stop(0.05);
    this.activeLoops = [];
    try {
      this.droneOsc1?.stop();
      this.droneOsc2?.stop();
    } catch {
      /* already stopped */
    }
    this.droneOsc1?.disconnect();
    this.droneOsc2?.disconnect();
    this.droneFilter?.disconnect();
    this.droneGain?.disconnect();
    this.listener.setMasterVolume(0);
  }

  private applyBusVolumes(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(0.85 * this.busVolumes.sfx, now, 0.04);
    this.musicBus.gain.setTargetAtTime(0.55 * this.busVolumes.music, now, 0.04);
    this.ambienceBus.gain.setTargetAtTime(0.95 * this.busVolumes.ambience, now, 0.04);
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
        const k = 0.6 - 0.5 * t;
        lp = lp + k * ((Math.random() * 2 - 1) - lp);
        const early = i < rate * 0.09 && Math.random() < 0.004 ? 2.5 : 1;
        d[i] = lp * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  }

  public attachToCamera(camera: THREE.Camera): void {
    camera.add(this.listener);
  }

  public resume(): void {
    if (this.disposed) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  public onSoundEmitted(cb: SoundEmissionListener): void {
    this.soundListeners.push(cb);
  }

  public emitNoise(origin: THREE.Vector3, radius: number): void {
    for (const cb of this.soundListeners) cb(origin, radius);
  }

  /** Smoothly ducks music & ambience buses so dialogue, sirens, and blasts cut through clearly. */
  public duck(amount: number, holdSeconds = 1.2): void {
    this.duckAmount = Math.max(this.duckAmount, THREE.MathUtils.clamp(amount, 0, 0.85));
    this.duckHoldTimer = Math.max(this.duckHoldTimer, holdSeconds);
  }

  /** Adapts exterior ambience & street reverb when entering/exiting buildings. */
  public setIndoors(indoors: boolean): void {
    this.indoorsTarget = indoors ? 1 : 0;
  }

  // ───────────────────────────── Procedural Adaptive Soundtrack ─────────────────────────────

  private initDroneBed(): void {
    if (this.droneOsc1 || this.disposed) return;
    const now = this.ctx.currentTime;
    this.droneFilter = this.ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 260;
    this.droneFilter.Q.value = 1.8;

    this.droneGain = this.ctx.createGain();
    this.droneGain.gain.setValueAtTime(0.0001, now);
    this.droneGain.gain.linearRampToValueAtTime(0.16, now + 2.0);

    this.droneOsc1 = this.ctx.createOscillator();
    this.droneOsc1.type = 'sawtooth';
    this.droneOsc1.frequency.value = 73.42; // D2 dark root

    this.droneOsc2 = this.ctx.createOscillator();
    this.droneOsc2.type = 'triangle';
    this.droneOsc2.frequency.value = 110.0; // A2 fifth harmonic
    this.droneOsc2.detune.value = -9;

    this.droneOsc1.connect(this.droneFilter);
    this.droneOsc2.connect(this.droneFilter);
    this.droneFilter.connect(this.droneGain).connect(this.musicBus);
    this.droneOsc1.start(now);
    this.droneOsc2.start(now);
  }

  public startTitleMusic(): void {
    if (this.titleStarted || this.gameMusicStarted || this.disposed) return;
    this.titleStarted = true;
    this.initDroneBed();
  }

  public startMusic(): void {
    this.resume();
    if (this.gameMusicStarted || this.disposed) return;
    this.gameMusicStarted = true;
    this.initDroneBed();
    this.startAmbience();
  }

  /** night: 0 day ... 1 night; combat: 0 calm ... 1 hunted; siege: extraction holdout. */
  public setMusicState(night: number, combat: number, siege: boolean): void {
    this.nightAmount = THREE.MathUtils.clamp(night, 0, 1);
    this.combatTarget = THREE.MathUtils.clamp(combat, 0, 1);
    this.siege = siege;
  }

  private playSynthNote(
    type: OscillatorType,
    freq: number,
    dur: number,
    vol: number,
    cutoff = 1400,
    dest: AudioNode = this.musicBus,
    reverb = 0.25
  ): void {
    if (this.muted || this.disposed) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(cutoff, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff * 0.28), t + dur);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(flt).connect(g).connect(dest);
    let revSend: GainNode | null = null;
    if (reverb > 0) {
      revSend = this.ctx.createGain();
      revSend.gain.value = reverb * vol;
      g.connect(revSend).connect(this.reverbBus);
    }
    osc.start(t);
    osc.stop(t + dur + 0.03);
    osc.onended = () => {
      osc.disconnect();
      flt.disconnect();
      g.disconnect();
      revSend?.disconnect();
    };
  }

  private playSynthKick(vol: number): void {
    if (this.muted || this.disposed) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, t);
    osc.frequency.exponentialRampToValueAtTime(36, t + 0.14);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.24);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  private playSynthHat(vol: number): void {
    if (this.muted || this.disposed) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    src.connect(hp).connect(g).connect(this.musicBus);
    src.start(t, Math.random());
    src.stop(t + 0.07);
    src.onended = () => {
      src.disconnect();
      hp.disconnect();
      g.disconnect();
    };
  }

  private stepProceduralMusic(dt: number): void {
    if ((!this.titleStarted && !this.gameMusicStarted) || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const tension = this.siege ? 1 : Math.max(this.combatAmount, this.nightAmount * 0.45);

    // Evolve drone filter & subtle ominous detune as night / tension rises
    if (this.droneFilter && this.droneGain && this.droneOsc2) {
      const targetCutoff = THREE.MathUtils.lerp(220, 620, tension) + Math.sin(now * 0.35) * 45;
      this.droneFilter.frequency.setTargetAtTime(targetCutoff, now, 0.35);
      this.droneGain.gain.setTargetAtTime(THREE.MathUtils.lerp(0.14, 0.24, tension), now, 0.4);
      // Shift upper drone from calm fifth (A2) toward tense flat-sixth / tritone at night/siege
      const targetHz = this.siege ? 103.83 : THREE.MathUtils.lerp(110.0, 103.83, this.nightAmount);
      this.droneOsc2.frequency.setTargetAtTime(targetHz, now, 1.0);
    }

    // Gentle atmospheric marimba / plucked harmonic pulse during calm exploration & title
    if (tension < 0.72) {
      this.marimbaTimer -= dt;
      if (this.marimbaTimer <= 0) {
        this.marimbaTimer = THREE.MathUtils.lerp(1.9, 1.05, this.nightAmount) + Math.random() * 1.1;
        const note = MARIMBA_SCALE[Math.floor(Math.random() * MARIMBA_SCALE.length)] * (this.nightAmount > 0.5 ? 0.5 : 1);
        this.playSynthNote('triangle', note, 0.85, 0.08 * (1 - tension * 0.65), 1100, this.musicBus, 0.55);
      }
    }

    // Rhythmic sub-bass pulse & industrial percussion during combat / night hunt / siege
    if (this.gameMusicStarted && tension > 0.18) {
      const bpm = this.siege ? 128 : THREE.MathUtils.lerp(88, 116, tension);
      const stepDur = 60 / bpm / 2; // eighth-note grid
      this.beatAccum += dt;
      if (this.beatAccum >= stepDur) {
        this.beatAccum -= stepDur;
        const step = this.stepIndex++ % 8;
        const bassFreq = BASS_PATTERN[step];
        const drive = THREE.MathUtils.clamp((tension - 0.18) / 0.82, 0, 1);

        // Pulsing filtered sub-bass
        this.playSynthNote('sawtooth', bassFreq, stepDur * 0.85, 0.11 * drive, 240 + drive * 460, this.musicBus, 0.1);
        // Kick on downbeats & syncopated siege hits
        if (step === 0 || step === 4 || (this.siege && step === 6)) {
          this.playSynthKick(0.24 * drive);
        }
        // Crisp industrial hat tick during intense combat/siege
        if ((this.siege || this.combatAmount > 0.45) && step % 2 === 1) {
          this.playSynthHat(0.055 * drive);
        }
      }
    }
  }

  // ───────────────────────────── Ambience & Loops ─────────────────────────────

  private startAmbience(): void {
    this.wind = this.createLoop('loop_wind', null, 0, 1, this.ambienceBus);
    this.crickets = this.createLoop('loop_crickets', null, 0, 1, this.ambienceBus);
    this.eerie = this.createLoop('loop_eerie', null, 0, 1, this.ambienceBus);
    this.rain = this.createLoop('loop_rain', null, 0, 1, this.ambienceBus);
  }

  /** Looping sample (with procedural wind/rain fallback if buffer absent). */
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
      panner.maxDistance = 85;
      panner.rolloffFactor = 1.3;
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
      gain.connect(panner).connect(bus);
    } else {
      gain.connect(bus);
    }

    let src: AudioBufferSourceNode | null = null;
    let extraFilter: BiquadFilterNode | null = null;
    if (buf) {
      src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start(0, Math.random() * buf.duration);
    } else if (key === 'loop_wind' || key === 'loop_rain' || key === 'loop_fire') {
      // Procedural filtered noise bed fallback
      src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      extraFilter = this.ctx.createBiquadFilter();
      extraFilter.type = key === 'loop_rain' ? 'bandpass' : 'lowpass';
      extraFilter.frequency.value = key === 'loop_rain' ? 1600 : key === 'loop_fire' ? 420 : 320;
      src.connect(extraFilter).connect(gain);
      src.start(0, Math.random());
    }

    let stopped = false;
    const handle: LoopHandle = {
      setVolume: (v, smoothing = 0.3) => {
        if (!stopped && !this.disposed) gain.gain.setTargetAtTime(v, this.ctx.currentTime, smoothing);
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
        try {
          gain.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.02, fade / 3));
        } catch {
          /* ctx closed */
        }
        setTimeout(() => {
          try {
            src?.stop();
          } catch {
            /* ignore */
          }
          src?.disconnect();
          extraFilter?.disconnect();
          gain.disconnect();
          panner?.disconnect();
        }, fade * 1000 + 80);
      },
    };
    this.activeLoops.push(handle);
    return handle;
  }

  /** In-world diner jukebox: warm crackling record ambience (zero external media fetch aborts). */
  public createJukebox(position: THREE.Vector3): void {
    this.createLoop('loop_record', position, 0.28, 3.0);
  }

  public setWeather(rain: number): void {
    this.rainAmount = THREE.MathUtils.clamp(rain, 0, 1);
  }

  public playThunder(distance: number): void {
    const vol = THREE.MathUtils.clamp(1.2 - distance / 120, 0.25, 1);
    setTimeout(() => {
      if (this.disposed) return;
      this.duck(0.32 * vol, 1.4);
      this.playUI('thunder', vol, 0.88 + Math.random() * 0.22, 0.65);
    }, (distance / 343) * 1000);
  }

  // ───────────────────────────── Captain Reyes Speech Synthesis Radio Comms ─────────────────────────────

  public setVoiceEnabled(enabled: boolean): void {
    this.voiceEnabled = enabled;
    if (!enabled) this.stopSpeech();
  }

  public isVoiceEnabled(): boolean {
    return this.voiceEnabled;
  }

  public stopSpeech(): void {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } catch {
      /* speech API unavailable */
    }
  }

  /** Speaks Captain Reyes's radio line via native Web Speech API with automatic soundtrack ducking & roger beep. */
  public speakRadio(text: string): void {
    if (this.muted || !this.voiceEnabled || this.disposed) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text.replace(/^\.\.\./, ''));
      utter.rate = 1.04;
      utter.pitch = 0.88;
      utter.volume = THREE.MathUtils.clamp(this.masterVolume * this.busVolumes.sfx * 0.85, 0, 1);
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find((v) => /en[-_]US/i.test(v.lang) && /(David|Mark|Guy|Google US English|Alex)/i.test(v.name)) ??
        voices.find((v) => /^en/i.test(v.lang));
      if (preferred) utter.voice = preferred;

      const estSec = Math.max(2.2, text.length * 0.062);
      this.duck(0.55, estSec);
      utter.onend = () => {
        if (!this.disposed && !this.muted) {
          // Crisp radio roger-beep at end of transmission
          this.envTone('sine', 1320, 1320, 0.055, 0.05);
          this.envTone('sine', 980, 980, 0.065, 0.045, 0.065);
        }
      };
      window.speechSynthesis.speak(utter);
    } catch {
      /* ignore speech synthesis errors */
    }
  }

  // ───────────────────────────── Settings ─────────────────────────────

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopSpeech();
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

  public setBusVolume(bus: AudioBus, v: number): void {
    this.busVolumes[bus] = THREE.MathUtils.clamp(v, 0, 1);
    this.applyBusVolumes();
  }

  public getBusVolume(bus: AudioBus): number {
    return this.busVolumes[bus];
  }

  private applyMasterVolume(): void {
    if (this.disposed) return;
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
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    if (listenerPos) this.listenerPos.copy(listenerPos);

    // Sidechain ducking release
    if (this.duckHoldTimer > 0) {
      this.duckHoldTimer -= dt;
    } else if (this.duckAmount > 0.001) {
      this.duckAmount = Math.max(0, this.duckAmount - dt * 0.85);
    }
    this.musicDuck.gain.setTargetAtTime(1 - this.duckAmount * 0.68, now, 0.12);
    this.ambienceDuck.gain.setTargetAtTime(1 - this.duckAmount * 0.45, now, 0.12);

    // Interior acoustic adaptation
    this.indoorsAmount = THREE.MathUtils.lerp(this.indoorsAmount, this.indoorsTarget, Math.min(1, dt * 4.5));
    const indoorCutoff = 18000 * Math.pow(1300 / 18000, this.indoorsAmount);
    this.indoorFilter.frequency.setTargetAtTime(indoorCutoff, now, 0.08);
    this.reverbBus.gain.setTargetAtTime(THREE.MathUtils.lerp(0.52, 0.16, this.indoorsAmount), now, 0.1);

    // Adaptive procedural soundtrack step
    this.combatAmount += (this.combatTarget - this.combatAmount) * Math.min(1, dt * (this.combatTarget > this.combatAmount ? 1.5 : 0.35));
    this.stepProceduralMusic(dt);

    // Ambience beds
    const r = this.rainAmount;
    const extMul = 1 - this.indoorsAmount * 0.42;
    this.wind?.setVolume((0.14 + 0.1 * this.nightAmount + 0.12 * r) * 0.9 * extMul, 1.5);
    this.crickets?.setVolume(0.1 * this.nightAmount * (1 - r) * extMul, 2);
    this.eerie?.setVolume(0.16 * this.nightAmount, 2);
    this.rain?.setVolume(0.45 * r * (1 - this.indoorsAmount * 0.28), 1.5);

    this.muffleAmount = THREE.MathUtils.lerp(this.muffleAmount, this.muffleTarget, Math.min(1, dt * 4));
    this.muffle.frequency.setTargetAtTime(20000 * Math.pow(700 / 20000, this.muffleAmount), now, 0.05);

    // Low-health heartbeat
    if (this.heartbeatIntensity > 0.01) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 1.1 - this.heartbeatIntensity * 0.5;
        this.playUI('heartbeat', 0.35 + 0.5 * this.heartbeatIntensity, 0.9 + this.heartbeatIntensity * 0.25);
      }
    } else {
      this.heartbeatTimer = 0;
    }

    // Distant city life/death cues
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
    const pos = this.listenerPos.clone().add(new THREE.Vector3(Math.cos(a) * 32, 3, Math.sin(a) * 32));
    this.playPositional(key, pos, vol, 0.08, 18, 0.8, rate);
  }

  // ───────────────────────────── One-shots + Procedural Fallbacks ─────────────────────────────

  private resolve(key: string): string {
    const v = VARIANTS[key];
    if (!v || v.length <= 1) return v ? v[0] : key;
    const prev = this.lastVariant.get(key) ?? -1;
    let pick = Math.floor(Math.random() * v.length);
    if (pick === prev) pick = (pick + 1 + Math.floor(Math.random() * (v.length - 1))) % v.length;
    this.lastVariant.set(key, pick);
    return v[pick];
  }

  /** Synthesises a punchy procedural Web Audio fallback if an external buffer isn't loaded. */
  private playProceduralFallback(key: string, volume: number, rate: number, dest: AudioNode): void {
    const t = this.ctx.currentTime;
    const v = volume * 0.45;
    if (key.startsWith('gun_') || key.startsWith('explosion')) {
      const dur = key.startsWith('explosion') ? 0.55 : key.includes('shotgun') || key.includes('sniper') ? 0.24 : 0.13;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(key.startsWith('explosion') ? 850 : 2800 * rate, t);
      flt.frequency.exponentialRampToValueAtTime(140, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt).connect(g).connect(dest);
      src.start(t, Math.random());
      src.stop(t + dur + 0.02);
      src.onended = () => {
        src.disconnect();
        flt.disconnect();
        g.disconnect();
      };
      return;
    }
    this.envTone('triangle', 480 * rate, 180 * rate, 0.09, v * 0.6);
  }

  private playBuffer(
    key: string,
    volume: number,
    rate: number,
    dest: AudioNode,
    reverb: number,
    extraNodes: AudioNode[] = []
  ): void {
    if (this.muted || this.disposed || this.activeOneShots >= MAX_CONCURRENT_ONESHOTS) return;
    const buf = this.assets.getAudioBuffer(this.resolve(key));
    if (!buf) {
      this.playProceduralFallback(key, volume, rate, dest);
      return;
    }
    this.activeOneShots++;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.25, rate);
    const gain = this.ctx.createGain();
    gain.gain.value = volume * (0.93 + Math.random() * 0.14);
    src.connect(gain).connect(dest);

    let send: GainNode | null = null;
    if (reverb > 0) {
      send = this.ctx.createGain();
      send.gain.value = reverb * volume;
      src.connect(send).connect(this.reverbBus);
    }
    src.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      src.disconnect();
      gain.disconnect();
      send?.disconnect();
      if (dest !== this.sfxBus) dest.disconnect();
      for (const n of extraNodes) n.disconnect();
    };
    src.start();
  }

  public playUI(key: string, volume = 0.45, rate = 1, reverb = 0, pitchJitter = 0.08): void {
    const jitter = pitchJitter > 0 ? 1 + (Math.random() * 2 - 1) * pitchJitter : 1;
    this.playBuffer(key, volume, rate * jitter, this.sfxBus, reverb);
  }

  public playPositional(
    key: string,
    position: THREE.Vector3,
    volume = 0.8,
    pitchJitter = 0.1,
    refDistance = 8,
    reverb = 0,
    rate = 1
  ): void {
    if (this.muted || this.disposed || this.activeOneShots >= MAX_CONCURRENT_ONESHOTS) return;
    const dist = this.listenerPos.distanceTo(position);
    if (dist > 95) return;

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = 95;
    panner.rolloffFactor = 1.2;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y + 1;
    panner.positionZ.value = position.z;

    const extras: AudioNode[] = [];
    let entry: AudioNode = panner;

    if (dist > 16) {
      const airLP = this.ctx.createBiquadFilter();
      airLP.type = 'lowpass';
      const t = THREE.MathUtils.clamp((dist - 16) / 60, 0, 1);
      airLP.frequency.value = THREE.MathUtils.lerp(16000, 2200, t);
      airLP.Q.value = 0.5;
      airLP.connect(panner);
      entry = airLP;
      extras.push(panner);
    }

    panner.connect(this.sfxBus);
    const effectiveJitter = Math.max(0.08, pitchJitter);
    this.playBuffer(key, volume, rate * (1 + (Math.random() * 2 - 1) * effectiveJitter), entry, reverb, extras);
  }

  public playFootstep(surface: Surface, volume: number, heavy = false): void {
    const key = surface === 'grass' ? 'step_grass' : surface === 'wood' ? 'step_wood' : 'step_concrete';
    const vol = surface === 'grass' ? volume * 0.82 : volume;
    this.playUI(key, vol, heavy ? 0.86 : 0.98, 0.05, 0.11);
  }

  /** Visceral rising snarl / telegraph cue when a zombie winds up an attack. */
  public playZombieTelegraph(position: THREE.Vector3, isHeavy: boolean): void {
    if (this.muted || this.disposed) return;
    this.playPositional(isHeavy ? 'brute_roar' : 'zombie_aggro', position, isHeavy ? 0.72 : 0.48, 0.1, 10, 0.25, isHeavy ? 0.82 : 1.15);
  }

  /** Heavy ground slam sub-bass thump for Brute / The Butcher shockwaves. */
  public playSlamImpact(position: THREE.Vector3): void {
    if (this.muted || this.disposed) return;
    this.playPositional('explosion_low', position, 0.85, 0.08, 12, 0.5, 0.75);
    this.envTone('sine', 95, 32, 0.26, 0.24);
  }

  // ───────────────────────────── Synthesised Tactile Cues ─────────────────────────────

  private envTone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    if (this.muted || this.disposed) return;
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

  public playDodge(): void {
    if (this.muted || this.disposed) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(1450, t + 0.09);
    bp.frequency.exponentialRampToValueAtTime(280, t + 0.24);
    bp.Q.value = 1.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.27);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
    this.playUI('gear_rustle', 0.32, 1.15, 0, 0.1);
  }

  public playSiren(): void {
    if (this.muted || this.disposed) return;
    this.duck(0.48, 5.5);
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
    const j = 0.94 + Math.random() * 0.12;
    if (kind === 'hit') {
      this.envTone('triangle', 1500 * j, 1080 * j, 0.05, 0.11);
    } else if (kind === 'head') {
      this.envTone('triangle', 2350 * j, 1920 * j, 0.075, 0.15);
      this.envTone('sine', 3450 * j, 2950 * j, 0.09, 0.08, 0.018);
    } else {
      this.envTone('square', 320 * j, 105 * j, 0.14, 0.07);
      this.envTone('triangle', 1750 * j, 1180 * j, 0.065, 0.12);
    }
  }

  public playRadioStatic(): void {
    if (this.muted || this.disposed) return;
    this.duck(0.45, 3.2);
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1900;
    band.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    src.connect(band).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.35);
    src.onended = () => {
      src.disconnect();
      band.disconnect();
      g.disconnect();
    };
    this.playUI('switch', 0.3, 1.3, 0, 0.09);
  }

  public playDryFire(): void {
    this.playUI('gun_empty', 0.5, 1, 0, 0.09);
  }

  public playHurt(): void {
    this.playUI('player_hurt1', 0.62, 1, 0, 0.11);
    this.playUI('zombie_bite', 0.45, 1, 0, 0.11);
  }

  public playObjectiveChime(): void {
    this.playUI('objective_pickup', 0.6, 1, 0, 0.04);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.envTone('triangle', f, f, 0.35, 0.06, 0.05 + i * 0.09));
  }

  public playDefeatSting(): void {
    this.duck(0.7, 5);
    this.playUI('ui_game_over', 0.72, 1, 0, 0);
  }

  public playVictorySting(): void {
    this.duck(0.55, 5);
    this.playUI('ui_complete', 0.72, 1, 0, 0);
  }
}
