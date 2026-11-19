import { WEAPONS } from '../data/catalog';
import { AudioBus } from '../core/AudioManager';
import { HUDState, SurvivorId, WeaponId } from '../types/game';

export interface HUDCallbacks {
  onStartGame: (survivor: SurvivorId) => void;
  onUseItem: (index: number) => void;
  onCraftMedkit: () => void;
  onCraftAmmo: (type: 'pistol' | 'shells' | 'rifle') => void;
  onToggleMute: () => void;
  onResume: () => void;
  onRestart: () => void;
  onVolumeChange: (v: number) => void;
  onBusVolumeChange: (bus: AudioBus, v: number) => void;
  onQualityChange: (high: boolean) => void;
  onSensitivityChange: (v: number) => void;
}

export interface HUDSettingsSnapshot {
  volume: number;
  musicVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  sensitivity: number;
  muted: boolean;
  highQuality: boolean;
}

export interface EndStats {
  victory: boolean;
  kills: number;
  headshots: number;
  days: number;
  seconds: number;
}

const SURVIVORS: { id: SurvivorId; blurb: string }[] = [
  { id: 'matt', blurb: 'Ex-firefighter' },
  { id: 'lis', blurb: 'Paramedic' },
  { id: 'sam', blurb: 'Mechanic' },
  { id: 'shaun', blurb: 'Line cook' },
];

const WEAPON_ORDER: WeaponId[] = ['axe', 'pistol', 'shotgun', 'smg', 'rifle', 'sniper'];
const WEAPON_SHORT: Record<WeaponId, string> = {
  axe: 'AXE',
  pistol: 'M9',
  shotgun: 'PUMP',
  smg: 'MP5',
  rifle: 'M4',
  sniper: 'DMR',
};

type ElKey =
  | 'valHp' | 'barHp' | 'barHpGhost' | 'valStam' | 'barStam' | 'barHunger' | 'barThirst' | 'valScrap'
  | 'vignette' | 'day' | 'phase' | 'clockFill' | 'noiseBar' | 'kills' | 'objCans' | 'objBeacon' | 'objExtract'
  | 'dogPing' | 'toast' | 'hitMarker' | 'headshot' | 'chTop' | 'chBot' | 'chLeft' | 'chRight' | 'crosshair'
  | 'reloadArc' | 'reloadArcSvg' | 'lowAmmoHint' | 'sniperScope'
  | 'compassTape' | 'compassObj' | 'chapterBanner' | 'chapterNum' | 'chapterTitle'
  | 'prompt' | 'promptTitle' | 'promptSub' | 'wpnName' | 'wpnMag' | 'wpnReserve' | 'wpnReloadWrap' | 'wpnReloadBar'
  | 'wpnSlots' | 'pauseHint' | 'waypoint' | 'wpLabel' | 'wpDist' | 'wpArrow' | 'dmgRing' | 'stance' | 'dodgeBar'
  | 'bossBar' | 'bossFill' | 'radioBox' | 'radioSpeaker' | 'radioText' | 'restOverlay' | 'restClock' | 'restStatus';

export class HUD {
  private root: HTMLElement;
  private callbacks: HUDCallbacks;

  private selectedSurvivor: SurvivorId = 'matt';
  private screen: 'loading' | 'title' | 'playing' | 'paused' | 'gameover' | 'victory' = 'loading';

  private titleEl!: HTMLElement;
  private hudEl!: HTMLElement;
  private inventoryEl!: HTMLElement;
  private pauseEl!: HTMLElement;
  private endEl!: HTMLElement;
  private el = {} as Record<ElKey, HTMLElement>;
  private dmgArcs: HTMLElement[] = [];

  private lastInvVersion = -1;
  private lastInvOpen = false;
  private lastSlotsSig = '';
  private ghostHp = 100;

  constructor(root: HTMLElement, callbacks: HUDCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.buildDOM();
  }

