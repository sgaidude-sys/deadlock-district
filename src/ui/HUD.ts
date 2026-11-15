import { WEAPONS } from '../data/catalog';
import { HUDState, SurvivorId, WeaponId } from '../types/game';

export interface HUDCallbacks {
  onStartGame: (survivor: SurvivorId) => void;
  onUseItem: (index: number) => void;
  onCraftMedkit: () => void;
  onCraftAmmo: (type: 'pistol' | 'shells' | 'rifle') => void;
  onToggleMute: () => void;
  onResumePointerLock: () => void;
}

export class HUD {
  private root: HTMLElement;
  private callbacks: HUDCallbacks;

  private selectedSurvivor: SurvivorId = 'matt';
  private screen: 'loading' | 'title' | 'playing' | 'gameover' | 'victory' = 'loading';

  private loadBarEl!: HTMLElement;
  private loadLabelEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private hudEl!: HTMLElement;
  private inventoryEl!: HTMLElement;
  private endEl!: HTMLElement;

  constructor(root: HTMLElement, callbacks: HUDCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.buildDOM();
  }

  private buildDOM(): void {
    this.root.innerHTML = `
      <!-- Loading / Title Screen -->
      <div id="screen-title" class="fixed inset-0 flex items-center justify-center bg-zinc-950/95 pointer-events-auto z-40">
        <div class="max-w-2xl w-full mx-4 p-8 rounded-2xl hud-glass shadow-2xl border border-zinc-800">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-mono uppercase tracking-[0.25em] text-red-500">Quarantine Sector 04</span>
            <span class="text-xs font-mono text-zinc-500">THREE.JS // CANNON-ES</span>
          </div>
          <h1 class="text-5xl font-black tracking-tight text-white mb-2">DEADLOCK <span class="text-red-600">DISTRICT</span></h1>
          <p class="text-sm text-zinc-400 mb-6">Scavenge interiors, fortify safehouses, survive the Blood Siren nightfall, and extract with 3 Fuel Jerrycans + Radio Beacon.</p>

          <!-- Progress -->
          <div id="loading-panel" class="mb-6">
            <div class="flex justify-between text-xs font-mono text-zinc-400 mb-1.5">
              <span id="load-label">Initializing asset pipeline...</span>
              <span id="load-pct">0%</span>
            </div>
            <div class="w-full h-2 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
              <div id="load-bar" class="h-full bg-gradient-to-r from-red-700 to-amber-500 transition-all duration-150" style="width: 0%"></div>
            </div>
          </div>

          <!-- Survivor Picker & Start (hidden until loaded) -->
          <div id="ready-panel" class="hidden space-y-5">
            <div>
              <div class="text-xs font-mono uppercase tracking-wider text-zinc-400 mb-2">Select Survivor</div>
              <div class="grid grid-cols-4 gap-2.5" id="survivor-grid">
                ${(['matt', 'lis', 'sam', 'shaun'] as SurvivorId[])
                  .map(
                    (id, i) => `
                  <button data-survivor="${id}" class="surv-btn px-3 py-2.5 rounded-lg border text-left transition ${
                      i === 0
                        ? 'border-red-500 bg-red-950/40 text-white'
                        : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600'
                    }">
                    <div class="text-sm font-bold capitalize">${id}</div>
                    <div class="text-[10px] font-mono text-zinc-400">Survivor</div>
                  </button>
                `
                  )
                  .join('')}
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 text-xs text-zinc-300 bg-zinc-900/60 p-3.5 rounded-xl border border-zinc-800/80 font-mono">
              <div><span class="text-amber-400">WASD + Shift</span> Move / Sprint</div>
              <div><span class="text-amber-400">LMB / RMB</span> Fire / Aim</div>
              <div><span class="text-amber-400">E / R / F</span> Interact / Reload / Light</div>
              <div><span class="text-amber-400">Tab / Q / C</span> Bag / Medkit / Crouch</div>
            </div>

            <button id="btn-deploy" class="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 active:scale-[0.99] text-white font-bold tracking-wider uppercase transition shadow-lg shadow-red-900/40">
              Deploy Into Quarantine Zone
            </button>
          </div>
        </div>
      </div>

      <!-- In-Game HUD -->
      <div id="screen-hud" class="hidden fixed inset-0 pointer-events-none">
        <!-- Blood Damage Vignette -->
        <div id="damage-vignette" class="fixed inset-0 vignette-blood opacity-0 transition-opacity duration-150"></div>

        <!-- Top-Center Clock, Phase, Noise & Objectives -->
        <div class="fixed top-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <div class="hud-glass px-5 py-2 rounded-full flex items-center gap-4 text-xs font-mono">
            <span id="hud-day" class="text-zinc-300 font-bold">DAY 1</span>
            <span id="hud-phase" class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold uppercase">DAYLIGHT</span>
            <div class="flex items-center gap-1.5">
              <span class="text-zinc-500">NOISE</span>
              <div class="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div id="hud-noise-bar" class="h-full bg-emerald-400 transition-all duration-75" style="width: 0%"></div>
              </div>
            </div>
            <span id="hud-kills" class="text-zinc-400">KILLS: <b class="text-white">0</b></span>
          </div>

          <div id="hud-objectives" class="hud-glass px-4 py-1.5 rounded-lg flex items-center gap-4 text-[11px] font-mono text-zinc-300">
            <span id="obj-cans">🛢️ Fuel: 0/3</span>
            <span id="obj-beacon">📻 Beacon: Missing</span>
            <span id="obj-extract" class="text-amber-400 hidden">🚐 HOLD OUT: 60s</span>
          </div>

          <div id="hud-dog-ping" class="hidden px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-200 text-xs font-mono animate-pulse">
            🐕 K9 ALERT: ZOMBIES NEARBY!
          </div>
        </div>

        <!-- Toast Banner -->
        <div id="hud-toast" class="hidden fixed top-28 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg hud-glass border-amber-500/40 text-amber-200 text-sm font-medium shadow-lg"></div>

        <!-- Center Crosshair & Interact Prompt -->
        <div class="fixed inset-0 flex items-center justify-center">
          <div id="crosshair" class="relative w-6 h-6 flex items-center justify-center">
            <div class="w-1 h-1 rounded-full bg-white/90"></div>
            <div id="ch-top" class="absolute w-0.5 h-2 bg-white/75 -top-1"></div>
            <div id="ch-bot" class="absolute w-0.5 h-2 bg-white/75 -bottom-1"></div>
            <div id="ch-left" class="absolute h-0.5 w-2 bg-white/75 -left-1"></div>
            <div id="ch-right" class="absolute h-0.5 w-2 bg-white/75 -right-1"></div>
            <div id="hit-marker" class="hidden absolute inset-0 text-red-500 font-bold text-lg flex items-center justify-center">✕</div>
          </div>
        </div>

        <div id="interact-prompt" class="hidden fixed bottom-36 left-1/2 -translate-x-1/2 hud-glass px-4 py-2.5 rounded-xl text-center">
          <div id="interact-title" class="text-sm font-bold text-white"></div>
          <div id="interact-sub" class="text-[11px] font-mono text-amber-300"></div>
        </div>

        <!-- Bottom-Left Vitals -->
        <div class="fixed bottom-5 left-5 hud-glass p-4 rounded-2xl w-64 space-y-2.5">
          <div>
            <div class="flex justify-between text-xs font-mono mb-1">
              <span class="text-red-400 font-bold">HEALTH</span>
              <span id="val-hp" class="text-white">100</span>
            </div>
            <div class="w-full h-2 bg-zinc-900 rounded-full overflow-hidden">
              <div id="bar-hp" class="h-full bg-red-500 transition-all duration-100" style="width: 100%"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between text-[11px] font-mono mb-1">
              <span class="text-sky-400">STAMINA</span>
              <span id="val-stam" class="text-zinc-300">100</span>
            </div>
            <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
              <div id="bar-stam" class="h-full bg-sky-400 transition-all duration-75" style="width: 100%"></div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 pt-1">
            <div>
              <div class="text-[10px] font-mono text-amber-400 mb-0.5">HUNGER</div>
              <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                <div id="bar-hunger" class="h-full bg-amber-500" style="width: 100%"></div>
              </div>
            </div>
            <div>
              <div class="text-[10px] font-mono text-cyan-400 mb-0.5">THIRST</div>
              <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                <div id="bar-thirst" class="h-full bg-cyan-400" style="width: 100%"></div>
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between pt-1 border-t border-zinc-800 text-[11px] font-mono text-zinc-400">
            <span>⚙️ SCRAP: <b id="val-scrap" class="text-white">20</b></span>
            <span>[Q] Heal • [F] Light</span>
          </div>
        </div>

        <!-- Bottom-Right Weapon & Ammo -->
        <div class="fixed bottom-5 right-5 hud-glass p-4 rounded-2xl w-64 text-right">
          <div id="wpn-name" class="text-sm font-bold text-white tracking-wide">M9 Tactical Pistol</div>
          <div id="wpn-reload" class="hidden text-xs font-mono text-amber-400 my-1">RELOADING...</div>
          <div class="flex items-baseline justify-end gap-1.5 my-1">
            <span id="wpn-mag" class="text-3xl font-black font-mono text-white">15</span>
            <span id="wpn-reserve" class="text-sm font-mono text-zinc-400">/ 45</span>
          </div>
          <div id="wpn-slots" class="flex justify-end gap-1 mt-2"></div>
        </div>

        <!-- Click to Resume PointerLock hint -->
        <div id="pause-hint" class="hidden fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-zinc-900/90 border border-zinc-700 text-xs font-mono text-zinc-300 pointer-events-auto cursor-pointer">
          Click anywhere to lock mouse & aim • [Tab] Inventory
        </div>
      </div>

      <!-- Inventory & Crafting Modal -->
      <div id="screen-inventory" class="hidden fixed inset-0 flex items-center justify-center bg-black/65 pointer-events-auto z-30">
        <div class="max-w-2xl w-full mx-4 p-6 rounded-2xl hud-glass border border-zinc-700/80 shadow-2xl">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-xl font-bold text-white">Survivor Pack & Crafting</h2>
              <p class="text-xs font-mono text-zinc-400">Click an item to use/consume • Press [Tab] to close</p>
            </div>
            <div class="flex items-center gap-2">
              <button id="btn-mute" class="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-200">Mute Audio</button>
              <button id="btn-close-inv" class="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-bold text-white">Resume</button>
            </div>
          </div>

          <div id="inv-grid" class="grid grid-cols-3 gap-2.5 max-h-60 overflow-y-auto mb-5"></div>

          <div class="border-t border-zinc-800 pt-4">
            <div class="text-xs font-mono uppercase tracking-wider text-amber-400 mb-2">Field Crafting (Uses Scrap: <span id="craft-scrap">0</span>)</div>
            <div class="grid grid-cols-4 gap-2">
              <button id="craft-medkit" class="p-2.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-700 text-left">
                <div class="text-xs font-bold text-white">🩹 Medkit</div>
                <div class="text-[10px] font-mono text-amber-400">15 Scrap</div>
              </button>
              <button id="craft-pistol" class="p-2.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-700 text-left">
                <div class="text-xs font-bold text-white">🔫 +15 9mm</div>
                <div class="text-[10px] font-mono text-amber-400">8 Scrap</div>
              </button>
              <button id="craft-shells" class="p-2.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-700 text-left">
                <div class="text-xs font-bold text-white">🧨 +6 Shells</div>
                <div class="text-[10px] font-mono text-amber-400">12 Scrap</div>
              </button>
              <button id="craft-rifle" class="p-2.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-700 text-left">
                <div class="text-xs font-bold text-white">🎯 +15 Rifle</div>
                <div class="text-[10px] font-mono text-amber-400">12 Scrap</div>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- End Screen (Victory / Game Over) -->
      <div id="screen-end" class="hidden fixed inset-0 flex items-center justify-center bg-black/85 pointer-events-auto z-50">
        <div class="max-w-md w-full mx-4 p-8 rounded-2xl hud-glass text-center border border-zinc-700">
          <h2 id="end-title" class="text-4xl font-black mb-2">EXTRACTED</h2>
          <p id="end-sub" class="text-sm text-zinc-300 mb-6"></p>
          <button id="btn-restart" class="w-full py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold uppercase tracking-wider">
            Play Again
          </button>
        </div>
      </div>
    `;

