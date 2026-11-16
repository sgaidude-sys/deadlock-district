import * as THREE from 'three';

export type StoryStage =
  | 'arrive'
  | 'supplies'
  | 'radio'
  | 'fuel'
  | 'night'
  | 'butcher'
  | 'keys'
  | 'truck'
  | 'siege'
  | 'board'
  | 'done';

export type StoryEvent =
  | 'enteredSafehouse'
  | 'lootedSafehouse'
  | 'beacon'
  | 'jerrycan'
  | 'nightfall'
  | 'dawn'
  | 'bossKilled'
  | 'keys'
  | 'truckStarted'
  | 'siegeDone'
  | 'boarded';

export interface RadioLine {
  speaker: string;
  text: string;
}

/** What the director needs to know about (and do to) the world. */
export interface StoryContext {
  jerrycans(): number;
  safehouseSeal(): [number, number];
  isNight(): boolean;
  /** Fast-forward the clock to dusk (story time-skip). */
  skipToDusk(): void;
  spawnBoss(): void;
  bossPosition(): THREE.Vector3 | null;
  keysPosition(): THREE.Vector3 | null;
  interactablePosition(id: string): THREE.Vector3 | null;
  nearestJerrycan(): THREE.Vector3 | null;
  safehouseDoor(): THREE.Vector3;
  truckPosition(): THREE.Vector3;
  siegeSecondsLeft(): number;
  onStageChanged(stage: StoryStage, chapter: number, title: string): void;
}

interface StageDef {
  chapter: number;
  title: string;
  objective: (ctx: StoryContext) => string;
  target: (ctx: StoryContext) => { pos: THREE.Vector3; label: string; color: string } | null;
}

const REYES = 'CPT. REYES — EVAC COMMAND';

const STAGES: Record<StoryStage, StageDef> = {
  arrive: {
    chapter: 1,
    title: 'Day One',
    objective: () => 'Get inside the marked safehouse',
    target: (c) => ({ pos: c.safehouseDoor(), label: 'Safehouse', color: '#f59e0b' }),
  },
  supplies: {
    chapter: 1,
    title: 'Day One',
    objective: () => 'Search the supply crate in the safehouse',
    target: (c) => tgt(c.interactablePosition('crate_safehouse'), 'Supplies', '#fbbf24'),
  },
  radio: {
    chapter: 2,
    title: 'Static',
    objective: () => "Find a working shortwave radio in Joe's Diner",
    target: (c) => tgt(c.interactablePosition('radio_beacon'), 'Radio', '#38bdf8'),
  },
  fuel: {
    chapter: 3,
    title: 'Fuel Run',
    objective: (c) => `Collect fuel for the evac truck (${c.jerrycans()}/3)`,
    target: (c) => tgt(c.nearestJerrycan(), 'Fuel', '#ef4444'),
  },
  night: {
    chapter: 4,
    title: 'Nightfall',
    objective: (c) => {
      const [n, m] = c.safehouseSeal();
      return n < m
        ? `Barricade the safehouse (${n}/${m} entries), then rest until dawn`
        : 'Safehouse sealed — rest in the bed, or hold out until dawn';
    },
    target: (c) => ({ pos: c.safehouseDoor(), label: 'Safehouse', color: '#f59e0b' }),
  },
  butcher: {
    chapter: 5,
    title: 'The Butcher',
    objective: () => 'Hunt down the Butcher in the freight yard — he has the truck keys',
    target: (c) => tgt(c.bossPosition(), 'Butcher', '#dc2626'),
  },
  keys: {
    chapter: 5,
    title: 'The Butcher',
    objective: () => "Take the truck keys from the Butcher's body",
    target: (c) => tgt(c.keysPosition(), 'Keys', '#facc15'),
  },
  truck: {
    chapter: 6,
    title: 'Breakout',
    objective: () => 'Start the armored truck at the North Gate',
    target: (c) => ({ pos: c.truckPosition(), label: 'Truck', color: '#22c55e' }),
  },
  siege: {
    chapter: 6,
    title: 'Breakout',
    objective: (c) => `Defend the truck while the engine warms up — ${Math.ceil(c.siegeSecondsLeft())}s`,
    target: (c) => ({ pos: c.truckPosition(), label: 'Defend', color: '#22c55e' }),
  },
  board: {
    chapter: 6,
    title: 'Breakout',
    objective: () => 'The gate is opening — BOARD THE TRUCK!',
    target: (c) => ({ pos: c.truckPosition(), label: 'Board', color: '#22c55e' }),
  },
  done: {
    chapter: 6,
    title: 'Breakout',
    objective: () => '',
    target: () => null,
  },
};

function tgt(pos: THREE.Vector3 | null, label: string, color: string) {
  return pos ? { pos, label, color } : null;
}

/**
 * Six chapters of objectives, driven by world events, with radio transmissions between them.
 */
export class StoryDirector {
  public stage: StoryStage = 'arrive';
  private ctx: StoryContext;
  private radioQueue: RadioLine[] = [];
  private current: { line: RadioLine; t: number; dur: number } | null = null;
  private onRadioLine?: (line: RadioLine) => void;
  private sawNightfall = false;