  private buildDOM(): void {
    const bar = (id: string, color: string, h = 'h-2') =>
      `<div class="w-full ${h} bg-black/50 rounded-sm overflow-hidden relative">
         <div id="${id}" class="absolute inset-y-0 left-0 ${color} transition-[width] duration-150" style="width:100%"></div>
       </div>`;

    this.root.innerHTML = `
      <!-- Title Screen -->
      <div id="screen-title" class="fixed inset-0 flex items-center pointer-events-auto z-40 title-backdrop">
        <div class="w-full max-w-xl ml-[6vw] mr-4 p-8 rounded-2xl hud-glass shadow-2xl">
          <div class="flex items-center justify-between mb-3">
            <span class="text-[11px] font-mono uppercase tracking-[0.3em] text-red-500">Quarantine Sector 04</span>
            <span class="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500"><span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>LIVE FEED</span>
          </div>
          <h1 class="title-logo text-6xl font-black tracking-tight text-white leading-none mb-3">DEADLOCK<br/><span class="text-red-600">DISTRICT</span></h1>
          <p class="text-sm text-zinc-400 mb-6 leading-relaxed">Scavenge the district, fortify doorways, survive the Blood Siren at nightfall — then fuel the armored truck with <span class="text-amber-300">3 Jerrycans</span> and a <span class="text-sky-300">Radio Beacon</span> to extract.</p>

          <div id="loading-panel" class="mb-2">
            <div class="flex justify-between text-xs font-mono text-zinc-400 mb-1.5">
              <span id="load-label">Initializing asset pipeline...</span>
              <span id="load-pct">0%</span>
            </div>
            <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
              <div id="load-bar" class="h-full bg-gradient-to-r from-red-700 to-amber-500 transition-all duration-150" style="width: 0%"></div>
            </div>
          </div>

          <div id="ready-panel" class="hidden space-y-5">
            <div>
              <div class="text-[11px] font-mono uppercase tracking-wider text-zinc-500 mb-2">Select Survivor</div>
              <div class="grid grid-cols-4 gap-2" id="survivor-grid">
                ${SURVIVORS.map(
                  (s, i) => `
                  <button data-survivor="${s.id}" class="surv-btn ${i === 0 ? 'is-active' : ''}">
                    <div class="text-sm font-bold capitalize">${s.id}</div>
                    <div class="text-[10px] font-mono opacity-70">${s.blurb}</div>
                  </button>`
                ).join('')}
              </div>
            </div>

            <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] text-zinc-300 bg-black/40 p-3.5 rounded-xl border border-white/5 font-mono">
              <div><span class="kbd">WASD</span> Move <span class="kbd">Shift</span> Sprint</div>
              <div><span class="kbd">Space</span> Dodge <span class="kbd">C</span> Crouch</div>
              <div><span class="kbd">LMB</span> Fire <span class="kbd">RMB</span> Aim</div>
              <div><span class="kbd">E</span> Interact <span class="kbd">R</span> Reload</div>
              <div><span class="kbd">1-6</span>/<span class="kbd">Wheel</span> Weapons</div>
              <div><span class="kbd">Tab</span> Pack <span class="kbd">Q</span> Heal</div>
              <div><span class="kbd">F</span> Light <span class="kbd">V</span> Shoulder</div>
              <div><span class="kbd">Mouse</span> Aim <span class="kbd">Esc</span> Pause</div>
            </div>

            <button id="btn-deploy" class="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 active:scale-[0.99] text-white font-bold tracking-[0.15em] uppercase transition shadow-lg shadow-red-900/50">
              Deploy Into Quarantine Zone
            </button>
          </div>
        </div>
      </div>

      <!-- In-Game HUD -->
      <div id="screen-hud" class="hidden fixed inset-0 pointer-events-none">
        <div id="damage-vignette" class="fixed inset-0 vignette-blood opacity-0 transition-opacity duration-200"></div>

        <!-- Sniper Mil-Dot Scope Overlay -->
        <div id="sniper-scope" class="hidden fixed inset-0 sniper-scope pointer-events-none">
          <div class="scope-line-h"></div>
          <div class="scope-line-v"></div>
          <div class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-56 h-56 rounded-full border border-white/25"></div>
        </div>

        <!-- Cinematic Chapter Banner -->
        <div id="chapter-banner" class="fixed top-[26vh] left-1/2 -translate-x-1/2 text-center opacity-0 pointer-events-none">
          <div id="chapter-num" class="text-xs font-mono uppercase tracking-[0.45em] text-red-400 mb-1">CHAPTER 1</div>
          <div id="chapter-title" class="text-5xl font-black uppercase tracking-[0.18em] text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.9)]">DAY ONE</div>
          <div class="chapter-rule h-[2px] w-72 mx-auto mt-2"></div>
        </div>

        <!-- Damage direction ring -->
        <div id="dmg-ring" class="fixed left-1/2 top-1/2 w-0 h-0"></div>

        <!-- Objective waypoint -->
        <div id="waypoint" class="hidden fixed -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5">
          <div id="wp-arrow" class="waypoint-diamond"></div>
          <div id="wp-label" class="text-[10px] font-mono font-bold uppercase tracking-wider text-white drop-shadow"></div>
          <div id="wp-dist" class="text-[10px] font-mono text-zinc-300 drop-shadow"></div>
        </div>

        <!-- Top-center: tactical compass / day / phase / noise / objectives -->
        <div class="fixed top-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5">
          <!-- Tactical Compass Tape -->
          <div class="compass-wrap relative w-72 h-5 overflow-hidden flex items-center justify-center">
            <div class="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent border-t-red-500 z-10"></div>
            <div id="compass-tape" class="absolute top-1 left-1/2 whitespace-nowrap font-mono text-[10px] tracking-widest text-zinc-400 will-change-transform"></div>
            <div id="compass-obj" class="hidden absolute top-0.5 w-2 h-2 rotate-45 bg-amber-400 shadow-[0_0_8px_#f59e0b]"></div>
          </div>

          <div class="hud-glass px-4 py-1.5 rounded-full flex items-center gap-4 text-xs font-mono">
            <span id="hud-day" class="text-zinc-200 font-bold">DAY 1</span>
            <div class="w-16 h-1 bg-black/60 rounded-full overflow-hidden"><div id="hud-clock" class="h-full bg-amber-400/80" style="width:0%"></div></div>
            <span id="hud-phase" class="px-2 py-0.5 rounded font-bold uppercase">DAYLIGHT</span>
            <div class="flex items-center gap-1.5">
              <span class="text-zinc-500">NOISE</span>
              <div class="w-20 h-1.5 bg-black/60 rounded-full overflow-hidden">
                <div id="hud-noise-bar" class="h-full bg-emerald-400 transition-all duration-75" style="width: 0%"></div>
              </div>
            </div>
            <span id="hud-kills" class="text-zinc-400">☠ <b class="text-white">0</b></span>
          </div>

          <div id="hud-objectives" class="relative hud-glass hud-corner px-4 py-1.5 rounded-lg flex items-center gap-3 text-[12px] max-w-[560px]">
            <span id="obj-cans" class="font-mono text-[10px] uppercase tracking-[0.2em] text-red-400 whitespace-nowrap">Ch 1 · Day One</span>
            <span class="w-px h-4 bg-white/15"></span>
            <span id="obj-beacon" class="text-zinc-100 font-medium">Get inside the marked safehouse</span>
            <span id="obj-extract" class="text-red-400 font-bold font-mono text-[11px] hidden whitespace-nowrap"></span>
          </div>

          <div id="hud-dog-ping" class="hidden px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-200 text-xs font-mono animate-pulse">
            🐕 K9 ALERT — ZOMBIES CLOSING IN
          </div>
        </div>

        <div id="hud-toast" class="fixed top-36 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg hud-glass text-amber-100 text-sm font-medium shadow-lg opacity-0 transition-opacity duration-200 whitespace-nowrap"></div>

        <!-- Crosshair + Radial Reload Arc + Low-Ammo Hint -->
        <div class="fixed inset-0 flex items-center justify-center">
          <div id="crosshair" class="relative w-12 h-12 flex items-center justify-center transition-opacity">
            <svg id="reload-arc-svg" class="hidden absolute inset-0 w-12 h-12 -rotate-90" viewBox="0 0 44 44">
              <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.2" />
              <circle id="reload-arc" cx="22" cy="22" r="18" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="113.1" />
            </svg>
            <div class="w-1 h-1 rounded-full bg-white/90 shadow-[0_0_2px_black]"></div>
            <div id="ch-top" class="ch-line absolute w-0.5 h-2.5"></div>
            <div id="ch-bot" class="ch-line absolute w-0.5 h-2.5"></div>
            <div id="ch-left" class="ch-line absolute h-0.5 w-2.5"></div>
            <div id="ch-right" class="ch-line absolute h-0.5 w-2.5"></div>
            <div id="hit-marker" class="hit-marker opacity-0"><i></i><i></i><i></i><i></i></div>
          </div>
          <div id="headshot" class="absolute mt-16 text-[10px] font-mono font-bold tracking-[0.25em] text-amber-300 opacity-0 transition-opacity">HEADSHOT</div>
          <div id="low-ammo-hint" class="hidden absolute mt-24 px-2 py-0.5 rounded bg-red-950/75 border border-red-500/50 text-[10px] font-mono font-bold tracking-widest text-red-200 animate-pulse">[R] RELOAD</div>
        </div>

        <div id="interact-prompt" class="hidden fixed bottom-40 left-1/2 -translate-x-1/2 hud-glass pl-2 pr-4 py-2 rounded-xl flex items-center gap-3">
          <span class="kbd-lg">E</span>
          <div>
            <div id="interact-title" class="text-sm font-bold text-white"></div>
            <div id="interact-sub" class="text-[11px] font-mono text-amber-300"></div>
          </div>
        </div>

        <!-- Bottom-left vitals -->
        <div class="fixed bottom-5 left-5 hud-glass hud-corner p-4 rounded-2xl w-64 space-y-2.5">
          <div>
            <div class="flex justify-between text-xs font-mono mb-1">
              <span class="text-red-400 font-bold tracking-wider">HEALTH</span>
              <span id="val-hp" class="text-white font-bold">100</span>
            </div>
            <div class="w-full h-2.5 bg-black/50 rounded-sm overflow-hidden relative">
              <div id="bar-hp-ghost" class="absolute inset-y-0 left-0 bg-red-200/50" style="width:100%"></div>
              <div id="bar-hp" class="absolute inset-y-0 left-0 bg-gradient-to-r from-red-700 to-red-500" style="width:100%"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between text-[11px] font-mono mb-1">
              <span class="text-sky-400">STAMINA</span>
              <span id="val-stam" class="text-zinc-300">100</span>
            </div>
            ${bar('bar-stam', 'bg-sky-400', 'h-1.5')}
          </div>
          <div class="grid grid-cols-2 gap-2 pt-0.5">
            <div>
              <div class="text-[10px] font-mono text-amber-400 mb-0.5">HUNGER</div>
              ${bar('bar-hunger', 'bg-amber-500', 'h-1.5')}
            </div>
            <div>
              <div class="text-[10px] font-mono text-cyan-400 mb-0.5">THIRST</div>
              ${bar('bar-thirst', 'bg-cyan-400', 'h-1.5')}
            </div>
          </div>
          <div class="flex items-center justify-between pt-1.5 border-t border-white/10 text-[11px] font-mono text-zinc-400">
            <span>⚙ SCRAP <b id="val-scrap" class="text-white">20</b></span>
            <div class="flex items-center gap-2">
              <span class="text-[9px] text-zinc-500">DODGE</span>
              <div class="w-10 h-1 bg-black/60 rounded-full overflow-hidden"><div id="bar-dodge" class="h-full bg-amber-300" style="width:100%"></div></div>
            </div>
          </div>
          <div class="text-[10px] font-mono text-zinc-500 flex justify-between">
            <span id="hud-stance">STANDING</span>
            <span>[Space] Dodge · [Q] Heal</span>
          </div>
        </div>

        <!-- Bottom-right weapon -->
        <div class="fixed bottom-5 right-5 hud-glass hud-corner p-4 rounded-2xl w-64 text-right">
          <div id="wpn-name" class="text-xs font-bold text-zinc-300 tracking-[0.15em] uppercase">M9 Tactical Pistol</div>
          <div class="flex items-baseline justify-end gap-1.5 my-0.5">
            <span id="wpn-mag" class="text-4xl font-black font-mono text-white tabular-nums">15</span>
            <span id="wpn-reserve" class="text-sm font-mono text-zinc-400 tabular-nums">/ 45</span>
          </div>
          <div id="wpn-reload-wrap" class="hidden w-full h-1 bg-black/50 rounded-full overflow-hidden mb-1">
            <div id="wpn-reload-bar" class="h-full bg-amber-400" style="width:0%"></div>
          </div>
          <div id="wpn-slots" class="flex justify-end gap-1 mt-2"></div>
        </div>

        <!-- Boss health -->
        <div id="boss-bar" class="hidden fixed top-28 left-1/2 -translate-x-1/2 w-[420px] text-center">
          <div class="text-[11px] font-mono uppercase tracking-[0.35em] text-red-400 mb-1 drop-shadow">The Butcher</div>
          <div class="h-2.5 bg-black/60 rounded-sm overflow-hidden border border-red-900/60">
            <div id="boss-fill" class="h-full bg-gradient-to-r from-red-800 to-red-500" style="width:100%"></div>
          </div>
        </div>

        <!-- Radio transmission -->
        <div id="radio-box" class="radio-box hidden fixed left-1/2 -translate-x-1/2 bottom-[13.5rem] w-[560px] max-w-[92vw] hud-glass rounded-xl px-4 py-3">
          <div class="flex items-center gap-2 mb-1">
            <span class="radio-led"></span>
            <span id="radio-speaker" class="text-[10px] font-mono uppercase tracking-[0.25em] text-sky-300"></span>
          </div>
          <div id="radio-text" class="text-sm text-zinc-100 leading-snug min-h-[2.5em]"></div>
        </div>

        <!-- Resting time-lapse -->
        <div id="rest-overlay" class="hidden fixed inset-0 flex items-center justify-center bg-black/80 z-20">
          <div class="text-center">
            <div class="text-[11px] font-mono uppercase tracking-[0.35em] text-zinc-400 mb-2">Resting</div>
            <div id="rest-clock" class="text-4xl font-black text-white mb-3 tabular-nums"></div>
            <div id="rest-status" class="text-sm text-zinc-300 font-mono whitespace-pre-line"></div>
          </div>
        </div>

        <div id="pause-hint" class="hidden fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-zinc-900/90 border border-zinc-700 text-xs font-mono text-zinc-300 pointer-events-auto cursor-pointer">
          Click to lock mouse & aim • Arrow keys also look around
        </div>
      </div>

      <!-- Inventory & Crafting -->
      <div id="screen-inventory" class="hidden fixed inset-0 flex items-center justify-center bg-black/60 pointer-events-auto z-30">
        <div class="max-w-2xl w-full mx-4 p-6 rounded-2xl hud-glass shadow-2xl">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-xl font-bold text-white">Survivor Pack</h2>
              <p class="text-xs font-mono text-zinc-400">Click an item to use it • The world keeps moving — stay alert • [Tab] close</p>
            </div>
            <button id="btn-close-inv" class="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-bold text-white">Close</button>
          </div>

          <div id="inv-grid" class="grid grid-cols-3 gap-2.5 max-h-60 overflow-y-auto mb-5"></div>

          <div class="border-t border-white/10 pt-4">
            <div class="text-xs font-mono uppercase tracking-wider text-amber-400 mb-2">Field Crafting — Scrap: <span id="craft-scrap" class="text-white">0</span></div>
            <div class="grid grid-cols-4 gap-2">
              <button id="craft-medkit" class="craft-btn"><div class="text-xs font-bold text-white">🩹 Medkit</div><div class="text-[10px] font-mono text-amber-400">15 Scrap</div></button>
              <button id="craft-pistol" class="craft-btn"><div class="text-xs font-bold text-white">🔫 +15 9mm</div><div class="text-[10px] font-mono text-amber-400">8 Scrap</div></button>
              <button id="craft-shells" class="craft-btn"><div class="text-xs font-bold text-white">🧨 +6 Shells</div><div class="text-[10px] font-mono text-amber-400">12 Scrap</div></button>
              <button id="craft-rifle" class="craft-btn"><div class="text-xs font-bold text-white">🎯 +15 Rifle</div><div class="text-[10px] font-mono text-amber-400">12 Scrap</div></button>
            </div>
          </div>
        </div>
      </div>

      <!-- Pause / Settings (Multi-Bus Audio Mixer & Graphics Quality) -->
      <div id="screen-pause" class="hidden fixed inset-0 flex items-center justify-center bg-black/75 pointer-events-auto z-40">
        <div class="relative max-w-md w-full mx-4 p-7 rounded-2xl hud-glass hud-corner shadow-2xl">
          <h2 class="text-3xl font-black text-white tracking-wider mb-1">PAUSED</h2>
          <p class="text-xs font-mono text-zinc-400 mb-5">The district holds its breath.</p>
          <div class="space-y-3 mb-5">
            <label class="block">
              <div class="flex justify-between text-xs font-mono text-zinc-200 mb-1"><span>Master Volume</span><span id="vol-val">80%</span></div>
              <input id="vol-slider" type="range" min="0" max="100" value="80" class="w-full accent-red-600" />
            </label>
            <div class="grid grid-cols-3 gap-2.5 pt-1">
              <label class="block">
                <div class="flex justify-between text-[10px] font-mono text-zinc-400 mb-1"><span>Music</span><span id="vol-music-val">80%</span></div>
                <input id="vol-music-slider" type="range" min="0" max="100" value="80" class="w-full accent-amber-500" />
              </label>
              <label class="block">
                <div class="flex justify-between text-[10px] font-mono text-zinc-400 mb-1"><span>SFX</span><span id="vol-sfx-val">90%</span></div>
                <input id="vol-sfx-slider" type="range" min="0" max="100" value="90" class="w-full accent-amber-500" />
              </label>
              <label class="block">
                <div class="flex justify-between text-[10px] font-mono text-zinc-400 mb-1"><span>Ambience</span><span id="vol-amb-val">85%</span></div>
                <input id="vol-amb-slider" type="range" min="0" max="100" value="85" class="w-full accent-amber-500" />
              </label>
            </div>
            <label class="block pt-1">
              <div class="flex justify-between text-xs font-mono text-zinc-200 mb-1"><span>Mouse Sensitivity</span><span id="sens-val">1.00x</span></div>
              <input id="sens-slider" type="range" min="25" max="250" value="100" class="w-full accent-red-600" />
            </label>
            <div class="grid grid-cols-2 gap-2 pt-1">
              <button id="btn-mute" class="py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-200">Mute Audio</button>
              <button id="btn-quality" class="py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-amber-300">Quality: HIGH</button>
            </div>
          </div>
          <button id="btn-resume" class="w-full py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold uppercase tracking-wider mb-2">Resume</button>
          <button id="btn-restart-pause" class="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-bold uppercase tracking-wider">Restart</button>
        </div>
      </div>

      <!-- End Screen -->
      <div id="screen-end" class="hidden fixed inset-0 flex items-center justify-center pointer-events-auto z-50 end-backdrop">
        <div class="max-w-md w-full mx-4 p-8 rounded-2xl hud-glass text-center">
          <div id="end-kicker" class="text-[11px] font-mono uppercase tracking-[0.3em] text-zinc-500 mb-2"></div>
          <h2 id="end-title" class="text-4xl font-black mb-2">EXTRACTED</h2>
          <p id="end-sub" class="text-sm text-zinc-300 mb-6"></p>
          <div id="end-stats" class="grid grid-cols-4 gap-2 mb-6"></div>
          <button id="btn-restart" class="w-full py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold uppercase tracking-wider">
            Play Again
          </button>
        </div>
      </div>
    `;

    const $ = (id: string) => document.getElementById(id)!;
    this.titleEl = $('screen-title');
    this.hudEl = $('screen-hud');
    this.inventoryEl = $('screen-inventory');
    this.pauseEl = $('screen-pause');
    this.endEl = $('screen-end');

    const ids: Record<ElKey, string> = {
      valHp: 'val-hp', barHp: 'bar-hp', barHpGhost: 'bar-hp-ghost', valStam: 'val-stam', barStam: 'bar-stam',
      barHunger: 'bar-hunger', barThirst: 'bar-thirst', valScrap: 'val-scrap', vignette: 'damage-vignette',
      day: 'hud-day', phase: 'hud-phase', clockFill: 'hud-clock', noiseBar: 'hud-noise-bar', kills: 'hud-kills',
      objCans: 'obj-cans', objBeacon: 'obj-beacon', objExtract: 'obj-extract', dogPing: 'hud-dog-ping',
      toast: 'hud-toast', hitMarker: 'hit-marker', headshot: 'headshot', chTop: 'ch-top', chBot: 'ch-bot',
      chLeft: 'ch-left', chRight: 'ch-right', crosshair: 'crosshair',
      reloadArc: 'reload-arc', reloadArcSvg: 'reload-arc-svg', lowAmmoHint: 'low-ammo-hint', sniperScope: 'sniper-scope',
      compassTape: 'compass-tape', compassObj: 'compass-obj',
      chapterBanner: 'chapter-banner', chapterNum: 'chapter-num', chapterTitle: 'chapter-title',
      prompt: 'interact-prompt',
      promptTitle: 'interact-title', promptSub: 'interact-sub', wpnName: 'wpn-name', wpnMag: 'wpn-mag',
      wpnReserve: 'wpn-reserve', wpnReloadWrap: 'wpn-reload-wrap', wpnReloadBar: 'wpn-reload-bar',
      wpnSlots: 'wpn-slots', pauseHint: 'pause-hint', waypoint: 'waypoint', wpLabel: 'wp-label',
      wpDist: 'wp-dist', wpArrow: 'wp-arrow', dmgRing: 'dmg-ring', stance: 'hud-stance', dodgeBar: 'bar-dodge',
      bossBar: 'boss-bar', bossFill: 'boss-fill', radioBox: 'radio-box', radioSpeaker: 'radio-speaker',
      radioText: 'radio-text', restOverlay: 'rest-overlay', restClock: 'rest-clock', restStatus: 'rest-status',
    };
    for (const [k, id] of Object.entries(ids)) this.el[k as ElKey] = $(id);

    // Build repeating 720-degree compass tape (2 px per degree -> 720 px per 360°)
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let tapeHtml = '';
    for (let deg = -360; deg <= 720; deg += 15) {
      const norm = ((deg % 360) + 360) % 360;
      const lbl = labels[norm];
      const cls = norm % 90 === 0 ? 'text-white font-bold' : lbl ? 'text-zinc-400' : 'text-zinc-600';
      tapeHtml += `<span class="inline-block w-[30px] text-center ${cls}">${lbl ?? '·'}</span>`;
    }
    this.el.compassTape.innerHTML = tapeHtml;

    for (let i = 0; i < 4; i++) {
      const arc = document.createElement('div');
      arc.className = 'dmg-arc';
      this.el.dmgRing.appendChild(arc);
      this.dmgArcs.push(arc);
    }

    this.root.querySelectorAll<HTMLElement>('.surv-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedSurvivor = btn.dataset.survivor as SurvivorId;
        this.root.querySelectorAll('.surv-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
      });
    });

    $('btn-deploy').addEventListener('click', () => {
      this.titleEl.classList.add('hidden');
      this.hudEl.classList.remove('hidden');
      this.screen = 'playing';
      this.callbacks.onStartGame(this.selectedSurvivor);
    });

    $('btn-close-inv').addEventListener('click', () => this.callbacks.onResume());
    $('pause-hint').addEventListener('click', () => this.callbacks.onResume());
    $('btn-resume').addEventListener('click', () => this.callbacks.onResume());
    $('btn-mute').addEventListener('click', () => this.callbacks.onToggleMute());
    $('btn-restart').addEventListener('click', () => this.callbacks.onRestart());
    $('btn-restart-pause').addEventListener('click', () => this.callbacks.onRestart());
    $('craft-medkit').addEventListener('click', () => this.callbacks.onCraftMedkit());
    $('craft-pistol').addEventListener('click', () => this.callbacks.onCraftAmmo('pistol'));
    $('craft-shells').addEventListener('click', () => this.callbacks.onCraftAmmo('shells'));
    $('craft-rifle').addEventListener('click', () => this.callbacks.onCraftAmmo('rifle'));

    const vol = $('vol-slider') as HTMLInputElement;
    vol.addEventListener('input', () => {
      $('vol-val').textContent = `${vol.value}%`;
      this.callbacks.onVolumeChange(Number(vol.value) / 100);
    });
    const bindBus = (sliderId: string, valId: string, bus: AudioBus) => {
      const el = $(sliderId) as HTMLInputElement;
      el.addEventListener('input', () => {
        $(valId).textContent = `${el.value}%`;
        this.callbacks.onBusVolumeChange(bus, Number(el.value) / 100);
      });
    };
    bindBus('vol-music-slider', 'vol-music-val', 'music');
    bindBus('vol-sfx-slider', 'vol-sfx-val', 'sfx');
    bindBus('vol-amb-slider', 'vol-amb-val', 'ambience');

    const qualBtn = $('btn-quality');
    qualBtn.addEventListener('click', () => {
      const nextHigh = qualBtn.dataset.high !== 'true';
      qualBtn.dataset.high = String(nextHigh);
      qualBtn.textContent = nextHigh ? 'Quality: HIGH' : 'Quality: MEDIUM';
      this.callbacks.onQualityChange(nextHigh);
    });

    const sens = $('sens-slider') as HTMLInputElement;
    sens.addEventListener('input', () => {
      $('sens-val').textContent = `${(Number(sens.value) / 100).toFixed(2)}x`;
      this.callbacks.onSensitivityChange(Number(sens.value) / 100);
    });
  }

  public setSettings(s: HUDSettingsSnapshot): void {
    const setSlider = (id: string, valId: string, v: number) => {
      const el = document.getElementById(id) as HTMLInputElement;
      el.value = String(Math.round(v * 100));
      document.getElementById(valId)!.textContent = `${el.value}%`;
    };
    setSlider('vol-slider', 'vol-val', s.volume);
    setSlider('vol-music-slider', 'vol-music-val', s.musicVolume);
    setSlider('vol-sfx-slider', 'vol-sfx-val', s.sfxVolume);
    setSlider('vol-amb-slider', 'vol-amb-val', s.ambienceVolume);

    const sens = document.getElementById('sens-slider') as HTMLInputElement;
    sens.value = String(Math.round(s.sensitivity * 100));
    document.getElementById('sens-val')!.textContent = `${s.sensitivity.toFixed(2)}x`;

    const qualBtn = document.getElementById('btn-quality')!;
    qualBtn.dataset.high = String(s.highQuality);
    qualBtn.textContent = s.highQuality ? 'Quality: HIGH' : 'Quality: MEDIUM';
    this.setMuted(s.muted);
  }

  public setMuted(muted: boolean): void {
    document.getElementById('btn-mute')!.textContent = muted ? 'Unmute Audio' : 'Mute Audio';
  }

  public setLoadProgress(loaded: number, total: number, label: string): void {
    const pct = Math.round((loaded / Math.max(1, total)) * 100);
    document.getElementById('load-bar')!.style.width = `${pct}%`;
    document.getElementById('load-label')!.textContent = `Loading ${label.replace(/_/g, ' ')}`;
    document.getElementById('load-pct')!.textContent = `${pct}%`;
  }

  public showReady(): void {
    document.getElementById('loading-panel')!.classList.add('hidden');
    document.getElementById('ready-panel')!.classList.remove('hidden');
    this.screen = 'title';
  }

  public setPaused(paused: boolean): void {
    if (this.screen !== 'playing' && this.screen !== 'paused') return;
    this.screen = paused ? 'paused' : 'playing';
    this.pauseEl.classList.toggle('hidden', !paused);
  }

  public showEndScreen(stats: EndStats): void {
    this.screen = stats.victory ? 'victory' : 'gameover';
    this.hudEl.classList.add('hidden');
    this.inventoryEl.classList.add('hidden');
    this.pauseEl.classList.add('hidden');
    this.endEl.classList.remove('hidden');
    this.endEl.classList.toggle('end-victory', stats.victory);

    const title = document.getElementById('end-title')!;
    const sub = document.getElementById('end-sub')!;
    const kicker = document.getElementById('end-kicker')!;
    if (stats.victory) {
      kicker.textContent = 'Transmission received';
      title.textContent = 'EXTRACTION COMPLETE';
      title.className = 'text-4xl font-black mb-2 text-emerald-400';
      sub.textContent = 'The armored truck punched through the north gate. You made it out of Deadlock District.';
    } else {
      kicker.textContent = 'Signal lost';
      title.textContent = 'YOU WERE OVERRUN';
      title.className = 'text-4xl font-black mb-2 text-red-500';
      sub.textContent = 'Another name for the quarantine wall. The district claims everyone eventually.';
    }
    const mins = Math.floor(stats.seconds / 60);
    const secs = Math.floor(stats.seconds % 60);
    const tile = (label: string, value: string) =>
      `<div class="bg-black/40 rounded-lg py-2.5 border border-white/5"><div class="text-xl font-black text-white tabular-nums">${value}</div><div class="text-[9px] font-mono uppercase tracking-wider text-zinc-500">${label}</div></div>`;
    document.getElementById('end-stats')!.innerHTML =
      tile('Kills', `${stats.kills}`) +
      tile('Headshots', `${stats.headshots}`) +
      tile('Day', `${stats.days}`) +
      tile('Time', `${mins}:${secs.toString().padStart(2, '0')}`);
  }

  public update(state: HUDState, isPointerLocked: boolean, dt: number): void {
    if (this.screen !== 'playing' && this.screen !== 'paused') return;
    const e = this.el;

    // Vitals
    const hpPct = Math.max(0, (state.health / state.maxHealth) * 100);
    e.valHp.textContent = `${Math.ceil(state.health)}`;
    e.barHp.style.width = `${hpPct}%`;
    this.ghostHp = this.ghostHp > hpPct ? Math.max(hpPct, this.ghostHp - dt * 25) : hpPct;
    e.barHpGhost.style.width = `${this.ghostHp}%`;
    e.valHp.classList.toggle('text-red-400', hpPct < 30);
    e.valStam.textContent = `${Math.ceil(state.stamina)}`;
    e.barStam.style.width = `${state.stamina}%`;
    e.barHunger.style.width = `${state.hunger}%`;
    e.barThirst.style.width = `${state.thirst}%`;
    e.barHunger.classList.toggle('animate-pulse', state.hunger < 20);
    e.barThirst.classList.toggle('animate-pulse', state.thirst < 20);
    e.valScrap.textContent = `${state.scrap}`;
    e.dodgeBar.style.width = `${Math.round(state.dodgeReady * 100)}%`;
    e.stance.textContent = state.isSprinting ? 'SPRINTING' : state.isCrouching ? 'CROUCHED · QUIET' : state.isAiming ? 'AIMING' : 'STANDING';

    // Sniper scope & cinematic chapter title card
    e.sniperScope.classList.toggle('hidden', !state.isSniperADS || state.inventoryOpen);
    if (state.chapterBanner) {
      e.chapterNum.textContent = `CHAPTER ${state.chapterBanner.chapter}`;
      e.chapterTitle.textContent = state.chapterBanner.title;
      e.chapterBanner.style.opacity = `${state.chapterBanner.alpha}`;
    } else {
      e.chapterBanner.style.opacity = '0';
    }

    // Tactical compass tape (camera yaw = 0 faces -Z = North; turning right decreases yaw -> +heading)
    const headingDeg = (((-state.cameraYaw * 180) / Math.PI) % 360 + 360) % 360;
    // Tape starts at -360 deg (720 px before 0 deg) with 2 px per deg + 15 px center of first span
    const tapeOffset = (headingDeg + 360) * 2 + 15;
    e.compassTape.style.transform = `translateX(${-tapeOffset}px)`;
    if (state.objectiveBearing !== null) {
      const objDeg = ((state.objectiveBearing * 180) / Math.PI + 360) % 360;
      let delta = objDeg - headingDeg;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (Math.abs(delta) <= 68) {
        e.compassObj.classList.remove('hidden');
        e.compassObj.style.left = `calc(50% + ${delta * 2 - 4}px)`;
      } else {
        e.compassObj.classList.add('hidden');
      }
    } else {
      e.compassObj.classList.add('hidden');
    }

    e.vignette.style.opacity = state.damageFlashTimer > 0 ? '0.95' : state.health < 30 ? '0.5' : '0';

    // Clock & phase
    e.day.textContent = `DAY ${state.dayNumber}`;
    e.clockFill.style.width = `${state.timeOfDay * 100}%`;
    const phaseEl = e.phase;
    if (state.extractionActive) {
      phaseEl.textContent = 'FINAL SIEGE';
      phaseEl.className = 'px-2 py-0.5 rounded bg-red-600/30 text-red-300 font-bold animate-pulse';
    } else if (state.phase === 'night') {
      phaseEl.textContent = 'BLOOD SIREN';
      phaseEl.className = 'px-2 py-0.5 rounded bg-red-900/60 text-red-300 font-bold';
    } else if (state.phase === 'dusk') {
      phaseEl.textContent = 'DUSK';
      phaseEl.className = 'px-2 py-0.5 rounded bg-orange-500/25 text-orange-300 font-bold';
    } else if (state.phase === 'dawn') {
      phaseEl.textContent = 'DAWN';
      phaseEl.className = 'px-2 py-0.5 rounded bg-sky-500/20 text-sky-200 font-bold';
    } else {
      phaseEl.textContent = 'DAYLIGHT';
      phaseEl.className = 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold';
    }

    e.noiseBar.style.width = `${state.noiseLevel}%`;
    e.noiseBar.className = `h-full transition-all duration-75 ${
      state.noiseLevel > 60 ? 'bg-red-500' : state.noiseLevel > 25 ? 'bg-amber-400' : 'bg-emerald-400'
    }`;
    e.kills.innerHTML = `☠ <b class="text-white">${state.kills}</b>`;

    // Story objective
    e.objCans.textContent = state.chapterLabel;
    if (e.objBeacon.textContent !== state.objectiveText) {
      e.objBeacon.textContent = state.objectiveText;
      e.objBeacon.classList.remove('objective-flash');
      void e.objBeacon.offsetWidth;
      e.objBeacon.classList.add('objective-flash');
    }
    if (state.extractionActive && !state.extractionInRange) {
      e.objExtract.classList.remove('hidden');
      e.objExtract.textContent = '⚠ RETURN TO THE TRUCK';
    } else {
      e.objExtract.classList.add('hidden');
    }

    // Boss
    e.bossBar.classList.toggle('hidden', state.bossHealth === null);
    if (state.bossHealth !== null) e.bossFill.style.width = `${Math.max(0, state.bossHealth) * 100}%`;

    // Radio transmission (typewriter)
    if (state.radio) {
      e.radioBox.classList.remove('hidden');
      e.radioSpeaker.textContent = state.radio.speaker;
      const n = Math.ceil(state.radio.text.length * state.radio.progress);
      e.radioText.textContent = state.radio.text.slice(0, n);
    } else {
      e.radioBox.classList.add('hidden');
    }

    // Rest overlay
    e.restOverlay.classList.toggle('hidden', !state.rest);
    if (state.rest) {
      e.restClock.textContent = state.rest.clock;
      e.restStatus.textContent = state.rest.status;
    }

    // Cinematic: hide gameplay HUD chrome behind letterbox bars
    this.hudEl.classList.toggle('cinematic', state.cinematic);

    e.dogPing.classList.toggle('hidden', state.dogAlertTimer <= 0);

    // Toast
    if (state.toastMessage) {
      if (e.toast.textContent !== state.toastMessage) e.toast.textContent = state.toastMessage;
      e.toast.style.opacity = '1';
    } else {
      e.toast.style.opacity = '0';
    }

    // Crosshair, radial reload arc & low-ammo callout
    const hm = state.hitMarkerTimer > 0;
    e.hitMarker.style.opacity = hm ? `${Math.min(1, state.hitMarkerTimer / 0.12)}` : '0';
    e.hitMarker.dataset.kind = state.hitKind;
    e.headshot.style.opacity = hm && state.hitKind === 'head' ? '1' : '0';
    const melee = state.equippedWeapon.isMelee;
    const spreadPx = melee ? 3 : state.isAiming ? 2 : 5 + state.crosshairSpread * 16 + (state.isSprinting ? 8 : 0);
    e.chTop.style.transform = `translateY(-${spreadPx + 6}px)`;
    e.chBot.style.transform = `translateY(${spreadPx + 6}px)`;
    e.chLeft.style.transform = `translateX(-${spreadPx + 6}px)`;
    e.chRight.style.transform = `translateX(${spreadPx + 6}px)`;
    e.crosshair.style.opacity = state.inventoryOpen || state.isSniperADS ? '0' : state.isSprinting ? '0.35' : '1';

    e.reloadArcSvg.classList.toggle('hidden', !state.isReloading);
    if (state.isReloading) {
      e.reloadArc.setAttribute('stroke-dashoffset', `${(1 - state.reloadProgress) * 113.1}`);
    }
    const wDef = state.equippedWeapon;
    const lowAmmo =
      !wDef.isMelee &&
      !state.isReloading &&
      !state.inventoryOpen &&
      state.magAmmo[wDef.id] <= Math.ceil(wDef.magSize * 0.2) &&
      (wDef.ammoType ? state.reserveAmmo[wDef.ammoType] > 0 : false);
    e.lowAmmoHint.classList.toggle('hidden', !lowAmmo);

    // Interact prompt
    if (state.nearbyInteractable && !state.inventoryOpen) {
      e.prompt.classList.remove('hidden');
      e.promptTitle.textContent = state.nearbyInteractable.label;
      e.promptSub.textContent = state.nearbyInteractable.subLabel ?? '';
    } else {
      e.prompt.classList.add('hidden');
    }

    // Weapon panel
    const w = state.equippedWeapon;
    e.wpnName.textContent = w.name;
    if (w.isMelee) {
      e.wpnMag.textContent = '∞';
      e.wpnReserve.textContent = 'MELEE';
      e.wpnMag.classList.remove('text-red-500');
    } else {
      const mag = state.magAmmo[w.id];
      const reserve = w.ammoType ? state.reserveAmmo[w.ammoType] : 0;
      e.wpnMag.textContent = `${mag}`;
      e.wpnReserve.textContent = `/ ${reserve}`;
      e.wpnMag.classList.toggle('text-red-500', mag <= Math.ceil(w.magSize * 0.25));
      e.wpnReserve.classList.toggle('text-red-400', reserve === 0);
    }
    e.wpnReloadWrap.classList.toggle('hidden', !state.isReloading);
    e.wpnReloadBar.style.width = `${Math.round(state.reloadProgress * 100)}%`;

    const slotsSig = `${w.id}|${state.unlockedWeapons.join(',')}`;
    if (slotsSig !== this.lastSlotsSig) {
      this.lastSlotsSig = slotsSig;
      e.wpnSlots.innerHTML = WEAPON_ORDER.map((id) => {
        const def = WEAPONS[id];
        const unlocked = state.unlockedWeapons.includes(id);
        const active = w.id === id;
        const cls = active ? 'slot-active' : unlocked ? 'slot-owned' : 'slot-locked';
        return `<span class="weapon-slot ${cls}"><b>${def.slot}</b>${unlocked ? WEAPON_SHORT[id] : '—'}</span>`;
      }).join('');
    }

    // Waypoint
    const wp = state.waypoint;
    if (wp && !state.inventoryOpen) {
      e.waypoint.classList.remove('hidden');
      e.waypoint.style.left = `${wp.x}px`;
      e.waypoint.style.top = `${wp.y}px`;
      e.wpLabel.textContent = wp.label;
      e.wpDist.textContent = `${Math.round(wp.distance)}m`;
      e.wpArrow.style.setProperty('--wp-color', wp.color);
      e.wpArrow.classList.toggle('is-offscreen', !wp.onScreen);
      e.wpArrow.style.transform = wp.onScreen ? 'rotate(45deg)' : `rotate(${wp.angle}rad)`;
    } else {
      e.waypoint.classList.add('hidden');
    }

    // Damage direction indicators
    for (let i = 0; i < this.dmgArcs.length; i++) {
      const ind = state.damageIndicators[i];
      const arc = this.dmgArcs[i];
      if (ind) {
        arc.style.opacity = `${ind.alpha}`;
        arc.style.transform = `rotate(${ind.angle}rad) translateY(-130px)`;
      } else {
        arc.style.opacity = '0';
      }
    }

    // Pause hint & inventory
    e.pauseHint.classList.toggle('hidden', isPointerLocked || state.inventoryOpen || this.screen === 'paused');
    this.inventoryEl.classList.toggle('hidden', !state.inventoryOpen);
    if (state.inventoryOpen && (state.inventoryVersion !== this.lastInvVersion || !this.lastInvOpen)) {
      this.lastInvVersion = state.inventoryVersion;
      this.renderInventory(state);
    }
    if (state.inventoryOpen) document.getElementById('craft-scrap')!.textContent = `${state.scrap}`;
    this.lastInvOpen = state.inventoryOpen;
  }

  private renderInventory(state: HUDState): void {
    const grid = document.getElementById('inv-grid')!;
    if (state.inventory.length === 0) {
      grid.innerHTML = `<div class="col-span-3 text-center py-6 text-xs font-mono text-zinc-500">Pack is empty. Scavenge supply crates in buildings!</div>`;
      return;
    }

    grid.innerHTML = state.inventory
      .map((slot, idx) => {
        const rarityBorder =
          slot.item.rarity === 'rare'
            ? 'border-sky-500/60'
            : slot.item.rarity === 'uncommon'
            ? 'border-emerald-500/50'
            : 'border-zinc-700';
        return `
          <button data-inv-idx="${idx}" class="inv-slot-btn p-3 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border ${rarityBorder} text-left transition">
            <div class="flex justify-between items-center mb-1">
              <span class="text-lg">${slot.item.icon}</span>
              <span class="text-xs font-mono text-zinc-300">x${slot.quantity}</span>
            </div>
            <div class="text-xs font-bold text-white">${slot.item.name}</div>
            <div class="text-[10px] text-zinc-400 leading-tight mt-0.5">${slot.item.description}</div>
          </button>
        `;
      })
      .join('');

    grid.querySelectorAll<HTMLElement>('.inv-slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.callbacks.onUseItem(Number(btn.dataset.invIdx));
      });
    });
  }
}
