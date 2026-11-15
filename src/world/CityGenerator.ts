import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { ObjectiveMarker, VFXManager } from '../core/VFXManager';
import { InteractableObject } from '../types/game';

export interface StreetLightNode {
  light: THREE.PointLight;
  bulbMat: THREE.MeshStandardMaterial;
  baseIntensity: number;
  /** Some lamps die at night, the rest flicker. */
  failsAtNight: boolean;
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
}

const FLOOR_Y = 0.04;

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
  private windowMaterials: THREE.MeshStandardMaterial[] = [];
  private zombieSpawnPoints: THREE.Vector3[] = [];

  private trimMat: THREE.MeshStandardMaterial;
  private floorInteriorMat: THREE.MeshStandardMaterial;
  private woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3d28, roughness: 0.8 });
  private metalMat = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.45, metalness: 0.6 });

  constructor(scene: THREE.Scene, physicsWorld: CANNON.World, assets: AssetManager, vfx: VFXManager) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.vfx = vfx;

    this.trimMat = new THREE.MeshStandardMaterial({
      color: 0x55575c,
      map: this.assets.getTexture('tex_concrete') ?? null,
      roughness: 0.92,
      metalness: 0.05,
    });
    this.floorInteriorMat = new THREE.MeshStandardMaterial({
      color: 0x8a7f72,
      map: this.assets.getTexture('tex_marble') ?? null,
      roughness: 0.6,
    });
  }

  /** Rescale BoxGeometry UVs so a shared tiling texture keeps a constant world-space density. */
  private static tileBox(geo: THREE.BoxGeometry, sx: number, sy: number, sz: number, tile: number): THREE.BoxGeometry {
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    // Face order: +x, -x, +y, -y, +z, -z (4 verts each)
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
    this.buildGroundAndRoads();
    this.buildPerimeterWalls();

    // 4-Block Urban Quarantine Zone
    const campfirePos = new THREE.Vector3(-28, 0, 26);
    this.buildEnterableBuilding('Safehouse', -28, 28, 16, 14, 0x9c8f86, 'north', 'SAFEHOUSE', '#f59e0b');
    this.populateSafehouse(-28, 28);

    this.buildEnterableBuilding('Pharmacy', -28, -28, 16, 14, 0x8fa0a8, 'south', '+ PHARMACY', '#22c55e');
    this.populatePharmacy(-28, -28);

    this.buildEnterableBuilding('Diner', 28, 28, 16, 14, 0xb08f86, 'west', "JOE'S DINER", '#ef4444');
    this.populateDiner(28, 28);

    this.buildOvergrownPark(28, -28);

    // Ring of real Downtown MegaKit buildings framing the quarantine zone
    this.buildSkyline();

    this.buildStreetLights();
    this.buildTransitAndCover();
    this.scatterDebris();

    this.placeBurningBarrel(-9, 9);
    this.placeBurningBarrel(9, -9);
    this.placeBurningBarrel(-20, 16);
    this.placeBurningBarrel(10, -45);
    this.placeBurningBarrel(44, 10);

    const extractionPos = new THREE.Vector3(0, 0, -56);
    const { light: extractionLight, marker: extractionMarker } = this.buildExtractionZone(extractionPos);

    this.zombieSpawnPoints = [
      new THREE.Vector3(-42, 0, -12),
      new THREE.Vector3(42, 0, -12),
      new THREE.Vector3(40, 0, -40),
      new THREE.Vector3(18, 0, -38),
      new THREE.Vector3(-40, 0, 12),
      new THREE.Vector3(40, 0, 14),
      new THREE.Vector3(0, 0, 48),
      new THREE.Vector3(-18, 0, -46),
      new THREE.Vector3(18, 0, 46),
      new THREE.Vector3(36, 0, -22),
      new THREE.Vector3(-42, 0, 44),
      new THREE.Vector3(42, 0, 44),
    ];

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
      dogSpawnPosition: new THREE.Vector3(-19, 0, 15),
      zombieSpawnPoints: this.zombieSpawnPoints,
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

  private buildGroundAndRoads(): void {
    const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.physicsWorld.addBody(groundBody);

    // Base cracked dirt/rubble ground
    const dirtTex = this.assets.getTexture('tex_dirt')?.clone();
    if (dirtTex) dirtTex.repeat.set(28, 28);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({ color: 0x5b5650, map: dirtTex ?? null, roughness: 0.97 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.raycastTargets.push(ground);

    // Asphalt avenues (X = 0 and Z = 0)
    const asphalt = this.assets.getTexture('tex_asphalt');
    const mkRoad = (w: number, d: number, y: number) => {
      const tex = asphalt?.clone();
      if (tex) tex.repeat.set(w / 7, d / 7);
      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshStandardMaterial({ color: 0x6b6b6e, map: tex ?? null, roughness: 0.9 })
      );
      road.rotation.x = -Math.PI / 2;
      road.position.y = y;
      road.receiveShadow = true;
      this.scene.add(road);
    };
    mkRoad(14, 140, 0.01);
    mkRoad(140, 14, 0.012);

    // Road markings: dashed centre lines, faded edge lines, crosswalks
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.8 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xb8b8b2, roughness: 0.85 });
    const addStrip = (x: number, z: number, w: number, d: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.02, z);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    for (let i = -63; i <= 63; i += 6) {
      if (Math.abs(i) < 12) continue;
      addStrip(0, i, 0.22, 2.8, lineMat);
      addStrip(i, 0, 2.8, 0.22, lineMat);
    }
    for (const s of [-1, 1]) {
      addStrip(s * 6.4, 0, 0.14, 140, whiteMat);
      addStrip(0, s * 6.4, 140, 0.14, whiteMat);
    }
    for (const s of [-1, 1]) {
      for (let k = -5; k <= 5; k += 1.25) {
        addStrip(k, s * 9.5, 0.6, 2.6, whiteMat);
        addStrip(s * 9.5, k, 2.6, 0.6, whiteMat);
      }
    }

    // Concrete sidewalks framing the 4 quadrants (thin so characters don't sink)
    const concrete = this.assets.getTexture('tex_concrete');
    const concreteN = this.assets.getTexture('tex_concrete_n');
    for (const [qx, qz] of [
      [-38, -38],
      [38, -38],
      [-38, 38],
      [38, 38],
    ]) {
      const tex = concrete?.clone();
      if (tex) tex.repeat.set(58 / 3, 58 / 3);
      const ntex = concreteN?.clone();
      if (ntex) ntex.repeat.set(58 / 3, 58 / 3);
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(58, 0.06, 58),
        new THREE.MeshStandardMaterial({ color: 0x8d8a84, map: tex ?? null, normalMap: ntex ?? null, roughness: 0.92 })
      );
      pad.position.set(qx, 0.03, qz);
      pad.receiveShadow = true;
      this.scene.add(pad);
    }
  }

  private buildPerimeterWalls(): void {
    const h = 5;
    const len = 144;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b6d70,
      map: this.assets.getTexture('tex_metal') ?? null,
      roughness: 0.8,
      metalness: 0.2,
    });
    const walls = [
      [0, h / 2, -70, len, h, 2],
      [0, h / 2, 70, len, h, 2],
      [-70, h / 2, 0, 2, h, len],
      [70, h / 2, 0, 2, h, len],
    ];
    for (const [x, y, z, sx, sy, sz] of walls) {
      const mesh = this.texturedBox(sx, sy, sz, mat, 4);
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      this.addStaticBox(x, y, z, sx, sy, sz, mesh, { occludes: true, blocksSight: true });
    }
  }

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
    signColor: string
  ): void {
    const h = 4.2;
    const t = 0.45;
    const mat = new THREE.MeshStandardMaterial({
      color: tintHex,
      map: this.assets.getTexture('tex_brick') ?? null,
      normalMap: this.assets.getTexture('tex_brick_n') ?? null,
      roughness: 0.9,
    });

    const floor = this.texturedBox(w - 0.2, 0.06, d - 0.2, this.floorInteriorMat, 2);
    floor.castShadow = false;
    floor.position.set(cx, 0.03, cz);
    this.scene.add(floor);

    const roof = this.texturedBox(w + 0.6, 0.4, d + 0.6, this.trimMat, 3);
    roof.position.set(cx, h + 0.2, cz);
    this.scene.add(roof);
    this.raycastTargets.push(roof);
    this.cameraOccluders.push(roof);

    // Parapet trim around the roof edge
    const trim = this.texturedBox(w + 0.8, 0.5, 0.3, this.trimMat, 3);
    for (const s of [-1, 1]) {
      const tz = trim.clone();
      tz.position.set(cx, h + 0.55, cz + s * (d / 2 + 0.35));
      this.scene.add(tz);
    }

    const makeWall = (x: number, z: number, sx: number, sz: number, hasDoor: boolean, isHorizontal: boolean) => {
      const addSeg = (px: number, pz: number, ssx: number, ssz: number) => {
        const wall = this.texturedBox(ssx, h, ssz, mat, 2.2);
        wall.position.set(px, h / 2, pz);
        this.scene.add(wall);
        this.addStaticBox(px, h / 2, pz, ssx, h, ssz, wall, { occludes: true, blocksSight: true });
      };
      if (!hasDoor) {
        addSeg(x, z, sx, sz);
        return;
      }

      const doorW = 3.0;
      const header = this.texturedBox(isHorizontal ? doorW : sx, 1.1, isHorizontal ? sz : doorW, mat, 2.2);
      header.position.set(x, h - 0.55, z);
      this.scene.add(header);
      this.cameraOccluders.push(header);

      // Neon sign above the doorway, facing out
      const sign = this.makeSign(signText, signColor, 3.6);
      const out = doorSide === 'north' ? -1 : doorSide === 'south' ? 1 : doorSide === 'west' ? -1 : 1;
      if (isHorizontal) {
        sign.position.set(x, h - 0.5, z + out * (sz / 2 + 0.03));
        sign.rotation.y = out > 0 ? 0 : Math.PI;
      } else {
        sign.position.set(x + out * (sx / 2 + 0.03), h - 0.5, z);
        sign.rotation.y = out > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      this.scene.add(sign);

      if (isHorizontal) {
        const segW = (sx - doorW) / 2;
        addSeg(x - (doorW / 2 + segW / 2), z, segW, sz);
        addSeg(x + (doorW / 2 + segW / 2), z, segW, sz);
      } else {
        const segD = (sz - doorW) / 2;
        addSeg(x, z - (doorW / 2 + segD / 2), sx, segD);
        addSeg(x, z + (doorW / 2 + segD / 2), sx, segD);
      }

      this.interactables.push({
        id: `barricade_${id}`,
        type: 'barricade',
        label: `Barricade ${id} Door`,
        subLabel: 'Costs 10 Scrap • Zombies can break it',
        position: new THREE.Vector3(x, 0.8, z),
        radius: 3.0,
        consumed: false,
        data: { horizontal: isHorizontal, width: doorW },
      });
    };

    makeWall(cx, cz - d / 2, w, t, doorSide === 'north', true);
    makeWall(cx, cz + d / 2, w, t, doorSide === 'south', true);
    makeWall(cx - w / 2, cz, t, d, doorSide === 'west', false);
    makeWall(cx + w / 2, cz, t, d, doorSide === 'east', false);

    // Warm interior ceiling bulb
    const light = new THREE.PointLight(0xffd2a1, 3.2, 16, 1.6);
    light.position.set(cx, h - 0.6, cz);
    this.scene.add(light);
  }

  // ───────── Procedural furniture (replaces models missing from the interior pack) ─────────

  private addFurniture(group: THREE.Group, x: number, z: number, rotY: number): void {
    group.position.set(x, FLOOR_Y, z);
    group.rotation.y = rotY;
    group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    this.scene.add(group);
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    this.addStaticBox(center.x, center.y, center.z, size.x, size.y, size.z, group);
  }

  private makeTable(w = 1.6, d = 0.9): THREE.Group {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), this.woodMat);
    top.position.y = 0.76;
    g.add(top);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.74, 0.06), this.woodMat);
        leg.position.set(sx * (w / 2 - 0.08), 0.37, sz * (d / 2 - 0.08));
        g.add(leg);
      }
    }
    return g;
  }

  private makeCounter(len = 4.5): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.95, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x3f2a22, roughness: 0.7 })
    );
    body.position.y = 0.475;
    g.add(body);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(len + 0.1, 0.06, 0.85),
      new THREE.MeshStandardMaterial({ color: 0xc9c4bc, roughness: 0.35, metalness: 0.1 })
    );
    top.position.y = 0.98;
    g.add(top);
    return g;
  }

  private makeFridge(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 1.95, 0.75),
      new THREE.MeshStandardMaterial({ color: 0xdcdcd6, roughness: 0.35, metalness: 0.25 })
    );
    body.position.y = 0.975;
    g.add(body);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04), this.metalMat);
    handle.position.set(0.32, 1.2, 0.4);
    g.add(handle);
    return g;
  }

  private populateSafehouse(cx: number, cz: number): void {
    this.placeModel('int_bed', cx - 5, cz + 4, Math.PI / 2, true);
    this.placeModel('int_bookshelf', cx + 5.5, cz + 5.5, Math.PI, true);
    this.addFurniture(this.makeTable(), cx + 3.5, cz - 2, 0);
    this.placeModel('int_chair', cx + 2.2, cz - 2, Math.PI / 2, false);
    this.placeModel('prop_couch', cx - 1, cz + 5.6, Math.PI, true);

    const firePos = new THREE.Vector3(cx, FLOOR_Y, cz - 2);
    const bonfire = this.assets.cloneModel('surv_bonfire');
    bonfire.position.copy(firePos);
    this.scene.add(bonfire);
    this.vfx.registerFireEmitter(firePos.clone().setY(0.2), 1.0);

    const fireLight = new THREE.PointLight(0xff7b29, 3.0, 12, 2);
    fireLight.position.set(firePos.x, 1.1, firePos.z);
    this.scene.add(fireLight);
    this.burningBarrels.push({ light: fireLight, baseIntensity: 3.0, phase: 0 });

    this.interactables.push({
      id: 'safehouse_campfire',
      type: 'campfire',
      label: 'Campfire Hub',
      subLabel: 'Rest to heal • Craft anytime with [Tab]',
      position: firePos.clone(),
      radius: 2.8,
    });

    this.spawnLootCrate('crate_safehouse', cx - 5, cz - 3, 'ammo_pistol');
  }

  private populatePharmacy(cx: number, cz: number): void {
    this.addFurniture(this.makeCounter(5), cx, cz - 3.5, 0);
    this.placeModel('int_shelf', cx - 6.8, cz - 4.5, Math.PI / 2, true);
    this.placeModel('int_shelf', cx + 6.8, cz - 4.5, -Math.PI / 2, true);
    this.placeModel('int_shelf', cx - 6.8, cz + 0.5, Math.PI / 2, true);

    this.spawnLootCrate('crate_pharm_1', cx - 4, cz + 2, 'medkit');
    this.spawnLootCrate('crate_pharm_2', cx + 4, cz + 2, 'ammo_shells');
    this.spawnJerrycan('jerrycan_1', cx + 5, cz - 1.5);
  }

  private populateDiner(cx: number, cz: number): void {
    this.addFurniture(this.makeCounter(6), cx + 4.5, cz, -Math.PI / 2);
    this.addFurniture(this.makeFridge(), cx + 6.6, cz + 4.8, -Math.PI / 2);
    this.addFurniture(this.makeTable(1.4, 1.4), cx - 3, cz + 3, 0);
    this.addFurniture(this.makeTable(1.4, 1.4), cx - 3, cz - 3, 0);
    this.placeModel('int_chair', cx - 4.2, cz + 3, Math.PI / 2, false);
    this.placeModel('int_chair', cx - 1.8, cz - 3, -Math.PI / 2, false);

    this.spawnLootCrate('crate_diner_1', cx + 2.5, cz - 4.5, 'burger');
    this.spawnLootCrate('crate_diner_2', cx - 4, cz + 5, 'water_bottle');
    this.spawnRadioBeacon('radio_beacon', cx + 4.5, cz + 0.2);
  }

  private buildOvergrownPark(cx: number, cz: number): void {
    const dirt = this.assets.getTexture('tex_dirt')?.clone();
    if (dirt) dirt.repeat.set(9, 9);
    const grass = new THREE.Mesh(
      new THREE.BoxGeometry(34, 0.08, 34),
      new THREE.MeshStandardMaterial({ color: 0x4d5e35, map: dirt ?? null, roughness: 0.97 })
    );
    grass.position.set(cx, 0.04, cz);
    grass.receiveShadow = true;
    this.scene.add(grass);

    this.placeModel('surv_tent', cx + 6, cz - 6, -Math.PI / 4, true);

    const treeCoords = [
      [cx - 10, cz - 10],
      [cx + 11, cz + 8],
      [cx - 8, cz + 10],
      [cx + 10, cz - 12],
      [cx - 13, cz - 1],
      [cx + 1, cz + 13],
    ];
    const trees = ['nat_deadtree', 'nat_deadtree2', 'nat_deadtree3'];
    for (let i = 0; i < treeCoords.length; i++) {
      const [tx, tz] = treeCoords[i];
      this.placeModel(trees[i % 3], tx, tz, i * 1.2, true);
    }

    for (const [bx, bz] of [
      [cx - 4, cz - 6],
      [cx + 4, cz + 5],
      [cx - 12, cz + 2],
      [cx + 2, cz - 11],
    ]) {
      this.placeModel('nat_bush_large', bx, bz, Math.random() * 6, false);
    }
    for (let i = 0; i < 26; i++) {
      const gx = cx + (Math.random() - 0.5) * 30;
      const gz = cz + (Math.random() - 0.5) * 30;
      const m = this.assets.cloneModel(i % 3 === 0 ? 'nat_bush_small' : 'nat_grass');
      m.position.set(gx, 0.08, gz);
      m.rotation.y = Math.random() * 6;
      m.scale.setScalar(0.8 + Math.random() * 0.6);
      this.scene.add(m);
    }

    this.spawnJerrycan('jerrycan_2', cx + 6, cz - 2.5);
    this.spawnLootCrate('crate_park', cx - 4, cz + 4, 'ammo_rifle');
  }

  private buildSkyline(): void {
    // [modelKey, x, z, rotY]  (rotY points the facade toward the district centre)
    const ring: [string, number, number, number][] = [
      ['bld_large', -55, -55, Math.PI / 4],
      ['bld_large', 55, 55, (-3 * Math.PI) / 4],
      ['bld_medium', 55, -55, -Math.PI / 4],
      ['bld_medium', -55, 55, (3 * Math.PI) / 4],
      ['bld_small', -57, -26, Math.PI / 2],
      ['bld_medium', -57, 0, Math.PI / 2],
      ['bld_small', -57, 27, Math.PI / 2],
      ['bld_small', 57, -26, -Math.PI / 2],
      ['bld_large', 58, 0, -Math.PI / 2],
      ['bld_small', 57, 27, -Math.PI / 2],
      ['bld_medium', -27, -59, 0],
      ['bld_small', 27, -59, 0],
      ['bld_medium', 27, 59, Math.PI],
      ['bld_small', -27, 59, Math.PI],
    ];
    for (const [key, x, z, rot] of ring) {
      const b = this.assets.cloneModel(key);
      b.position.set(x, 0, z);
      b.rotation.y = rot;
      this.scene.add(b);
      // Collect fake-interior window materials so they light up at night
      b.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of [].concat(mesh.material as never) as THREE.Material[]) {
          if (m instanceof THREE.MeshStandardMaterial && /fakeinterior/i.test(m.name) && !this.windowMaterials.includes(m)) {
            m.emissive.setHex(0xffc98a);
            m.emissiveMap = m.map;
            m.emissiveIntensity = 0;
            this.windowMaterials.push(m);
          }
        }
      });
      const box = new THREE.Box3().setFromObject(b);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      // Rotated footprints are inflated by Box3; shrink to stay close to the walls.
      const diag = Math.abs(Math.sin(rot * 2)) > 0.5;
      const k = diag ? 0.72 : 0.95;
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x * k, size.y, size.z * k));
      proxy.position.copy(center);
      proxy.visible = false;
      proxy.updateMatrixWorld();
      this.scene.add(proxy);
      this.addStaticBox(center.x, center.y, center.z, size.x * k, size.y, size.z * k, proxy, {
        occludes: true,
        blocksSight: true,
      });
    }
  }

  private buildStreetLights(): void {
    const positions = [
      [-8, -22, 0],
      [8, -22, Math.PI],
      [-8, 22, 0],
      [8, 22, Math.PI],
      [-24, -8, Math.PI / 2],
      [24, 8, -Math.PI / 2],
      [-8, -46, 0],
      [8, 46, Math.PI],
      [-46, 8, Math.PI / 2],
      [46, -8, -Math.PI / 2],
    ];
    for (let i = 0; i < positions.length; i++) {
      const [x, z, rot] = positions[i];
      const pole = this.assets.cloneModel('street_light_single');
      pole.position.set(x, 0, z);
      pole.rotation.y = rot;
      this.scene.add(pole);
      this.raycastTargets.push(pole);

      const light = new THREE.PointLight(0xffd59a, 2.2, 22, 1.7);
      light.position.set(x, 5.1, z);
      this.scene.add(light);

      const bulbMat = new THREE.MeshStandardMaterial({
        color: 0xfff3d1,
        emissive: 0xffd27d,
        emissiveIntensity: 2.0,
      });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), bulbMat);
      bulb.position.set(x, 5.1, z);
      this.scene.add(bulb);

      this.streetLights.push({ light, bulbMat, baseIntensity: 2.2, failsAtNight: i % 3 === 1 });
    }
  }

  private buildTransitAndCover(): void {
    this.placeVehicle('veh_bus', -2, -20, 0.35);
    this.placeVehicle('veh_schoolbus', 22, -4, Math.PI / 2 + 0.2);
    this.placeVehicle('veh_sports', 5, 16, -0.5);
    this.placeVehicle('veh_ambulance', -16, -5, Math.PI / 2 - 0.2);
    this.placeVehicle('veh_pickup', -4, 34, 0.15);
    this.placeVehicle('veh_truck', 34, -6.5, Math.PI / 2 + 0.05);
    this.placeVehicle('veh_pickup', -38, -3, -Math.PI / 2 + 0.3);
    this.placeVehicle('veh_sports', 3.5, -38, 2.9);

    this.spawnJerrycan('jerrycan_3', 2, -24);
    this.spawnLootCrate('crate_ambulance', -16, -1.5, 'medkit');
    this.spawnLootCrate('crate_bus', 22, 1.5, 'canned_food');
    this.spawnLootCrate('crate_pickup', -4, 38, 'ammo_pistol');
    this.spawnLootCrate('crate_truck', 34, -2, 'chocolate');

    this.placeModel('prop_container_green', -12, -38, 0.1, true);
    this.placeModel('prop_container_red', 14, 38, -0.15, true);
    this.placeModel('prop_barrier', -4, -10, 0.1, true);
    this.placeModel('prop_barrier', 4, 10, 0.2, true);
    this.placeModel('prop_barrier2', -10, 4, 1.5, true);
    this.placeModel('prop_plastic_barrier', 10, -3, 1.4, true);
    this.placeModel('prop_hydrant', -8.5, 11, 0, false);
    this.placeModel('prop_cone', -3, -8, 0, false);
    this.placeModel('prop_cone', 3, 8, 0, false);
    this.placeModel('prop_cone', -1.5, -9, 0.6, false);

    this.interactables.push({
      id: 'recruit_dog',
      type: 'dog',
      label: 'Recruit Survivor Dog',
      subLabel: 'Barks to warn of zombies & pins lone threats',
      position: new THREE.Vector3(-19, 0.6, 15),
      radius: 3.0,
      consumed: false,
    });
  }

  private scatterDebris(): void {
    const items: [string, number, number][] = [
      ['prop_trashbag', -9.5, 18],
      ['prop_trashbag2', -10.2, 18.7],
      ['prop_trashbag', 18, 9.5],
      ['prop_trashbag2', -36, -10],
      ['prop_trashbag', 36, 18],
      ['prop_wheels', 16, 10],
      ['prop_wheels', -44, -20],
      ['prop_pallet_broken', -14, 10],
      ['prop_pallet_broken', 12, -12],
      ['prop_cinder', -11, 12],
      ['prop_cinder', 15, -10],
      ['surv_trashcan', -9, -14],
      ['surv_trashcan', 9, 14],
      ['surv_propane', 20, 20],
      ['prop_ac', -19.6, 33],
    ];
    for (const [k, x, z] of items) {
      this.placeModel(k, x, z, Math.random() * Math.PI * 2, k === 'prop_wheels' || k === 'surv_trashcan');
    }
  }

  private buildExtractionZone(pos: THREE.Vector3): { light: THREE.PointLight; marker: ObjectiveMarker } {
    const truck = this.assets.cloneModel('veh_truck_armored');
    truck.position.copy(pos);
    truck.scale.setScalar(1.2);
    this.scene.add(truck);
    const box = new THREE.Box3().setFromObject(truck);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    this.addStaticBox(center.x, center.y, center.z, size.x * 0.9, size.y, size.z * 0.9, truck, { occludes: true });

    const beaconMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 3.0,
    });
    const beaconMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.35, 12), beaconMat);
    beaconMesh.position.set(pos.x, box.max.y + 0.15, pos.z);
    this.scene.add(beaconMesh);

    const beaconLight = new THREE.PointLight(0xf59e0b, 3.5, 24, 1.6);
    beaconLight.position.set(pos.x, box.max.y + 0.6, pos.z);
    this.scene.add(beaconLight);

    // Sandbag-style barrier ring
    this.placeModel('prop_barrier', pos.x - 5, pos.z + 4, 0.4, true);
    this.placeModel('prop_barrier', pos.x + 5, pos.z + 4, -0.4, true);

    const markerPos = pos.clone().add(new THREE.Vector3(0, 0, 4.2));
    const marker = this.vfx.createObjectiveMarker(markerPos, 0x22c55e);
    marker.setActive(false);

    this.interactables.push({
      id: 'extraction_truck',
      type: 'extraction_truck',
      label: 'Armored Extraction Truck',
      subLabel: 'Requires 3 Jerrycans + Radio Beacon',
      position: pos.clone().add(new THREE.Vector3(0, 1, 4.2)),
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
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      this.addStaticBox(
        center.x,
        center.y,
        center.z,
        Math.max(0.6, size.x * 0.85),
        Math.max(0.8, size.y),
        Math.max(0.6, size.z * 0.85),
        model,
        { occludes: size.y > 2.2 }
      );
    } else {
      this.raycastTargets.push(model);
    }
    return model;
  }

  private placeVehicle(key: string, x: number, z: number, rotY: number): void {
    const veh = this.assets.cloneModel(key);
    veh.position.set(x, 0, z);
    veh.rotation.y = rotY;
    this.scene.add(veh);

    // Oriented physics box from the un-rotated local bounds
    veh.rotation.y = 0;
    veh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(veh);
    veh.rotation.y = rotY;
    veh.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(size.x * 0.45, size.y * 0.5, size.z * 0.46)),
      position: new CANNON.Vec3(x, center.y, z),
    });
    body.quaternion.setFromEuler(0, rotY, 0);
    this.physicsWorld.addBody(body);
    this.raycastTargets.push(veh);
    if (size.y > 2.2) this.cameraOccluders.push(veh);
  }

  private placeBurningBarrel(x: number, z: number): void {
    this.placeModel('prop_barrel', x, z, Math.random() * 3, true);
    const pos = new THREE.Vector3(x, 1.05, z);
    this.vfx.registerFireEmitter(pos, 1.15);

    const light = new THREE.PointLight(0xff6b1a, 2.8, 16, 1.8);
    light.position.set(x, 1.6, z);
    this.scene.add(light);
    this.burningBarrels.push({ light, baseIntensity: 2.8, phase: Math.random() * 10 });
  }

  private spawnLootCrate(id: string, x: number, z: number, itemId: string): void {
    const crate = this.assets.cloneModel('prop_chest_special');
    crate.position.set(x, FLOOR_Y, z);
    crate.rotation.y = Math.random() * Math.PI;
    this.scene.add(crate);

    const marker = this.vfx.createObjectiveMarker(new THREE.Vector3(x, FLOOR_Y, z), 0xfbbf24);
    marker.group.scale.set(0.6, 0.35, 0.6);

    this.interactables.push({
      id,
      type: 'loot',
      label: 'Supply Crate',
      subLabel: 'Press [E] to Scavenge',
      position: new THREE.Vector3(x, 0.6, z),
      radius: 2.5,
      consumed: false,
      mesh: crate,
      data: { itemId, marker },
    });
  }

  private spawnJerrycan(id: string, x: number, z: number): void {
    const can = this.assets.cloneModel('surv_gascan');
    can.position.set(x, FLOOR_Y, z);
    this.scene.add(can);
    const marker = this.vfx.createObjectiveMarker(new THREE.Vector3(x, FLOOR_Y, z), 0xef4444);

    this.interactables.push({
      id,
      type: 'jerrycan',
      label: 'Fuel Jerrycan',
      subLabel: 'Extraction Objective [E]',
      position: new THREE.Vector3(x, 0.6, z),
      radius: 2.5,
      consumed: false,
      mesh: can,
      data: { marker },
    });
  }

  private spawnRadioBeacon(id: string, x: number, z: number): void {
    const radio = this.assets.cloneModel('surv_radio');
    radio.position.set(x, 1.02, z);
    this.scene.add(radio);
    const marker = this.vfx.createObjectiveMarker(new THREE.Vector3(x, 1.0, z), 0x38bdf8);

    this.interactables.push({
      id,
      type: 'beacon',
      label: 'Radio Beacon Parts',
      subLabel: 'Extraction Objective [E]',
      position: new THREE.Vector3(x, 1.0, z),
      radius: 2.5,
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
    for (let i = 0; i < 2; i++) {
      const pallet = assets.cloneModel('prop_pallet');
      pallet.scale.set(2.1, 1.5, 1.2);
      pallet.position.set(0, 0, i === 0 ? -0.12 : 0.12);
      pallet.rotation.z = i === 0 ? 0.04 : -0.05;
      mesh.add(pallet);
    }
    mesh.position.set(item.position.x, FLOOR_Y, item.position.z);
    if (!horizontal) mesh.rotation.y = Math.PI / 2;
    scene.add(mesh);

    const sx = horizontal ? 3.0 : 0.7;
    const sz = horizontal ? 0.7 : 3.0;
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx * 0.5, 1.0, sz * 0.5)),
      position: new CANNON.Vec3(item.position.x, 1.0, item.position.z),
    });
    physicsWorld.addBody(body);
    return { mesh, body };
  }
}
