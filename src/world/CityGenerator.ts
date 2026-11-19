import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { ObjectiveMarker, VFXManager } from '../core/VFXManager';
import { InteractableObject } from '../types/game';
import {
  brickPBR,
  concretePBR,
  facadeTextures,
  grassPBR,
  groundPBR,
  metalPBR,
  plankPBR,
  roofPBR,
  tiledPBR,
  woodFloorPBR,
} from './ProceduralTextures';
import { applyWindSway } from '../core/EnvironmentFX';

export interface StreetLightNode {
  light: THREE.PointLight;
  bulbMat: THREE.MeshStandardMaterial;
  baseIntensity: number;
  /** Some lamps die at night, the rest flicker. */
  failsAtNight: boolean;
  /** Halo sprite around the bulb and the visible light cone under it (fog / rain). */
  glow?: THREE.Sprite;
  cone?: THREE.Mesh;
}

export interface ExplosiveBarrel {
  id: string;
  mesh: THREE.Group;
  body: CANNON.Body;
  position: THREE.Vector3;
  exploded: boolean;
}

export interface VehicleInstance {
  id: string;
  mesh: THREE.Group;
  position: THREE.Vector3;
  /** Per-vehicle head/brake-light materials so alarms can flash them. */
  lightMats: THREE.MeshStandardMaterial[];
  alarmCooldown: number;
}

export type SurfaceType = 'concrete' | 'grass' | 'wood';

/** A doorway or window opening that can be barricaded (and that zombies route through). */
export interface EntryPoint {
  id: string;
  building: string;
  kind: 'door' | 'window';
  /** Centre of the opening on the wall line (y = 0). */
  position: THREE.Vector3;
  /** Points to the outside of the building. */
  normal: THREE.Vector3;
  horizontal: boolean;
  width: number;
}

export interface BuildingInfo {
  id: string;
  center: THREE.Vector3;
  halfW: number;
  halfD: number;
}

export interface GateInfo {
  mesh: THREE.Object3D;
  body: CANNON.Body;
}

export interface TruckInfo {
  root: THREE.Group;
  wheels: THREE.Object3D[];
}

export interface BurningBarrel {
  light: THREE.PointLight;
  baseIntensity: number;
  phase: number;
}

export interface BarricadeInstance {
  id: string;
  interactable: InteractableObject;
  mesh: THREE.Object3D;
  body: CANNON.Body;
  position: THREE.Vector3;
  hp: number;
  maxHp: number;
}

export interface CityWorldData {
  /** Everything bullets can hit (static world). */
  raycastTargets: THREE.Object3D[];
  /** Solid meshes the third-person camera must not pass through. */
  cameraOccluders: THREE.Object3D[];
  /** Simple box meshes that block zombie line-of-sight. */
  sightBlockers: THREE.Object3D[];
  interactables: InteractableObject[];
  streetLights: StreetLightNode[];
  burningBarrels: BurningBarrel[];
  windowMaterials: THREE.MeshStandardMaterial[];
  extractionBeaconLight: THREE.PointLight;
  extractionMarker: ObjectiveMarker;
  extractionPosition: THREE.Vector3;
  campfirePosition: THREE.Vector3;
  dogSpawnPosition: THREE.Vector3;
  zombieSpawnPoints: THREE.Vector3[];
  explosiveBarrels: ExplosiveBarrel[];
  vehicles: VehicleInstance[];
  firePositions: THREE.Vector3[];
  jukeboxPosition: THREE.Vector3;
  surfaceAt: (x: number, z: number) => SurfaceType;
  entries: EntryPoint[];
  buildings: BuildingInfo[];
  gate: GateInfo;
  truck: TruckInfo;
  /** Yard spot where the Butcher waits. */
  bossSpawn: THREE.Vector3;
}

/** Interior footprints of the enterable buildings (for footstep surfaces). */
const BUILDINGS: [number, number][] = [
  [-26, 26],
  [-26, -26],
  [26, 26],
];

/** Top of sidewalk / interior floors. */
export const FLOOR_Y = 0.06;
const TILE = 8;
const ROAD_EXTENT = 64;
const BUILDING_H = 3.6;

export class CityGenerator {
  private scene: THREE.Scene;
  private physicsWorld: CANNON.World;
  private assets: AssetManager;
  private vfx: VFXManager;

  private raycastTargets: THREE.Object3D[] = [];
  private cameraOccluders: THREE.Object3D[] = [];
  private sightBlockers: THREE.Object3D[] = [];
  private interactables: InteractableObject[] = [];
  private streetLights: StreetLightNode[] = [];
  private burningBarrels: BurningBarrel[] = [];
  private explosiveBarrels: ExplosiveBarrel[] = [];
  private vehicles: VehicleInstance[] = [];
  private firePositions: THREE.Vector3[] = [];
  private jukeboxPosition = new THREE.Vector3();
  private entries: EntryPoint[] = [];
  private buildings: BuildingInfo[] = [];
  private gate!: GateInfo;
  private truck!: TruckInfo;
  private windowMaterials: THREE.MeshStandardMaterial[] = [];