  constructor(ctx: StoryContext) {
    this.ctx = ctx;
  }

  public setOnRadioLine(cb: (line: RadioLine) => void): void {
    this.onRadioLine = cb;
  }

  public begin(): void {
    this.say(
      '...anyone still breathing in Sector Four, this is Captain Reyes, Evac Command. Get off the street.',
      "There's a marked safehouse south-west of the main crossing. Get inside before they notice you."
    );
    this.announce();
  }

  public get chapter(): number {
    return STAGES[this.stage].chapter;
  }

  public get title(): string {
    return STAGES[this.stage].title;
  }

  public objective(): string {
    return STAGES[this.stage].objective(this.ctx);
  }

  public target() {
    return STAGES[this.stage].target(this.ctx);
  }

  public radio(): { speaker: string; text: string; progress: number } | null {
    if (!this.current) return null;
    const { line, t, dur } = this.current;
    return { speaker: line.speaker, text: line.text, progress: Math.min(1, t / Math.max(0.5, dur * 0.55)) };
  }

  private say(...lines: string[]): void {
    for (const text of lines) this.radioQueue.push({ speaker: REYES, text });
  }

  private go(stage: StoryStage): void {
    const prevChapter = this.chapter;
    this.stage = stage;
    if (this.chapter !== prevChapter || stage === 'board') this.announce();
  }

  private announce(): void {
    this.ctx.onStageChanged(this.stage, this.chapter, this.title);
  }

  public notify(event: StoryEvent): void {
    switch (event) {
      case 'enteredSafehouse':
        if (this.stage === 'arrive') {
          this.go('supplies');
          this.say(
            'Good. Lock down what you can. There should be a supply drop crate in there — grab it.',
            "If a German Shepherd's hanging around outside, he's friendly. Take him with you."
          );
        }
        break;
      case 'lootedSafehouse':
        if (this.stage === 'supplies') {
          this.go('radio');
          this.say("My transmitter's failing. There's a working shortwave in Joe's Diner, east side. Find it and I can talk you out.");
        }
        break;
      case 'beacon':
        if (this.stage === 'radio' || this.stage === 'supplies' || this.stage === 'arrive') {
          this.go('fuel');
          this.say(
            "Signal's clean now. Listen: there's an armored truck at the North Gate. That's your ride out.",
            "It's bone dry. Find fuel — three cans at least. Try the pharmacy, the freight yard, the wrecks on the avenue."
          );
          if (this.ctx.jerrycans() >= 3) this.notify('jerrycan');
        }
        break;
      case 'jerrycan':
        if (this.stage === 'fuel' && this.ctx.jerrycans() >= 3) {
          this.go('night');
          this.say(
            "That's enough fuel. But it's getting dark, and you can't push through a horde blind.",
            'Get back to the safehouse. Board up every door and window, then rest until dawn. Do not let them in.'
          );
          if (!this.ctx.isNight()) this.ctx.skipToDusk();
        }
        break;
      case 'nightfall':
        if (!this.sawNightfall) {
          this.sawNightfall = true;
          this.say("Hear that siren? That's the Blood Siren. They get faster after dark. Stay off the open street.");
        }
        break;
      case 'dawn':
        if (this.stage === 'night') {
          this.go('butcher');
          this.say(
            "You made it through. Bad news: the truck's driver turned before we could pull him out. He's still got the keys.",
            "Big one. What's left of a butcher's apron. Last seen in the freight yard, north-east. Put him down."
          );
          this.ctx.spawnBoss();
        }
        break;
      case 'bossKilled':
        if (this.stage === 'butcher') {
          this.go('keys');
          this.say("That's him. Get those keys off what's left of him.");
        }
        break;
      case 'keys':
        if (this.stage === 'keys' || this.stage === 'butcher') {
          this.go('truck');
          this.say(
            'Get to the truck. Once that engine turns over, every dead thing for a mile will hear it.',
            "The gate motor runs off the truck. You'll have to hold them off while it warms up."
          );
        }
        break;
      case 'truckStarted':
        if (this.stage === 'truck') {
          this.go('siege');
          this.say('Engine is cold — sixty seconds. Stay close to the truck!');
        }
        break;
      case 'siegeDone':
        if (this.stage === 'siege') {
          this.go('board');
          this.say("Gate motor's live! GET IN THE TRUCK!");
        }
        break;
      case 'boarded':
        this.go('done');
        this.radioQueue = [];
        this.current = null;
        this.say("You're in! Floor it — straight through the gate and don't stop for anything!");
        break;
    }
  }

  public update(dt: number): void {
    if (this.current) {
      this.current.t += dt;
      if (this.current.t >= this.current.dur) this.current = null;
    }
    if (!this.current && this.radioQueue.length) {
      const line = this.radioQueue.shift()!;
      this.current = { line, t: 0, dur: 2.5 + line.text.length * 0.055 };
      this.onRadioLine?.(line);
    }
  }
}