    this.loadBarEl = document.getElementById('load-bar')!;
    this.loadLabelEl = document.getElementById('load-label')!;
    this.titleEl = document.getElementById('screen-title')!;
    this.hudEl = document.getElementById('screen-hud')!;
    this.inventoryEl = document.getElementById('screen-inventory')!;
    this.endEl = document.getElementById('screen-end')!;

    // Survivor picker
    this.root.querySelectorAll('.surv-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedSurvivor = btn.getAttribute('data-survivor') as SurvivorId;
        this.root.querySelectorAll('.surv-btn').forEach((b) => {
          b.className =
            'surv-btn px-3 py-2.5 rounded-lg border text-left transition border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600';
        });
        btn.className =
          'surv-btn px-3 py-2.5 rounded-lg border text-left transition border-red-500 bg-red-950/40 text-white';
      });
    });

    document.getElementById('btn-deploy')!.addEventListener('click', () => {
      this.titleEl.classList.add('hidden');
      this.hudEl.classList.remove('hidden');
      this.screen = 'playing';
      this.callbacks.onStartGame(this.selectedSurvivor);
    });

    document.getElementById('btn-close-inv')!.addEventListener('click', () => {
      this.callbacks.onResumePointerLock();
    });
    document.getElementById('pause-hint')!.addEventListener('click', () => {
      this.callbacks.onResumePointerLock();
    });
    document.getElementById('btn-mute')!.addEventListener('click', () => {
      this.callbacks.onToggleMute();
    });
    document.getElementById('craft-medkit')!.addEventListener('click', () => {
      this.callbacks.onCraftMedkit();
    });
    document.getElementById('craft-pistol')!.addEventListener('click', () => {
      this.callbacks.onCraftAmmo('pistol');
    });
    document.getElementById('craft-shells')!.addEventListener('click', () => {
      this.callbacks.onCraftAmmo('shells');
    });
    document.getElementById('craft-rifle')!.addEventListener('click', () => {
      this.callbacks.onCraftAmmo('rifle');
    });
    document.getElementById('btn-restart')!.addEventListener('click', () => {
      window.location.reload();
    });
  }

  public setLoadProgress(loaded: number, total: number, label: string): void {
    const pct = Math.round((loaded / Math.max(1, total)) * 100);
    this.loadBarEl.style.width = `${pct}%`;
    this.loadLabelEl.textContent = `Loading: ${label}`;
    document.getElementById('load-pct')!.textContent = `${pct}%`;

    if (loaded >= total) {
      document.getElementById('loading-panel')!.classList.add('hidden');
      document.getElementById('ready-panel')!.classList.remove('hidden');
      this.screen = 'title';
    }
  }

  public showEndScreen(victory: boolean, kills: number, days: number): void {
    this.screen = victory ? 'victory' : 'gameover';
    this.hudEl.classList.add('hidden');
    this.inventoryEl.classList.add('hidden');
    this.endEl.classList.remove('hidden');

    const title = document.getElementById('end-title')!;
    const sub = document.getElementById('end-sub')!;
    if (victory) {
      title.textContent = 'EXTRACTION COMPLETE';
      title.className = 'text-4xl font-black mb-2 text-emerald-400';
      sub.textContent = `You fueled the armored truck and escaped Deadlock District in ${days} day(s) with ${kills} zombie kills.`;
    } else {
      title.textContent = 'YOU WERE OVERRUN';
      title.className = 'text-4xl font-black mb-2 text-red-500';
      sub.textContent = `Fallen in Quarantine Sector 04 on Day ${days} after eliminating ${kills} infected.`;
    }
  }

  public update(state: HUDState, isPointerLocked: boolean): void {
    if (this.screen !== 'playing') return;

    // Vitals
    document.getElementById('val-hp')!.textContent = `${Math.ceil(state.health)}`;
    document.getElementById('bar-hp')!.style.width = `${state.health}%`;
    document.getElementById('val-stam')!.textContent = `${Math.ceil(state.stamina)}`;
    document.getElementById('bar-stam')!.style.width = `${state.stamina}%`;
    document.getElementById('bar-hunger')!.style.width = `${state.hunger}%`;
    document.getElementById('bar-thirst')!.style.width = `${state.thirst}%`;
    document.getElementById('val-scrap')!.textContent = `${state.scrap}`;

    // Damage vignette
    const vig = document.getElementById('damage-vignette')!;
    vig.style.opacity = state.damageFlashTimer > 0 ? '0.9' : state.health < 30 ? '0.45' : '0';

    // Top Clock & Phase
    document.getElementById('hud-day')!.textContent = `DAY ${state.dayNumber}`;
    const phaseEl = document.getElementById('hud-phase')!;
    if (state.extractionActive) {
      phaseEl.textContent = 'FINAL SIEGE';
      phaseEl.className = 'px-2 py-0.5 rounded bg-red-600/30 text-red-400 font-bold animate-pulse';
    } else if (state.phase === 'night') {
      phaseEl.textContent = 'BLOOD SIREN';
      phaseEl.className = 'px-2 py-0.5 rounded bg-red-900/50 text-red-300 font-bold';
    } else if (state.phase === 'dusk') {
      phaseEl.textContent = 'DUSK';
      phaseEl.className = 'px-2 py-0.5 rounded bg-orange-500/25 text-orange-300 font-bold';
    } else {
      phaseEl.textContent = 'DAYLIGHT';
      phaseEl.className = 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold';
    }

    // Noise bar
    const noiseBar = document.getElementById('hud-noise-bar')!;
    noiseBar.style.width = `${state.noiseLevel}%`;
    noiseBar.className = `h-full transition-all duration-75 ${
      state.noiseLevel > 60 ? 'bg-red-500' : state.noiseLevel > 25 ? 'bg-amber-400' : 'bg-emerald-400'
    }`;
    document.getElementById('hud-kills')!.innerHTML = `KILLS: <b class="text-white">${state.kills}</b>`;

    // Objectives
    document.getElementById('obj-cans')!.textContent = `🛢️ Fuel: ${state.jerrycansCollected}/3`;
    document.getElementById('obj-beacon')!.textContent = state.beaconCollected
      ? '📻 Beacon: Ready ✓'
      : '📻 Beacon: Missing';
    const extEl = document.getElementById('obj-extract')!;
    if (state.extractionActive) {
      extEl.classList.remove('hidden');
      extEl.textContent = `🚐 HOLD OUT: ${Math.ceil(state.extractionTimer)}s`;
    } else {
      extEl.classList.add('hidden');
    }

    // Dog alert
    document.getElementById('hud-dog-ping')!.classList.toggle('hidden', state.dogAlertTimer <= 0);

    // Toast
    const toastEl = document.getElementById('hud-toast')!;
    if (state.toastMessage) {
      toastEl.textContent = state.toastMessage;
      toastEl.classList.remove('hidden');
    } else {
      toastEl.classList.add('hidden');
    }

    // Crosshair & Hit marker
    document.getElementById('hit-marker')!.classList.toggle('hidden', state.hitMarkerTimer <= 0);
    const ch = document.getElementById('crosshair')!;
    const spreadPx = state.isAiming ? 2 : 6 + state.crosshairSpread * 18;
    (document.getElementById('ch-top') as HTMLElement).style.transform = `translateY(-${spreadPx}px)`;
    (document.getElementById('ch-bot') as HTMLElement).style.transform = `translateY(${spreadPx}px)`;
    (document.getElementById('ch-left') as HTMLElement).style.transform = `translateX(-${spreadPx}px)`;
    (document.getElementById('ch-right') as HTMLElement).style.transform = `translateX(${spreadPx}px)`;
    ch.classList.toggle('opacity-0', state.inventoryOpen);

    // Interact prompt
    const promptEl = document.getElementById('interact-prompt')!;
    if (state.nearbyInteractable && !state.inventoryOpen) {
      promptEl.classList.remove('hidden');
      document.getElementById('interact-title')!.textContent = `[E] ${state.nearbyInteractable.label}`;
      document.getElementById('interact-sub')!.textContent = state.nearbyInteractable.subLabel ?? '';
    } else {
      promptEl.classList.add('hidden');
    }

    // Weapon HUD
    const w = state.equippedWeapon;
    document.getElementById('wpn-name')!.textContent = w.name;
    document.getElementById('wpn-reload')!.classList.toggle('hidden', !state.isReloading);
    if (w.isMelee) {
      document.getElementById('wpn-mag')!.textContent = 'MELEE';
      document.getElementById('wpn-reserve')!.textContent = '';
    } else {
      document.getElementById('wpn-mag')!.textContent = `${state.magAmmo[w.id]}`;
      document.getElementById('wpn-reserve')!.textContent = `/ ${w.ammoType ? state.reserveAmmo[w.ammoType] : 0}`;
    }

    const slotsEl = document.getElementById('wpn-slots')!;
    slotsEl.innerHTML = (['axe', 'pistol', 'shotgun', 'smg', 'rifle', 'sniper'] as WeaponId[])
      .map((id) => {
        const def = WEAPONS[id];
        const unlocked = state.unlockedWeapons.includes(id);
        const active = w.id === id;
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono border ${
          active
            ? 'border-red-500 bg-red-600/30 text-white'
            : unlocked
            ? 'border-zinc-700 bg-zinc-900/70 text-zinc-400'
            : 'border-zinc-900 bg-zinc-950/50 text-zinc-700'
        }">${def.slot}</span>`;
      })
      .join('');

    // Pause hint & Inventory modal
    document.getElementById('pause-hint')!.classList.toggle('hidden', isPointerLocked || state.inventoryOpen);
    this.inventoryEl.classList.toggle('hidden', !state.inventoryOpen);
    if (state.inventoryOpen) {
      this.renderInventory(state);
    }
  }

  private renderInventory(state: HUDState): void {
    document.getElementById('craft-scrap')!.textContent = `${state.scrap}`;
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

    grid.querySelectorAll('.inv-slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-inv-idx'));
        this.callbacks.onUseItem(idx);
      });
    });
  }
}