  private woodMat: THREE.MeshStandardMaterial;
  private darkWoodMat: THREE.MeshStandardMaterial;
  private metalMat: THREE.MeshStandardMaterial;
  private roofMat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, physicsWorld: CANNON.World, assets: AssetManager, vfx: VFXManager) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.vfx = vfx;

    const plank = plankPBR();
    const metal = metalPBR();
    const roof = roofPBR();

    this.woodMat = new THREE.MeshStandardMaterial({
      color: 0xb89678,
      map: plank.map,
      normalMap: plank.normalMap,
      roughnessMap: plank.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.9,
    });
    this.darkWoodMat = new THREE.MeshStandardMaterial({
      color: 0x6b4f3a,
      map: plank.map,
      normalMap: plank.normalMap,
      roughnessMap: plank.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.92,
    });
    this.metalMat = new THREE.MeshStandardMaterial({
      color: 0x9aa2aa,
      map: metal.map,
      normalMap: metal.normalMap,
      roughnessMap: metal.roughnessMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.65,
      metalness: 0.65,
    });
    this.roofMat = new THREE.MeshStandardMaterial({
      color: 0xa2a4a8,
      map: roof.map,
      normalMap: roof.normalMap,
      roughnessMap: roof.roughnessMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.96,
    });
  }

  /** Rescale BoxGeometry UVs so a shared tiling texture keeps a constant world-space density. */
  private static tileBox(geo: THREE.BoxGeometry, sx: number, sy: number, sz: number, tile: number): THREE.BoxGeometry {
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const dims: [number, number][] = [
      [sz, sy],
      [sz, sy],
      [sx, sz],
      [sx, sz],
      [sx, sy],
      [sx, sy],
    ];
    for (let f = 0; f < 6; f++) {
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile);
      }
    }
    uv.needsUpdate = true;
    return geo;
  }

  private texturedBox(sx: number, sy: number, sz: number, mat: THREE.Material, tile = 3): THREE.Mesh {
    const mesh = new THREE.Mesh(CityGenerator.tileBox(new THREE.BoxGeometry(sx, sy, sz), sx, sy, sz, tile), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  public generate(): CityWorldData {
    this.buildGround();
    this.buildStreets();
    this.buildPerimeterWalls();

    const campfirePos = new THREE.Vector3(-26, 0, 24);
    this.buildEnterableBuilding('Safehouse', -26, 26, 16, 14, 0xb8aca2, 'north', 'SAFEHOUSE', '#f59e0b', [
      ['west', 2],
      ['south', 3.5],
    ]);
    this.populateSafehouse(-26, 26);

    this.buildEnterableBuilding('Pharmacy', -26, -26, 16, 14, 0xa9b4b8, 'south', '+ PHARMACY', '#22c55e', [['north', -3]]);
    this.populatePharmacy(-26, -26);

    this.buildEnterableBuilding('Diner', 26, 26, 16, 14, 0xc4a49a, 'west', "JOE'S DINER", '#ef4444', [['south', 1]]);
    this.populateDiner(26, 26);

    this.buildYard(26, -26);
    this.buildOuterBlocks();
    this.buildStreetFurniture();
    this.buildVehiclesAndCover();
    this.scatterDebris();
    this.plantNature();
    this.placeExplosiveBarrels();

    for (const [x, z] of [
      [-7, 7],
      [7, -9],
      [-16, 12],
      [9, -44],
      [42, 7],
      [-42, -7],
    ]) {
      this.placeBurningBarrel(x, z);
    }

    const extractionPos = new THREE.Vector3(0, 0, -58);
    const { light: extractionLight, marker: extractionMarker } = this.buildExtractionZone(extractionPos);

    return {
      raycastTargets: this.raycastTargets,
      cameraOccluders: this.cameraOccluders,
      sightBlockers: this.sightBlockers,
      interactables: this.interactables,
      streetLights: this.streetLights,
      burningBarrels: this.burningBarrels,
      windowMaterials: this.windowMaterials,
      extractionBeaconLight: extractionLight,
      extractionMarker,
      extractionPosition: extractionPos,
      campfirePosition: campfirePos,
      dogSpawnPosition: new THREE.Vector3(-14, 0, 11),
      explosiveBarrels: this.explosiveBarrels,
      vehicles: this.vehicles,
      firePositions: this.firePositions,
      jukeboxPosition: this.jukeboxPosition,
      entries: this.entries,
      buildings: this.buildings,
      gate: this.gate,
      truck: this.truck,
      bossSpawn: new THREE.Vector3(30, 0, -20),
      surfaceAt: (x: number, z: number): SurfaceType => {
        if (BUILDINGS.some(([cx, cz]) => Math.abs(x - cx) < 7.8 && Math.abs(z - cz) < 6.8)) return 'wood';
        if (Math.abs(x - 26) < 17 && Math.abs(z + 26) < 17) return 'grass';
        return 'concrete';
      },
      zombieSpawnPoints: [
        new THREE.Vector3(-44, 0, -12),
        new THREE.Vector3(44, 0, -12),
        new THREE.Vector3(42, 0, -42),
        new THREE.Vector3(14, 0, -40),
        new THREE.Vector3(-44, 0, 14),
        new THREE.Vector3(44, 0, 16),
        new THREE.Vector3(2, 0, 52),
        new THREE.Vector3(-16, 0, -48),
        new THREE.Vector3(16, 0, 46),
        new THREE.Vector3(36, 0, -20),
        new THREE.Vector3(-44, 0, 44),
        new THREE.Vector3(44, 0, 44),
      ],
    };
  }

  private addStaticBox(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    mesh?: THREE.Object3D,
    opts: { occludes?: boolean; blocksSight?: boolean } = {}
  ): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx * 0.5, sy * 0.5, sz * 0.5)),
      position: new CANNON.Vec3(x, y, z),
    });
    this.physicsWorld.addBody(body);
    if (mesh) {
      this.raycastTargets.push(mesh);
      if (opts.occludes) this.cameraOccluders.push(mesh);
      if (opts.blocksSight) this.sightBlockers.push(mesh);
    }
    return body;
  }

  // ───────────────────────────── Ground & streets ─────────────────────────────

  private buildGround(): void {
    const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.physicsWorld.addBody(groundBody);

    const gPBR = tiledPBR(groundPBR(), 26, 26);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({
        map: gPBR.map,
        normalMap: gPBR.normalMap,
        roughnessMap: gPBR.roughnessMap,
        normalScale: new THREE.Vector2(0.95, 0.95),
        roughness: 0.98,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.raycastTargets.push(ground);

    // Sidewalk plazas in each quadrant (thin, so characters don't sink)
    const concrete = concretePBR();
    for (const [qx, qz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const size = 62;
      const cPBR = tiledPBR(concrete, size / 4, size / 4);
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(size, FLOOR_Y, size),
        new THREE.MeshStandardMaterial({
          map: cPBR.map,
          normalMap: cPBR.normalMap,
          roughnessMap: cPBR.roughnessMap,
          normalScale: new THREE.Vector2(0.9, 0.9),
          roughness: 0.94,
        })
      );
      pad.position.set(qx * (4 + size / 2), FLOOR_Y / 2, qz * (4 + size / 2));
      pad.receiveShadow = true;
      this.scene.add(pad);
    }
  }

  private buildStreets(): void {
    // Kit tiles: Street_Straight runs along Z with a 6 m carriageway and 1 m curbs.
    for (let i = -ROAD_EXTENT; i <= ROAD_EXTENT; i += TILE) {
      if (i === 0) continue;
      const cracked = Math.abs(i) % 24 === 8;
      const ns = this.assets.cloneModel(cracked ? 'street_crack1' : 'street_straight');
      ns.position.set(0, 0, i);
      this.scene.add(ns);
      const ew = this.assets.cloneModel(Math.abs(i) % 24 === 16 ? 'street_crack1' : 'street_straight');
      ew.position.set(i, 0, 0);
      ew.rotation.y = Math.PI / 2;
      this.scene.add(ew);
    }
    const center = this.assets.cloneModel('street_4way');
    this.scene.add(center);
    for (const o of [center]) o.traverse((m) => (m.castShadow = false));
  }

  private buildPerimeterWalls(): void {
    const h = 5;
    const len = 144;
    const mPBR = metalPBR();
    const mat = new THREE.MeshStandardMaterial({
      map: mPBR.map,
      normalMap: mPBR.normalMap,
      roughnessMap: mPBR.roughnessMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.85,
      metalness: 0.42,
    });
    // North wall has a 9 m gate opening for the evac truck
    const gateHalf = 4.5;
    const sideLen = (len - gateHalf * 2) / 2;
    for (const sx of [-1, 1]) {
      const x = sx * (gateHalf + sideLen / 2);
      const mesh = this.texturedBox(sideLen, h, 2, mat, 3);
      mesh.position.set(x, h / 2, -70);
      this.scene.add(mesh);
      this.addStaticBox(x, h / 2, -70, sideLen, h, 2, mesh, { occludes: true, blocksSight: true });
    }
    const gateMat = new THREE.MeshStandardMaterial({
      color: 0x626a73,
      roughness: 0.58,
      metalness: 0.68,
      map: mPBR.map,
      normalMap: mPBR.normalMap,
      roughnessMap: mPBR.roughnessMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
    });
    const gate = new THREE.Group();
    const panel = this.texturedBox(gateHalf * 2, h - 0.4, 0.4, gateMat, 2);
    panel.position.y = (h - 0.4) / 2;
    gate.add(panel);
    for (let i = -3; i <= 3; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, h - 0.4, 0.55), this.metalMat);
      bar.position.set(i * 1.3, (h - 0.4) / 2, 0);
      gate.add(bar);
    }
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(gateHalf * 2, 0.35, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xf5c518, emissive: 0x3a2a00, emissiveIntensity: 0.3 })
    );
    stripe.position.y = 1.4;
    gate.add(stripe);
    gate.position.set(0, 0, -70);
    this.scene.add(gate);
    const gateBody = this.addStaticBox(0, h / 2, -70, gateHalf * 2, h, 0.6, panel, { occludes: true, blocksSight: true });
    this.gate = { mesh: gate, body: gateBody };

    for (const [x, z, sx, sz] of [
      [0, 70, len, 2],
      [-70, 0, 2, len],
      [70, 0, 2, len],
    ]) {
      const mesh = this.texturedBox(sx, h, sz, mat, 3);
      mesh.position.set(x, h / 2, z);
      this.scene.add(mesh);
      this.addStaticBox(x, h / 2, z, sx, h, sz, mesh, { occludes: true, blocksSight: true });
    }
  }

  // ───────────────────────────── Buildings ─────────────────────────────

  private makeSign(text: string, color: string, width: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b0c0f';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = color;
    g.lineWidth = 6;
    g.strokeRect(8, 8, 496, 112);
    g.font = 'bold 64px Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = color;
    g.shadowBlur = 18;
    g.fillStyle = color;
    g.fillText(text, 256, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.9,
      roughness: 0.6,
    });
    mat.userData.sign = true;
    this.windowMaterials.push(mat);
    return new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), mat);
  }

  private buildEnterableBuilding(
    id: string,
    cx: number,
    cz: number,
    w: number,
    d: number,
    tintHex: number,
    doorSide: 'north' | 'south' | 'east' | 'west',
    signText: string,
    signColor: string,
    windows: ['north' | 'south' | 'east' | 'west', number][] = []
  ): void {
    const h = BUILDING_H;
    const t = 0.4;
    const brick = brickPBR();
    const mat = new THREE.MeshStandardMaterial({
      color: tintHex,
      map: brick.map,
      normalMap: brick.normalMap,
      roughnessMap: brick.roughnessMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.94,
    });

    const wf = tiledPBR(woodFloorPBR(), w / 3, d / 3);
    const floorMat = new THREE.MeshStandardMaterial({
      map: wf.map,
      normalMap: wf.normalMap,
      roughnessMap: wf.roughnessMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.85,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w - 0.2, 0.02, d - 0.2), floorMat);
    floor.position.set(cx, FLOOR_Y + 0.01, cz);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const roof = this.texturedBox(w + 0.6, 0.35, d + 0.6, this.roofMat, 4);
    roof.position.set(cx, h + 0.17, cz);
    this.scene.add(roof);
    this.raycastTargets.push(roof);
    this.cameraOccluders.push(roof);

    const trimMat = new THREE.MeshStandardMaterial({ color: 0x55575c, roughness: 0.9 });
    for (const s of [-1, 1]) {
      const tz = this.texturedBox(w + 0.8, 0.45, 0.3, trimMat, 3);
      tz.position.set(cx, h + 0.5, cz + s * (d / 2 + 0.3));
      this.scene.add(tz);
      const tx = this.texturedBox(0.3, 0.45, d + 0.8, trimMat, 3);
      tx.position.set(cx + s * (w / 2 + 0.3), h + 0.5, cz);
      this.scene.add(tx);
    }

    this.buildings.push({ id, center: new THREE.Vector3(cx, 0, cz), halfW: w / 2, halfD: d / 2 });

    type Side = 'north' | 'south' | 'east' | 'west';
    const DOOR_W = 3.0;
    const WIN_W = 1.6;
    const SILL = 0.95;
    const LINTEL = 2.3;

    const solid = (px: number, py: number, pz: number, ssx: number, ssy: number, ssz: number) => {
      const seg = this.texturedBox(ssx, ssy, ssz, mat, 2);
      seg.position.set(px, py, pz);
      this.scene.add(seg);
      this.addStaticBox(px, py, pz, ssx, ssy, ssz, seg, { occludes: true, blocksSight: ssy > 2 });
    };

    /** One wall with any number of door/window openings along it. */
    const makeWall = (side: Side, openings: { kind: 'door' | 'window'; offset: number }[]) => {
      const horizontal = side === 'north' || side === 'south';
      const len = horizontal ? w : d;
      const wx = side === 'west' ? cx - w / 2 : side === 'east' ? cx + w / 2 : cx;
      const wz = side === 'north' ? cz - d / 2 : side === 'south' ? cz + d / 2 : cz;
      const normal = new THREE.Vector3(side === 'west' ? -1 : side === 'east' ? 1 : 0, 0, side === 'north' ? -1 : side === 'south' ? 1 : 0);
      // position along the wall -> world
      const at = (u: number) => (horizontal ? [wx + u, wz] : [wx, wz + u]) as [number, number];
      const box = (u0: number, u1: number, y0: number, y1: number) => {
        if (u1 - u0 < 0.05 || y1 - y0 < 0.05) return;
        const [px, pz] = at((u0 + u1) / 2);
        solid(px, (y0 + y1) / 2, pz, horizontal ? u1 - u0 : t, y1 - y0, horizontal ? t : u1 - u0);
      };

      const sorted = [...openings].sort((a, b) => a.offset - b.offset);
      let cursor = -len / 2;
      for (const op of sorted) {
        const ow = op.kind === 'door' ? DOOR_W : WIN_W;
        const u0 = op.offset - ow / 2;
        const u1 = op.offset + ow / 2;
        box(cursor, u0, 0, h);
        if (op.kind === 'door') {
          box(u0, u1, h - 0.9, h);
          const [sx, sz] = at(op.offset);
          const sign = this.makeSign(signText, signColor, 3.4);
          sign.position.set(sx + normal.x * (t / 2 + 0.03), h - 0.45, sz + normal.z * (t / 2 + 0.03));
          sign.rotation.y = Math.atan2(normal.x, normal.z);
          this.scene.add(sign);
        } else {
          box(u0, u1, 0, SILL);
          box(u0, u1, LINTEL, h);
          // dark interior glass frame so the opening reads as a window
          const [fx, fz] = at(op.offset);
          const frame = new THREE.Mesh(
            new THREE.BoxGeometry(horizontal ? ow + 0.12 : t + 0.06, 0.08, horizontal ? t + 0.06 : ow + 0.12),
            this.darkWoodMat
          );
          frame.position.set(fx, SILL + 0.04, fz);
          this.scene.add(frame);
        }
        const [ex, ez] = at(op.offset);
        this.entries.push({
          id: `${id}_${op.kind}_${side}`,
          building: id,
          kind: op.kind,
          position: new THREE.Vector3(ex, 0, ez),
          normal,
          horizontal,
          width: ow,
        });
        cursor = u1;
      }
      box(cursor, len / 2, 0, h);
    };

    const sides: Side[] = ['north', 'south', 'west', 'east'];
    for (const side of sides) {
      const ops: { kind: 'door' | 'window'; offset: number }[] = [];
      if (side === doorSide) ops.push({ kind: 'door', offset: 0 });
      for (const [ws, off] of windows) if (ws === side) ops.push({ kind: 'window', offset: off });
      makeWall(side, ops);
    }

    const light = new THREE.PointLight(0xffd2a1, 3.0, 15, 1.6);
    light.position.set(cx, h - 0.5, cz);
    this.scene.add(light);
  }

  /** Background apartment blocks with a window facade that lights up at night. */
  private buildOuterBlocks(): void {
    const { map, normalMap, roughnessMap, emissive } = facadeTextures();
    const blocks: [number, number, number, number, number, number][] = [
      // x, z, w, d, h, tint
      [-55, -55, 18, 18, 16, 0x8f8a86],
      [55, -55, 18, 18, 12, 0x9a948a],
      [-55, 55, 18, 18, 12, 0x868c92],
      [55, 55, 18, 18, 18, 0x948a86],
      [-58, -26, 12, 20, 10, 0x9c968e],
      [-58, 0, 12, 16, 14, 0x8a8f8c],
      [-58, 26, 12, 20, 9, 0x928c88],
      [58, -26, 12, 20, 13, 0x8c8e94],
      [58, 0, 12, 16, 9, 0x989088],
      [58, 26, 12, 20, 15, 0x8e8a84],
      [-26, -58, 20, 12, 11, 0x8a8a8e],
      [26, -58, 20, 12, 14, 0x968e88],
      [-26, 58, 20, 12, 13, 0x8c9090],
      [26, 58, 20, 12, 10, 0x908a86],
    ];
    for (const [x, z, w, d, h, tint] of blocks) {
      const mat = new THREE.MeshStandardMaterial({
        color: tint,
        map,
        normalMap,
        roughnessMap,
        normalScale: new THREE.Vector2(1.0, 1.0),
        emissive: 0xffffff,
        emissiveMap: emissive,
        emissiveIntensity: 0,
        roughness: 1.0,
        metalness: 0.12,
      });
      this.windowMaterials.push(mat);
      // Box face order: +x, -x, +y (roof), -y, +z, -z
      const mesh = this.texturedBox(w, h, d, mat, 8);
      mesh.material = [mat, mat, this.roofMat, this.roofMat, mat, mat];
      mesh.position.set(x, h / 2, z);
      this.scene.add(mesh);
      this.addStaticBox(x, h / 2, z, w, h, d, mesh, { occludes: true, blocksSight: true });
    }
    // Landmark water tower on one rooftop
    const tower = this.assets.cloneModel('water_tower');
    tower.position.set(55, 18, 55);
    this.scene.add(tower);
  }

  // ───────────────────────────── Furniture (primitives) ─────────────────────────────

  private addSolid(group: THREE.Object3D, x: number, z: number, rotY: number): void {
    group.position.set(x, FLOOR_Y, z);
    group.rotation.y = rotY;
    group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    this.scene.add(group);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.addStaticBox(center.x, center.y, center.z, Math.max(0.4, size.x), Math.max(0.4, size.y), Math.max(0.4, size.z), group);
  }

  private makeTable(w = 1.6, d = 0.9): THREE.Group {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), this.woodMat);
    top.position.y = 0.74;
    g.add(top);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 0.06), this.darkWoodMat);
        leg.position.set(sx * (w / 2 - 0.08), 0.36, sz * (d / 2 - 0.08));
        g.add(leg);
      }
    }
    return g;
  }

  private makeCounter(len: number): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, 0.95, 0.7), this.darkWoodMat);
    body.position.y = 0.475;
    g.add(body);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(len + 0.1, 0.06, 0.85),
      new THREE.MeshStandardMaterial({ color: 0xc9c4bc, roughness: 0.35 })
    );
    top.position.y = 0.98;
    g.add(top);
    return g;
  }

  private makeShelf(len = 2.2): THREE.Group {
    const g = new THREE.Group();
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.9, 0.45), this.metalMat);
      side.position.set((sx * len) / 2, 0.95, 0);
      g.add(side);
    }
    const boxColors = [0xb91c1c, 0x2563eb, 0xf5f5f4, 0x16a34a, 0xeab308];
    for (let i = 0; i < 4; i++) {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.45), this.metalMat);
      shelf.position.y = 0.15 + i * 0.5;
      g.add(shelf);
      for (let k = 0; k < 5; k++) {
        if (Math.random() < 0.35) continue;
        const item = new THREE.Mesh(
          new THREE.BoxGeometry(0.25, 0.22 + Math.random() * 0.12, 0.25),
          new THREE.MeshStandardMaterial({ color: boxColors[(i + k) % boxColors.length], roughness: 0.7 })
        );
        item.position.set(-len / 2 + 0.3 + k * (len - 0.6) / 4, shelf.position.y + 0.14, 0);
        item.rotation.y = (Math.random() - 0.5) * 0.4;
        g.add(item);
      }
    }
    return g;
  }

  private makeBed(): THREE.Group {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 2.1), this.darkWoodMat);
    frame.position.y = 0.18;
    g.add(frame);
    const mattress = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.2, 2.0),
      new THREE.MeshStandardMaterial({ color: 0x8a8070, roughness: 0.95 })
    );
    mattress.position.y = 0.45;
    g.add(mattress);
    const blanket = new THREE.Mesh(
      new THREE.BoxGeometry(1.04, 0.06, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x5a2420, roughness: 0.95 })
    );
    blanket.position.set(0, 0.57, 0.35);
    g.add(blanket);
    return g;
  }

  private makeFridge(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 1.95, 0.75),
      new THREE.MeshStandardMaterial({ color: 0xdcdcd6, roughness: 0.35, metalness: 0.2 })
    );
    body.position.y = 0.975;
    g.add(body);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04), this.metalMat);
    handle.position.set(0.32, 1.2, 0.4);
    g.add(handle);
    return g;
  }

  private buildCampfire(pos: THREE.Vector3): void {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const block = this.assets.cloneModel('prop_cinder');
      block.position.set(pos.x + Math.cos(a) * 0.55, FLOOR_Y, pos.z + Math.sin(a) * 0.55);
      block.rotation.y = -a + Math.PI / 2;
      this.scene.add(block);
    }
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.7, 6), this.darkWoodMat);
      log.position.set(pos.x, FLOOR_Y + 0.12, pos.z);
      log.rotation.set(Math.PI / 2 - 0.35, (i / 3) * Math.PI * 2, 0, 'YXZ');
      this.scene.add(log);
    }
    const embers = new THREE.Mesh(
      new THREE.CircleGeometry(0.35, 12),
      new THREE.MeshStandardMaterial({ color: 0x220a02, emissive: 0xff5a1a, emissiveIntensity: 1.6 })
    );
    embers.rotation.x = -Math.PI / 2;
    embers.position.set(pos.x, FLOOR_Y + 0.03, pos.z);
    this.scene.add(embers);
    this.vfx.registerFireEmitter(new THREE.Vector3(pos.x, FLOOR_Y + 0.15, pos.z), 0.9);
    this.firePositions.push(new THREE.Vector3(pos.x, 0.4, pos.z));

    const fireLight = new THREE.PointLight(0xff7b29, 3.0, 12, 2);
    fireLight.position.set(pos.x, 1.0, pos.z);
    this.scene.add(fireLight);
    this.burningBarrels.push({ light: fireLight, baseIntensity: 3.0, phase: 0 });
  }

  private populateSafehouse(cx: number, cz: number): void {
    this.addSolid(this.makeBed(), cx - 5.5, cz + 4.5, 0);
    this.interactables.push({
      id: 'safehouse_bed',
      type: 'bed',
      label: 'Bed',
      subLabel: 'Rest until dawn (safehouse must be sealed)',
      position: new THREE.Vector3(cx - 4.6, 0.6, cz + 3.2),
      radius: 2.0,
    });
    this.addSolid(this.makeBed(), cx - 3.6, cz + 4.5, 0);
    this.addSolid(this.makeTable(), cx + 4, cz - 2.5, 0);
    this.placeModel('prop_couch', cx + 1, cz + 5.6, Math.PI, true);
    this.placeModel('prop_barrel', cx + 6.8, cz + 5.8, 0, true);
    this.placeModel('prop_wheels', cx + 6.6, cz - 5.6, 0.4, true);
    this.placeModel('prop_pallet', cx - 6.6, cz - 1, Math.PI / 2, false);

    const firePos = new THREE.Vector3(cx, 0, cz - 2);
    this.buildCampfire(firePos);
    this.interactables.push({
      id: 'safehouse_campfire',
      type: 'campfire',
      label: 'Campfire',
      subLabel: 'Rest to heal • Craft anytime with [Tab]',
      position: firePos.clone(),
      radius: 2.6,
    });

    this.spawnLootCrate('crate_safehouse', cx - 5.5, cz - 4, 'ammo_pistol');
  }

  private populatePharmacy(cx: number, cz: number): void {
    this.addSolid(this.makeCounter(5), cx, cz - 3.5, 0);
    this.addSolid(this.makeShelf(), cx - 6.6, cz - 3.5, Math.PI / 2);
    this.addSolid(this.makeShelf(), cx + 6.6, cz - 3.5, -Math.PI / 2);
    this.addSolid(this.makeShelf(), cx - 2.5, cz + 0.8, 0);
    this.addSolid(this.makeShelf(), cx + 2.5, cz + 0.8, 0);

    this.spawnLootCrate('crate_pharm_1', cx - 4.5, cz + 3.5, 'medkit');
    this.spawnLootCrate('crate_pharm_2', cx + 4.5, cz + 3.5, 'ammo_shells');
    this.spawnJerrycan('jerrycan_1', cx + 5, cz - 1.2);
  }

  private populateDiner(cx: number, cz: number): void {
    this.addSolid(this.makeCounter(6), cx + 4.5, cz, -Math.PI / 2);
    this.addSolid(this.makeFridge(), cx + 6.7, cz + 5, -Math.PI / 2);
    this.addSolid(this.makeTable(1.4, 1.4), cx - 3, cz + 3, 0);
    this.addSolid(this.makeTable(1.4, 1.4), cx - 3, cz - 3, 0);
    this.addSolid(this.makeTable(1.4, 1.4), cx + 0.5, cz - 4.5, 0);

    this.spawnLootCrate('crate_diner_1', cx + 2, cz + 5, 'burger');
    this.spawnLootCrate('crate_diner_2', cx - 5.5, cz + 5.2, 'water_bottle');
    this.spawnRadioBeacon('radio_beacon', cx + 4.5, cz + 0.2);
    this.addSolid(this.makeJukebox(), cx - 6.9, cz - 5.6, Math.PI / 2);
    this.jukeboxPosition.set(cx - 6.9, 1.0, cz - 5.6);
  }

  /** NE block: an overgrown freight yard of shipping containers. */
  private buildYard(cx: number, cz: number): void {
    const gr = tiledPBR(grassPBR(), 8, 8);
    const grass = new THREE.Mesh(
      new THREE.BoxGeometry(34, 0.02, 34),
      new THREE.MeshStandardMaterial({
        map: gr.map,
        normalMap: gr.normalMap,
        roughnessMap: gr.roughnessMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughness: 0.98,
      })
    );
    grass.position.set(cx, FLOOR_Y + 0.01, cz);
    grass.receiveShadow = true;
    this.scene.add(grass);

    this.placeModel('prop_container_green', cx - 8, cz - 9, 0, true);
    this.placeModel('prop_container_red', cx - 8, cz - 6.2, 0.05, true);
    this.placeModel('prop_container_red', cx + 9, cz + 4, Math.PI / 2, true);
    this.placeModel('prop_container_green', cx + 3, cz - 11, -0.2, true);
    this.placeModel('prop_container_green', cx - 10, cz + 9, Math.PI / 2 + 0.1, true);
    this.placeModel('prop_pipes', cx + 2, cz + 2, 0.3, true);
    this.placeModel('prop_pipes', cx + 3, cz + 3.2, 0.2, true);
    this.placeModel('prop_wheels', cx - 3, cz - 2, 0, true);
    this.placeModel('prop_pallet', cx - 1, cz + 7, 0.6, false);
    this.placeModel('prop_pallet_broken', cx + 5, cz - 4, 1.2, false);
    this.placeModel('prop_barrel', cx + 11, cz - 9, 0, true);
    this.placeModel('prop_barrel', cx + 11.8, cz - 8.4, 0, true);

    const tower = this.assets.cloneModel('water_tower');
    tower.position.set(cx + 10, FLOOR_Y, cz + 11);
    this.scene.add(tower);
    this.addStaticBox(cx + 10, 4.5, cz + 11, 2.4, 9, 2.4, tower, { occludes: true });

    this.spawnJerrycan('jerrycan_2', cx + 6, cz - 1.5);
    this.spawnLootCrate('crate_park', cx - 4, cz + 4, 'ammo_rifle');
  }

  // ───────────────────────────── Street furniture ─────────────────────────────

  private buildStreetFurniture(): void {
    // [x, z, rotY] — the lamp arm extends along local +Z, so rotate it over the road.
    const lamps: [number, number, number][] = [
      [-4.6, -20, Math.PI / 2],
      [4.6, -36, -Math.PI / 2],
      [-4.6, 20, Math.PI / 2],
      [4.6, 36, -Math.PI / 2],
      [-20, 4.6, Math.PI],
      [20, -4.6, 0],
      [-40, -4.6, 0],
      [40, 4.6, Math.PI],
      [4.6, -52, -Math.PI / 2],
    ];
    lamps.forEach(([x, z, rot], i) => {
      const lamp = this.assets.cloneModel('street_light');
      lamp.position.set(x, 0, z);
      lamp.rotation.y = rot;
      this.scene.add(lamp);
      this.addStaticBox(x, 3, z, 0.35, 6, 0.35, lamp);

      let bulbMat: THREE.MeshStandardMaterial | null = null;
      lamp.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m, mi) => {
          if (m instanceof THREE.MeshStandardMaterial && /light/i.test(m.name)) {
            const own = m.clone();
            own.emissive.setHex(0xffd27d);
            own.emissiveIntensity = 1.5;
            if (Array.isArray(mesh.material)) mesh.material[mi] = own;
            else mesh.material = own;
            bulbMat = own;
          }
        });
      });
      const arm = new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot)).multiplyScalar(2.6);
      const light = new THREE.PointLight(0xffd59a, 2.6, 20, 1.6);
      light.position.set(x + arm.x, 6.1, z + arm.z);
      this.scene.add(light);
      const glow = this.vfx.createGlow(light.position.clone().add(new THREE.Vector3(0, -0.15, 0)), 0xffd59a, 2.2);
      const cone = this.vfx.createFlashlightConeMesh();
      cone.rotation.x = Math.PI / 2; // point straight down
      cone.scale.set(0.55, 0.55, 0.38);
      cone.position.copy(light.position).add(new THREE.Vector3(0, -0.2, 0));
      (cone.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(0xffd9a0);
      cone.raycast = () => {};
      this.scene.add(cone);
      this.streetLights.push({
        light,
        bulbMat: bulbMat ?? new THREE.MeshStandardMaterial(),
        baseIntensity: 2.6,
        failsAtNight: i % 3 === 1,
        glow,
        cone,
      });
    });

    for (const [x, z, rot] of [
      [-4.6, -4.6, Math.PI / 2],
      [4.6, 4.6, -Math.PI / 2],
    ]) {
      const tl = this.assets.cloneModel('traffic_light');
      tl.position.set(x, 0, z);
      tl.rotation.y = rot;
      this.scene.add(tl);
      this.addStaticBox(x, 2.3, z, 0.35, 4.6, 0.35, tl);
    }

    const sign = this.assets.cloneModel('town_sign');
    sign.position.set(14, FLOOR_Y, 62);
    sign.rotation.y = Math.PI;
    this.scene.add(sign);
    this.raycastTargets.push(sign);
  }

  private buildVehiclesAndCover(): void {
    // Kit vehicles are ~5 m long along local Z.
    this.placeVehicle('veh_sports', -1.5, -20, 0.25);
    this.placeVehicle('veh_pickup', 1.8, 18, Math.PI + 0.3);
    this.placeVehicle('veh_truck', 20, -1.2, Math.PI / 2 + 0.1);
    this.placeVehicle('veh_pickup_armored', -18, 1.4, -Math.PI / 2 + 0.25);
    this.placeVehicle('veh_sports_armored', -1.6, 38, 0.4);
    this.placeVehicle('veh_pickup', 34, 1.5, Math.PI / 2 - 0.2);
    this.placeVehicle('veh_sports', 1.2, -40, 2.9);

    this.spawnJerrycan('jerrycan_3', 5.5, -22);
    this.spawnLootCrate('crate_ambulance', -18, 5.5, 'medkit');
    this.spawnLootCrate('crate_bus', 20, 5, 'canned_food');
    this.spawnLootCrate('crate_pickup', -5.5, 40, 'ammo_pistol');
    this.spawnLootCrate('crate_truck', 34, 5.5, 'chocolate');

    this.placeModel('prop_container_green', -12, -40, 0.1, true);
    this.placeModel('prop_container_red', 12, 40, -0.15, true);
    this.placeModel('prop_barrier', -2, -10, 0.1, true);
    this.placeModel('prop_barrier', 2, 10, 0.2, true);
    this.placeModel('prop_barrier2', -10, 2, Math.PI / 2 + 0.1, true);
    this.placeModel('prop_plastic_barrier', 10, -2, Math.PI / 2 - 0.2, true);
    this.placeModel('prop_plastic_barrier', 11.2, -0.8, Math.PI / 2 + 0.3, true);
    this.placeModel('prop_hydrant', -6, 11, 0, true);
    this.placeModel('prop_hydrant', 6, -30, 0, true);
    this.placeModel('prop_cone', -2.5, -7, 0, false);
    this.placeModel('prop_cone2', 2.5, 7, 0, false);
    this.placeModel('prop_cone', -0.8, -8.5, 0.6, false);
    this.placeModel('prop_cone2', 7.5, 1.5, 0.3, false);

    this.interactables.push({
      id: 'recruit_dog',
      type: 'dog',
      label: 'Recruit Survivor Dog',
      subLabel: 'Barks to warn of zombies & pins lone threats',
      position: new THREE.Vector3(-14, 0.6, 11),
      radius: 3.0,
      consumed: false,
    });
  }

  private scatterDebris(): void {
    const items: [string, number, number][] = [
      ['prop_trashbag', -6.5, 15],
      ['prop_trashbag2', -7.2, 15.8],
      ['prop_trashbag', 15, 6.5],
      ['prop_trashbag2', -36, -7],
      ['prop_trashbag', 36, 15],
      ['prop_trashbag2', 6.5, -15],
      ['prop_wheels', 14, 7],
      ['prop_wheels', -44, -20],
      ['prop_wheel', -9, 6.3],
      ['prop_wheel', 18, -7],
      ['prop_pallet_broken', -12, 7],
      ['prop_pallet_broken', 12, -9],
      ['prop_cinder', -9, 9],
      ['prop_cinder', 15, -7],
      ['prop_chest', -17.6, 33.7],
      ['prop_barrel', -40, 16],
      ['prop_barrel', 40, -16],
      ['prop_pipes', -44, 30],
    ];
    for (const [k, x, z] of items) {
      const solid = k === 'prop_wheels' || k === 'prop_barrel' || k === 'prop_pipes';
      this.placeModel(k, x, z, Math.random() * Math.PI * 2, solid);
    }
  }

  private buildExtractionZone(pos: THREE.Vector3): { light: THREE.PointLight; marker: ObjectiveMarker } {
    const truck = this.assets.cloneModel('veh_truck_armored');
    truck.position.copy(pos);
    truck.scale.setScalar(1.15);
    truck.rotation.y = Math.PI; // nose toward the North Gate
    this.scene.add(truck);
    const wheels: THREE.Object3D[] = [];
    truck.traverse((o) => {
      if (/wheel/i.test(o.name)) wheels.push(o);
    });
    this.truck = { root: truck, wheels };
    const box = new THREE.Box3().setFromObject(truck);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.addStaticBox(center.x, center.y, center.z, size.x * 0.9, size.y, size.z * 0.9, truck, { occludes: true });

    const beaconMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 3.0 });
    const beaconMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 12), beaconMat);
    beaconMesh.position.set(pos.x, box.max.y + 0.15, pos.z);
    this.scene.add(beaconMesh);

    const beaconLight = new THREE.PointLight(0xf59e0b, 3.5, 22, 1.6);
    beaconLight.position.set(pos.x, box.max.y + 0.6, pos.z);
    this.scene.add(beaconLight);

    this.placeModel('prop_barrier', pos.x - 4.5, pos.z + 4.5, 0.4, true);
    this.placeModel('prop_barrier', pos.x + 4.5, pos.z + 4.5, -0.4, true);
    this.placeModel('prop_cone', pos.x - 2.5, pos.z + 6, 0, false);
    this.placeModel('prop_cone', pos.x + 2.5, pos.z + 6, 0, false);

    const markerPos = pos.clone().add(new THREE.Vector3(0, 0, 4.4));
    const marker = this.vfx.createObjectiveMarker(markerPos, 0x22c55e);
    marker.setActive(false);

    this.interactables.push({
      id: 'extraction_truck',
      type: 'extraction_truck',
      label: 'Armored Extraction Truck',
      subLabel: 'Requires 3 Jerrycans + Radio Beacon',
      position: markerPos.clone().setY(1),
      radius: 4.0,
    });
    return { light: beaconLight, marker };
  }

  private placeModel(key: string, x: number, z: number, rotY: number, hasCollider: boolean): THREE.Group {
    const model = this.assets.cloneModel(key);
    model.position.set(x, FLOOR_Y, z);
    model.rotation.y = rotY;
    this.scene.add(model);
    if (hasCollider) {
      // Oriented box from the model's own (un-rotated) bounds
      model.rotation.y = 0;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.rotation.y = rotY;
      model.updateMatrixWorld(true);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(
          new CANNON.Vec3(Math.max(0.2, size.x * 0.46), Math.max(0.3, size.y * 0.5), Math.max(0.2, size.z * 0.46))
        ),
        position: new CANNON.Vec3(x, center.y, z),
      });
      body.quaternion.setFromEuler(0, rotY, 0);
      this.physicsWorld.addBody(body);
      if (size.y > 2.2) this.cameraOccluders.push(model);
    }
    this.raycastTargets.push(model);
    return model;
  }

  private placeVehicle(key: string, x: number, z: number, rotY: number): void {
    const veh = this.placeModel(key, x, z, rotY, true);
    veh.position.y = 0.02;
    const id = `vehicle_${this.vehicles.length}`;
    const lightMats: THREE.MeshStandardMaterial[] = [];
    veh.traverse((o) => {
      o.userData.vehicleId = id;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: THREE.Material) => {
        // Wrecks: dead headlights / brake lights, each car with its own copy so alarms flash only it
        if (m instanceof THREE.MeshStandardMaterial && /light/i.test(m.name)) {
          const own = m.clone();
          own.emissiveIntensity = 0.15;
          lightMats.push(own);
          return own;
        }
        return m;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    this.vehicles.push({ id, mesh: veh, position: new THREE.Vector3(x, 0, z), lightMats, alarmCooldown: 0 });
  }

  private makeJukebox(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.5, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x6b1d1d, roughness: 0.4, metalness: 0.3 })
    );
    body.position.y = 0.75;
    g.add(body);
    const arch = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.6, 16, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x2a0f05, emissive: 0xff9a3c, emissiveIntensity: 1.4 })
    );
    arch.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    arch.position.set(0, 1.5, 0);
    g.add(arch);
    const grille = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0x4ad7ff, emissiveIntensity: 0.6 })
    );
    grille.position.set(0, 0.55, 0.301);
    g.add(grille);
    return g;
  }

  /** Dead trees, bushes and weeds from the Stylized Nature Pack. */
  private plantNature(): void {
    const trees = ['nat_deadtree_1', 'nat_deadtree_2', 'nat_deadtree_3', 'nat_deadtree_6', 'nat_deadtree_8', 'nat_deadtree_10'];
    const spots: [number, number][] = [
      [-6.6, -30], [6.6, -14], [-6.6, 30], [6.6, 28], [-30, 6.6], [-46, -6.6], [14, -6.6], [30, 6.6],
      [46, -6.6], [-6.6, -46], [6.6, 48], [-48, 6.6],
      // freight yard
      [14, -28], [28, -13], [38, -38], [16, -40],
    ];
    spots.forEach(([x, z], i) => {
      const t = this.assets.cloneModel(trees[i % trees.length]);
      const box = new THREE.Box3().setFromObject(t);
      const h = box.max.y - box.min.y;
      const target = 4.5 + ((i * 37) % 10) / 4; // 4.5-7 m
      if (h > 0.01) t.scale.setScalar(target / h);
      t.position.set(x, FLOOR_Y, z);
      t.rotation.y = i * 1.7;
      t.traverse((o) => (o.castShadow = true));
      applyWindSway(t, 0.018);
      this.scene.add(t);
      this.raycastTargets.push(t);
      this.addStaticBox(x, 2, z, 0.45, 4, 0.45);
    });

    // Weeds pushing through the yard and along building bases (seeded so the layout is stable)
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 70; i++) {
      const inYard = i < 45;
      const x = inYard ? 26 + (rand() - 0.5) * 32 : [-34.6, -17.4, 17.4, 34.6][i % 4] + (rand() - 0.5) * 0.6;
      const z = inYard ? -26 + (rand() - 0.5) * 32 : [26, -26, 26, -26][i % 4] + (rand() - 0.5) * 12;
      const key = rand() < 0.25 ? 'nat_bush_small' : rand() < 0.5 ? 'nat_grass_small' : 'nat_grass_large';
      const g = this.assets.cloneModel(key);
      const box = new THREE.Box3().setFromObject(g);
      const h = box.max.y - box.min.y;
      const target = key === 'nat_bush_small' ? 0.7 + rand() * 0.4 : 0.35 + rand() * 0.35;
      if (h > 0.01) g.scale.setScalar(target / h);
      g.position.set(x, FLOOR_Y, z);
      g.rotation.y = rand() * Math.PI * 2;
      g.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = true;
      });
      applyWindSway(g, key === 'nat_bush_small' ? 0.075 : 0.12);
      this.scene.add(g);
    }
  }

  /** Red fuel drums that explode when shot (and chain-react). */
  private placeExplosiveBarrels(): void {
    const red = new THREE.MeshStandardMaterial({ color: 0xa3241b, roughness: 0.55, metalness: 0.35 });
    const band = new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.5, emissive: 0x3a2a00, emissiveIntensity: 0.4 });
    const spots: [number, number][] = [
      [-12, -14], [10, 14], [-20, -37], [36, -14], [18, 35], [-36, 18], [-3, -47], [44, 30], [-15, 2.5], [8, -26],
    ];
    spots.forEach(([x, z], i) => {
      const id = `xbarrel_${i}`;
      const barrel = this.assets.cloneModel('prop_barrel');
      barrel.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = red;
        o.userData.explosiveId = id;
      });
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.355, 0.355, 0.12, 16, 1, true), band);
      stripe.position.y = 0.78;
      stripe.userData.explosiveId = id;
      barrel.add(stripe);
      barrel.position.set(x, FLOOR_Y, z);
      barrel.rotation.y = i;
      this.scene.add(barrel);
      this.raycastTargets.push(barrel);
      const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Cylinder(0.36, 0.36, 1.14, 10),
        position: new CANNON.Vec3(x, 0.6, z),
      });
      this.physicsWorld.addBody(body);
      this.explosiveBarrels.push({ id, mesh: barrel, body, position: new THREE.Vector3(x, 0.5, z), exploded: false });
    });
  }

  private placeBurningBarrel(x: number, z: number): void {
    this.placeModel('prop_barrel', x, z, Math.random() * 3, true);
    this.vfx.registerFireEmitter(new THREE.Vector3(x, FLOOR_Y + 1.12, z), 1.1);
    this.firePositions.push(new THREE.Vector3(x, 1.1, z));
    const light = new THREE.PointLight(0xff6b1a, 2.8, 15, 1.8);
    light.position.set(x, 1.7, z);
    this.scene.add(light);
    this.burningBarrels.push({ light, baseIntensity: 2.8, phase: Math.random() * 10 });
  }

  // ───────────────────────────── Pickups ─────────────────────────────

  private spawnLootCrate(id: string, x: number, z: number, itemId: string): void {
    const crate = this.assets.cloneModel('prop_chest_special');
    crate.position.set(x, FLOOR_Y, z);
    crate.rotation.y = Math.random() * Math.PI;
    this.scene.add(crate);
    this.raycastTargets.push(crate);

    const marker = this.vfx.createObjectiveMarker(new THREE.Vector3(x, FLOOR_Y, z), 0xfbbf24);
    marker.group.scale.set(0.55, 0.3, 0.55);

    this.interactables.push({
      id,
      type: 'loot',
      label: 'Supply Crate',
      subLabel: 'Scavenge',
      position: new THREE.Vector3(x, 0.6, z),
      radius: 2.4,
      consumed: false,
      mesh: crate,
      data: { itemId, marker },
    });
  }

  private makeJerrycan(): THREE.Group {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.45, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.16), red);
    body.position.y = 0.22;
    g.add(body);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 12, Math.PI), this.metalMat);
    handle.position.set(-0.05, 0.44, 0);
    g.add(handle);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.12, 8), this.metalMat);
    spout.position.set(0.12, 0.48, 0);
    spout.rotation.z = -0.5;
    g.add(spout);
    g.traverse((o) => (o.castShadow = true));
    return g;
  }

  private spawnJerrycan(id: string, x: number, z: number): void {
    const can = this.makeJerrycan();
    can.position.set(x, FLOOR_Y, z);
    can.rotation.y = Math.random() * Math.PI;
    this.scene.add(can);
    const marker = this.vfx.createObjectiveMarker(new THREE.Vector3(x, FLOOR_Y, z), 0xef4444);

    this.interactables.push({
      id,
      type: 'jerrycan',
      label: 'Fuel Jerrycan',
      subLabel: 'Extraction objective',
      position: new THREE.Vector3(x, 0.6, z),
      radius: 2.4,
      consumed: false,
      mesh: can,
      data: { marker },
    });
  }

  private makeRadio(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.3, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x3f4a36, roughness: 0.7 })
    );
    body.position.y = 0.15;
    g.add(body);
    const dial = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x38bdf8, emissiveIntensity: 1.5 })
    );
    dial.position.set(-0.08, 0.2, 0.111);
    g.add(dial);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 4), this.metalMat);
    antenna.position.set(0.18, 0.6, 0);
    antenna.rotation.z = -0.25;
    g.add(antenna);
    g.traverse((o) => (o.castShadow = true));
    return g;
  }

  private spawnRadioBeacon(id: string, x: number, z: number): void {
    const radio = this.makeRadio();
    radio.position.set(x, FLOOR_Y + 1.01, z);
    radio.rotation.y = -Math.PI / 2;
    this.scene.add(radio);
    const marker = this.vfx.createObjectiveMarker(new THREE.Vector3(x, 1.0, z), 0x38bdf8);

    this.interactables.push({
      id,
      type: 'beacon',
      label: 'Shortwave Radio',
      subLabel: 'Extraction objective',
      position: new THREE.Vector3(x, 1.0, z),
      radius: 2.4,
      consumed: false,
      mesh: radio,
      data: { marker },
    });
  }

  /** Builds a pallet barricade across a doorway. Returns the parts so the caller can tear it down. */
  public static buildBarricade(
    scene: THREE.Scene,
    physicsWorld: CANNON.World,
    assets: AssetManager,
    item: InteractableObject
  ): { mesh: THREE.Group; body: CANNON.Body } {
    const horizontal = Boolean(item.data?.horizontal);
    const mesh = new THREE.Group();
    // Kit pallets stood on edge, three across the 3 m doorway, two high
    for (let row = 0; row < 2; row++) {
      for (let i = -1; i <= 1; i++) {
        const pallet = assets.cloneModel('prop_pallet');
        pallet.rotation.set(Math.PI / 2, 0, (Math.random() - 0.5) * 0.08);
        pallet.position.set(i * 0.92, 0.6 + row * 1.15, (row - 0.5) * 0.12);
        mesh.add(pallet);
      }
    }
    mesh.position.set(item.position.x, FLOOR_Y, item.position.z);
    if (!horizontal) mesh.rotation.y = Math.PI / 2;
    scene.add(mesh);

    const sx = horizontal ? 3.0 : 0.6;
    const sz = horizontal ? 0.6 : 3.0;
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx * 0.5, 1.2, sz * 0.5)),
      position: new CANNON.Vec3(item.position.x, 1.2, item.position.z),
    });
    physicsWorld.addBody(body);
    return { mesh, body };
  }
}
