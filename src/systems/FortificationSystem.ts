import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { AudioManager } from '../core/AudioManager';
import { VFXManager } from '../core/VFXManager';
import { BarricadeInstance, BuildingInfo, EntryPoint, FLOOR_Y } from '../world/CityGenerator';
import { metalPBR, plankPBR } from '../world/ProceduralTextures';
import { InteractableObject } from '../types/game';

/** Barricade tiers: what they cost to build/upgrade and how much punishment they take. */
const LEVELS = [
  { name: 'Open', cost: 0, hp: 0 },
  { name: 'Planks', cost: 10, hp: 110 },
  { name: 'Reinforced', cost: 15, hp: 260 },
] as const;
const REPAIR_COST = 5;

export interface EntrySlot {
  entry: EntryPoint;
  level: 0 | 1 | 2;
  barricade: BarricadeInstance | null;
  /** Visual pieces, removed one by one as the barricade takes damage. */
  pieces: THREE.Object3D[];
  /** Group holding the pieces, positioned across the opening. */
  visual: THREE.Group | null;
  interactable: InteractableObject;
  /** Points just outside / inside the opening, for routing and squeezing through. */
  outside: THREE.Vector3;
  inside: THREE.Vector3;
}

export interface RouteStep {
  point: THREE.Vector3;
  /** Teleport here on arrival (climbing through an open window). */
  vaultTo?: THREE.Vector3;
  /** Barricade blocking the way: attack it on arrival. */
  attack?: BarricadeInstance;
}

export class FortificationSystem {
  public slots: EntrySlot[] = [];
  private buildings: BuildingInfo[];

  private plankMat: THREE.MeshStandardMaterial;
  private darkPlankMat: THREE.MeshStandardMaterial;
  private sheetMat: THREE.MeshStandardMaterial;
  private nailMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.35, metalness: 0.85 });

  constructor(
    private scene: THREE.Scene,
    private physicsWorld: CANNON.World,
    private assets: AssetManager,
    private audio: AudioManager,
    entries: EntryPoint[],
    buildings: BuildingInfo[],
    interactables: InteractableObject[],
    private raycastTargets: THREE.Object3D[],
    private vfx?: VFXManager
  ) {
    this.buildings = buildings;
    const plank = plankPBR();
    const metal = metalPBR();
    this.plankMat = new THREE.MeshStandardMaterial({
      color: 0xc29a72,
      map: plank.map,
      normalMap: plank.normalMap,
      roughnessMap: plank.roughnessMap,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.9,
    });
    this.darkPlankMat = new THREE.MeshStandardMaterial({
      color: 0x7d5a3b,
      map: plank.map,
      normalMap: plank.normalMap,
      roughnessMap: plank.roughnessMap,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.92,
    });
    this.sheetMat = new THREE.MeshStandardMaterial({
      color: 0x8d969e,
      map: metal.map,
      normalMap: metal.normalMap,
      roughnessMap: metal.roughnessMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.55,
      metalness: 0.72,
    });
    // Hidden stand-ins so barricade materials are compiled with the deploy-time shader warm-up
    // instead of on the first hammer swing.
    for (const m of [this.plankMat, this.darkPlankMat, this.sheetMat, this.nailMat]) {
      const stub = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), m);
      stub.position.set(0, -60, 0);
      stub.castShadow = true;
      this.scene.add(stub);
    }
    for (const entry of entries) {
      const interactable: InteractableObject = {
        id: `entry_${entry.id}`,
        type: 'entry',
        label: '',
        position: entry.position.clone().setY(0.8),
        radius: entry.kind === 'door' ? 3.0 : 2.4,
        data: { entryId: entry.id },
      };
      interactables.push(interactable);
      const slot: EntrySlot = {
        entry,
        level: 0,
        barricade: null,
        pieces: [],
        visual: null,
        interactable,
        outside: entry.position.clone().addScaledVector(entry.normal, 1.3),
        inside: entry.position.clone().addScaledVector(entry.normal, -1.4),
      };
      this.slots.push(slot);
      this.refreshLabel(slot);
    }
  }

  public slotFor(interactable: InteractableObject): EntrySlot | undefined {
    return this.slots.find((s) => s.interactable === interactable);
  }

  /** Live list the zombie AI attacks (hp is shared, zombies write to it). */
  public barricades(): BarricadeInstance[] {
    return this.slots.filter((s) => s.barricade).map((s) => s.barricade!);
  }

  public buildingAt(p: THREE.Vector3): BuildingInfo | null {
    for (const b of this.buildings) {
      if (Math.abs(p.x - b.center.x) < b.halfW - 0.15 && Math.abs(p.z - b.center.z) < b.halfD - 0.15) return b;
    }
    return null;
  }

  public isSealed(buildingId: string): boolean {
    const slots = this.slots.filter((s) => s.entry.building === buildingId);
    return slots.length > 0 && slots.every((s) => s.barricade && s.barricade.hp > 0);
  }

  public sealedCount(buildingId: string): [number, number] {
    const slots = this.slots.filter((s) => s.entry.building === buildingId);
    return [slots.filter((s) => s.barricade && s.barricade.hp > 0).length, slots.length];
  }

  // ───────────────────────────── Player actions ─────────────────────────────

  /** E: build planks if open; on a barricaded door squeeze through; on a damaged window repair. */
  public primary(slot: EntrySlot, player: { scrap: number; getPosition(): THREE.Vector3; teleport(p: THREE.Vector3): void }): string {
    if (!slot.barricade) return this.build(slot, player, 1);
    if (slot.entry.kind === 'door') {
      const inside = this.buildingAt(player.getPosition()) !== null;
      player.teleport(inside ? slot.outside : slot.inside);
      this.audio.playUI('crate_creak', 0.5, 0.8);
      this.audio.playUI('gear_rustle', 0.4);
      return inside ? 'You squeeze out past the barricade.' : 'You squeeze in behind the barricade.';
    }
    return this.secondary(slot, player);
  }

  /** G: repair if damaged, otherwise reinforce. */
  public secondary(slot: EntrySlot, player: { scrap: number }): string {
    const b = slot.barricade;
    if (!b) return this.build(slot, player, 1);
    if (b.hp < b.maxHp) {
      if (player.scrap < REPAIR_COST) return `Need ${REPAIR_COST} Scrap to repair.`;
      player.scrap -= REPAIR_COST;
      b.hp = b.maxHp;
      this.rebuildVisual(slot);
      this.hammer(slot);
      this.refreshLabel(slot);
      return `${LEVELS[slot.level].name} repaired.`;
    }
    if (slot.level < 2) return this.build(slot, player, 2);
    return 'Already fully reinforced.';
  }

  private build(slot: EntrySlot, player: { scrap: number }, level: 1 | 2): string {
    const cost = LEVELS[level].cost;
    if (player.scrap < cost) return `Need ${cost} Scrap for ${LEVELS[level].name.toLowerCase()}.`;
    player.scrap -= cost;
    slot.level = level;
    if (!slot.barricade) {
      const body = this.makeBody(slot);
      slot.barricade = {
        id: slot.entry.id,
        interactable: slot.interactable,
        mesh: new THREE.Group(),
        body,
        position: slot.entry.position.clone(),
        hp: LEVELS[level].hp,
        maxHp: LEVELS[level].hp,
      };
    } else {
      slot.barricade.maxHp = LEVELS[level].hp;
      slot.barricade.hp = LEVELS[level].hp;
    }
    this.rebuildVisual(slot);
    this.hammer(slot);
    this.refreshLabel(slot);
    return level === 1
      ? `${slot.entry.kind === 'door' ? 'Door' : 'Window'} boarded up.`
      : `${slot.entry.kind === 'door' ? 'Door' : 'Window'} reinforced with sheet metal.`;
  }

  private hammer(slot: EntrySlot): void {
    const p = slot.entry.position.clone().setY(1.2);
    for (let i = 0; i < 3; i++) setTimeout(() => this.audio.playPositional('hammer', p, 0.7, 0.1, 4), i * 170);
    this.audio.playPositional('wood_hit', p, 0.5, 0.1, 4);
    this.vfx?.spawnWoodSplinters(p, slot.entry.normal, 7, slot.level >= 2);
  }

  /** Called when zombies (or an explosion) destroy a barricade. */
  public destroy(slot: EntrySlot, loud = true): void {
    if (!slot.barricade) return;
    const isMetal = slot.level >= 2;
    this.physicsWorld.removeBody(slot.barricade.body);
    this.clearVisual(slot);
    slot.barricade = null;
    slot.level = 0;
    // Splintered debris left in the opening
    const debris = this.assets.cloneModel('prop_pallet_broken');
    debris.position.copy(slot.outside).setY(FLOOR_Y);
    debris.rotation.y = Math.random() * Math.PI;
    this.scene.add(debris);
    this.vfx?.spawnWoodSplinters(slot.entry.position.clone().setY(1.2), slot.entry.normal.clone().negate(), 16, isMetal);
    if (loud) this.audio.playPositional('wood_break', slot.entry.position, 1.0, 0.08, 8, 0.4);
    this.refreshLabel(slot);
  }

  public slotForBarricade(b: BarricadeInstance): EntrySlot | undefined {
    return this.slots.find((s) => s.barricade === b);
  }

  /** Per frame: drop planks as hp falls; destroy broken ones. */
  public update(): void {
    for (const slot of this.slots) {
      const b = slot.barricade;
      if (!b) continue;
      if (b.hp <= 0) {
        this.destroy(slot);
        continue;
      }
      const keep = Math.max(1, Math.ceil((b.hp / b.maxHp) * slot.pieces.length));
      slot.pieces.forEach((p, i) => (p.visible = i < keep));
      this.refreshLabel(slot);
    }
  }

  // ───────────────────────────── Zombie routing ─────────────────────────────

  /**
   * How a zombie at `from` should head for `to` when a wall is in the way: walk to the nearest
   * usable opening, climb through open windows, and smash whatever barricade blocks the route.
   */
  public route(from: THREE.Vector3, to: THREE.Vector3): RouteStep | null {
    const target = this.buildingAt(to);
    const self = this.buildingAt(from);
    if (target?.id === self?.id) return null; // same space: walk straight

    // Leaving a building first, if the zombie is inside a different one
    const exitFrom = self && self.id !== target?.id ? self : null;
    const building = exitFrom ?? target!;
    const slots = this.slots.filter((s) => s.entry.building === building.id);
    if (!slots.length) return null;
    const startSide = exitFrom ? 'inside' : 'outside';
    const endSide = exitFrom ? 'outside' : 'inside';

    const score = (s: EntrySlot) => {
      const open = !s.barricade;
      return s[startSide].distanceTo(from) + (open ? 0 : 25 + (s.barricade!.hp / 10));
    };
    const best = [...slots].sort((a, b) => score(a) - score(b))[0];
    const approach = best[startSide];
    // "Committed" once at the approach point or already in the opening itself — otherwise a
    // zombie stepping past the approach point toward the doorway got sent back and dithered there.
    const near = from.distanceTo(approach) < 1.1 || from.distanceTo(best.entry.position) < 1.5;
    if (best.barricade) return { point: approach, attack: best.barricade };
    if (!near) return { point: approach };
    return best.entry.kind === 'window' ? { point: approach, vaultTo: best[endSide] } : { point: best[endSide] };
  }

  // ───────────────────────────── Rest until dawn ─────────────────────────────

  /**
   * One step of the resting time-lapse: the horde hammers at the safehouse. Damage scales with
   * how many zombies are about and is spread across entries, weaker ones getting hit harder.
   */
  public siegeTick(buildingId: string, intensity: number, dtSim: number): EntrySlot | null {
    const slots = this.slots.filter((s) => s.entry.building === buildingId && s.barricade);
    for (const s of slots) {
      const weakness = s.level === 2 ? 0.55 : 1;
      // ≈0.045 hits per sim-second at intensity 1 → planks lose ~70 of 110 hp over a full night
      if (Math.random() < 0.045 * intensity * dtSim) {
        s.barricade!.hp -= (6 + Math.random() * 14) * weakness * intensity;
        this.audio.playPositional(Math.random() < 0.5 ? 'wood_hit' : 'impact_wood', s.entry.position, 0.35, 0.15, 4);
      }
      if (s.barricade!.hp <= 0) return s;
    }
    return null;
  }

  // ───────────────────────────── Visuals ─────────────────────────────

  private refreshLabel(slot: EntrySlot): void {
    const what = slot.entry.kind === 'door' ? 'Door' : 'Window';
    const it = slot.interactable;
    const b = slot.barricade;
    if (!b) {
      it.label = `Board up ${what.toLowerCase()}`;
      it.subLabel = `[E] Planks · ${LEVELS[1].cost} Scrap`;
      return;
    }
    const hp = `${Math.max(0, Math.ceil(b.hp))}/${b.maxHp}`;
    it.label = `${LEVELS[slot.level].name} ${what.toLowerCase()} · ${hp}`;
    const fix = b.hp < b.maxHp ? `Repair · ${REPAIR_COST} Scrap` : slot.level < 2 ? `Reinforce · ${LEVELS[2].cost} Scrap` : 'Fully reinforced';
    it.subLabel = slot.entry.kind === 'door' ? `[E] Squeeze through · [G] ${fix}` : `[E] ${fix}`;
  }

  private makeBody(slot: EntrySlot): CANNON.Body {
    const e = slot.entry;
    const sx = e.horizontal ? e.width : 0.5;
    const sz = e.horizontal ? 0.5 : e.width;
    const hy = e.kind === 'door' ? 1.3 : 1.6;
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx / 2, hy, sz / 2)),
      position: new CANNON.Vec3(e.position.x, hy, e.position.z),
    });
    this.physicsWorld.addBody(body);
    return body;
  }

  /** Boards (level 1) plus sheet metal and extra cross-bracing (level 2), nailed across the opening. */
  private clearVisual(slot: EntrySlot): void {
    if (slot.visual) this.scene.remove(slot.visual);
    for (const p of slot.pieces) {
      const i = this.raycastTargets.indexOf(p);
      if (i >= 0) this.raycastTargets.splice(i, 1);
    }
    slot.pieces = [];
    slot.visual = null;
  }

  private rebuildVisual(slot: EntrySlot): void {
    this.clearVisual(slot);
    const e = slot.entry;
    const frame = new THREE.Group();
    frame.position.copy(e.position).addScaledVector(e.normal, 0.28);
    frame.rotation.y = Math.atan2(e.normal.x, e.normal.z);
    this.scene.add(frame);
    slot.visual = frame;

    const isDoor = e.kind === 'door';
    const width = e.width + 0.3;
    const y0 = isDoor ? 0.25 : 1.05;
    const y1 = isDoor ? 2.5 : 2.2;
    const add = (mesh: THREE.Mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Each piece is its own object so damage can knock individual boards off. Boards are NOT
      // bullet targets: you can shoot through the gaps at whatever is tearing them down.
      const world = new THREE.Group();
      world.add(mesh);
      frame.add(world);
      slot.pieces.push(world);
    };
    const count = isDoor ? 6 : 4;
    for (let i = 0; i < count; i++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(width, 0.2, 0.05), i % 2 ? this.plankMat : this.darkPlankMat);
      plank.position.set(0, y0 + ((y1 - y0) * (i + 0.5)) / count, 0);
      plank.rotation.z = (Math.random() - 0.5) * 0.18;
      for (const sx of [-1, 1]) {
        const nail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), this.nailMat);
        nail.position.set(sx * (width / 2 - 0.12), 0, 0.03);
        plank.add(nail);
      }
      add(plank);
    }
    if (slot.level >= 2) {
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, (y1 - y0) * 0.85, 0.03), this.sheetMat);
      sheet.position.set(0, (y0 + y1) / 2, 0.06);
      sheet.rotation.z = 0.03;
      add(sheet);
      for (const dir of [-1, 1]) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(width, y1 - y0) * 0.95, 0.16, 0.06), this.darkPlankMat);
        brace.position.set(0, (y0 + y1) / 2, 0.1);
        brace.rotation.z = dir * Math.atan2(y1 - y0, width);
        add(brace);
      }
    }
    slot.pieces.forEach((p) => (p.visible = true));
  }
}
