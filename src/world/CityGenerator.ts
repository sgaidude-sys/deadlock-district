import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { AssetManager } from '../core/AssetManager';
import { VFXManager } from '../core/VFXManager';
import { InteractableObject } from '../types/game';

export interface StreetLightNode {
  light: THREE.PointLight;
  bulbMat: THREE.MeshStandardMaterial;
  baseIntensity: number;
}

export interface BurningBarrel {
  light: THREE.PointLight;
  baseIntensity: number;
  phase: number;
}

export interface CityWorldData {
  raycastTargets: THREE.Object3D[];
  interactables: InteractableObject[];
  streetLights: StreetLightNode[];
  burningBarrels: BurningBarrel[];
  barricadeBodies: Map<string, CANNON.Body>;
  extractionBeaconLight: THREE.PointLight;
  extractionPosition: THREE.Vector3;
  campfirePosition: THREE.Vector3;
  dogSpawnPosition: THREE.Vector3;
  zombieSpawnPoints: THREE.Vector3[];
}

export class CityGenerator {
  private scene: THREE.Scene;
  private physicsWorld: CANNON.World;
  private assets: AssetManager;
  private vfx: VFXManager;

  private raycastTargets: THREE.Object3D[] = [];
  private interactables: InteractableObject[] = [];
  private streetLights: StreetLightNode[] = [];
  private burningBarrels: BurningBarrel[] = [];
  private barricadeBodies = new Map<string, CANNON.Body>();
  private zombieSpawnPoints: THREE.Vector3[] = [];

  private wallMat: THREE.MeshStandardMaterial;
  private trimMat: THREE.MeshStandardMaterial;
  private floorInteriorMat: THREE.MeshStandardMaterial;

  constructor(
    scene: THREE.Scene,
    physicsWorld: CANNON.World,
    assets: AssetManager,
    vfx: VFXManager
  ) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.vfx = vfx;

    this.wallMat = new THREE.MeshStandardMaterial({
      color: 0x3b3836,
      roughness: 0.9,
      metalness: 0.05,
    });
    this.trimMat = new THREE.MeshStandardMaterial({
      color: 0x222428,
      roughness: 0.85,
      metalness: 0.15,
    });
    this.floorInteriorMat = new THREE.MeshStandardMaterial({
      color: 0x4b4237,
      roughness: 0.85,
    });
  }

  public generate(): CityWorldData {
    this.buildGroundAndRoads();
    this.buildPerimeterWalls();

    // 4-Block Urban Quarantine Zone
    // 1. SW Block: Quarantine Safehouse
    const campfirePos = new THREE.Vector3(-28, 0, 26);
    this.buildEnterableBuilding('Safehouse', -28, 28, 16, 14, 0x4e433c, 'north');
    this.populateSafehouse(-28, 28);

    // 2. NW Block: Downtown Pharmacy
    this.buildEnterableBuilding('Pharmacy', -28, -28, 16, 14, 0x36444e, 'south');
    this.populatePharmacy(-28, -28);

    // 3. SE Block: Corner Diner
    this.buildEnterableBuilding('Diner', 28, 28, 16, 14, 0x523a36, 'west');
    this.populateDiner(28, 28);

    // 4. NE Block: Overgrown City Park Square
    this.buildOvergrownPark(28, -28);

    // Multi-story background/corner city blocks using Downtown City MegaKit
    this.buildSkylineBlock(-52, -52, 18, 18, 14);
    this.buildSkylineBlock(52, -52, 18, 18, 16);
    this.buildSkylineBlock(-52, 52, 18, 18, 12);
    this.buildSkylineBlock(52, 52, 18, 18, 15);
    this.buildSkylineBlock(-52, 0, 14, 22, 11);
    this.buildSkylineBlock(52, 0, 14, 22, 13);

    // Streetlights along main avenues
    this.buildStreetLights();

    // Public Transport & Wrecked Vehicles + Bus Depot choke points
    this.buildTransitAndCover();

    // Burning Barrels
    this.placeBurningBarrel(-9, 9);
    this.placeBurningBarrel(9, -9);
    this.placeBurningBarrel(-20, 16);
    this.placeBurningBarrel(10, -45);

    // Extraction Armored Truck at North Gate
    const extractionPos = new THREE.Vector3(0, 0, -56);
    const extractionLight = this.buildExtractionZone(extractionPos);

    // Zombie spawn points around alleys, park, and perimeter
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
    ];

    return {
      raycastTargets: this.raycastTargets,
      interactables: this.interactables,
      streetLights: this.streetLights,
      burningBarrels: this.burningBarrels,
      barricadeBodies: this.barricadeBodies,
      extractionBeaconLight: extractionLight,
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
    mesh?: THREE.Object3D
  ): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(sx * 0.5, sy * 0.5, sz * 0.5)),
      position: new CANNON.Vec3(x, y, z),
    });
    this.physicsWorld.addBody(body);
    if (mesh) {
      this.raycastTargets.push(mesh);
    }
    return body;
  }

  private buildGroundAndRoads(): void {
    // Ground physics plane
    const groundBody = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Plane(),
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.physicsWorld.addBody(groundBody);

    // Base concrete/asphalt district ground
    const groundGeo = new THREE.PlaneGeometry(160, 160);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x26282c,
      roughness: 0.95,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.raycastTargets.push(ground);

    // Main avenues (X = 0 and Z = 0)
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.92 });
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(14, 140), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.01;
    roadNS.receiveShadow = true;
    this.scene.add(roadNS);

    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(140, 14), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.012;
    roadEW.receiveShadow = true;
    this.scene.add(roadEW);

    // Road markings
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xb48a28, roughness: 0.8 });
    for (let i = -60; i <= 60; i += 6) {
      if (Math.abs(i) < 9) continue;
      const dashNS = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 2.8), lineMat);
      dashNS.rotation.x = -Math.PI / 2;
      dashNS.position.set(0, 0.02, i);
      this.scene.add(dashNS);

      const dashEW = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.25), lineMat);
      dashEW.rotation.x = -Math.PI / 2;
      dashEW.position.set(i, 0.02, 0);
      this.scene.add(dashEW);
    }

    // Sidewalks framing the 4 quadrants
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9 });
    const quadrants = [
      [-38, -38],
      [38, -38],
      [-38, 38],
      [38, 38],
    ];
    for (const [qx, qz] of quadrants) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(58, 0.14, 58), sidewalkMat);
      pad.position.set(qx, 0.07, qz);
      pad.receiveShadow = true;
      this.scene.add(pad);
    }
  }

  private buildPerimeterWalls(): void {
    const h = 5;
    const len = 144;
    const walls = [
      [0, h / 2, -70, len, h, 2],
      [0, h / 2, 70, len, h, 2],
      [-70, h / 2, 0, 2, h, len],
      [70, h / 2, 0, 2, h, len],
    ];
    for (const [x, y, z, sx, sy, sz] of walls) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), this.trimMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.addStaticBox(x, y, z, sx, sy, sz, mesh);
    }
  }

  private buildEnterableBuilding(
    id: string,
    cx: number,
    cz: number,
    w: number,
    d: number,
    colorHex: number,
    doorSide: 'north' | 'south' | 'east' | 'west'
  ): void {
    const h = 4.2;
    const t = 0.45;
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.88 });

    // Interior floor
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w - 0.2, 0.18, d - 0.2), this.floorInteriorMat);
    floor.position.set(cx, 0.09, cz);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Roof (slightly overhanging)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.4, d + 0.6), this.trimMat);
    roof.position.set(cx, h + 0.2, cz);
    roof.castShadow = true;
    roof.receiveShadow = true;
    this.scene.add(roof);
    this.raycastTargets.push(roof);

    // Helper for wall segments (splits wall if it's the doorSide)
    const makeWall = (
      x: number,
      z: number,
      sx: number,
      sz: number,
      hasDoor: boolean,
      isHorizontal: boolean
    ) => {
      if (!hasDoor) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat);
        wall.position.set(x, h / 2, z);
        wall.castShadow = true;
        wall.receiveShadow = true;
        this.scene.add(wall);
        this.addStaticBox(x, h / 2, z, sx, h, sz, wall);
        return;
      }

      const doorW = 3.0;
      if (isHorizontal) {
        const segW = (sx - doorW) / 2;
        const left = new THREE.Mesh(new THREE.BoxGeometry(segW, h, sz), mat);
        left.position.set(x - (doorW / 2 + segW / 2), h / 2, z);
        left.castShadow = true;
        left.receiveShadow = true;
        this.scene.add(left);
        this.addStaticBox(left.position.x, h / 2, z, segW, h, sz, left);

        const right = new THREE.Mesh(new THREE.BoxGeometry(segW, h, sz), mat);
        right.position.set(x + (doorW / 2 + segW / 2), h / 2, z);
        right.castShadow = true;
        right.receiveShadow = true;
        this.scene.add(right);
        this.addStaticBox(right.position.x, h / 2, z, segW, h, sz, right);

        // Header above door
        const header = new THREE.Mesh(new THREE.BoxGeometry(doorW, 1.1, sz), mat);
        header.position.set(x, h - 0.55, z);
        this.scene.add(header);
      } else {
        const segD = (sz - doorW) / 2;
        const top = new THREE.Mesh(new THREE.BoxGeometry(sx, h, segD), mat);
        top.position.set(x, h / 2, z - (doorW / 2 + segD / 2));
        top.castShadow = true;
        top.receiveShadow = true;
        this.scene.add(top);
        this.addStaticBox(x, h / 2, top.position.z, sx, h, segD, top);

        const bot = new THREE.Mesh(new THREE.BoxGeometry(sx, h, segD), mat);
        bot.position.set(x, h / 2, z + (doorW / 2 + segD / 2));
        bot.castShadow = true;
        bot.receiveShadow = true;
        this.scene.add(bot);
        this.addStaticBox(x, h / 2, bot.position.z, sx, h, segD, bot);

        const header = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.1, doorW), mat);
        header.position.set(x, h - 0.55, z);
        this.scene.add(header);
      }

      // Add barricadable door interactable!
      const barricadeId = `barricade_${id}`;
      this.interactables.push({
        id: barricadeId,
        type: 'barricade',
        label: `Barricade ${id} Door`,
        subLabel: 'Costs 10 Scrap (Blocks Zombies)',
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
    const light = new THREE.PointLight(0xffd2a1, 1.4, 15, 1.8);
    light.position.set(cx, h - 0.6, cz);
    this.scene.add(light);
  }

  private populateSafehouse(cx: number, cz: number): void {
    this.placeModel('int_bed', cx - 5, cz + 4, Math.PI / 2, true);
    this.placeModel('int_bookshelf', cx + 5.5, cz + 5.5, Math.PI, true);
    this.placeModel('int_table', cx + 3.5, cz - 2, 0, true);
    this.placeModel('int_chair', cx + 2, cz - 2, Math.PI / 2, false);

    // Starter Campfire (Safe-zone heal/craft hub)
    const firePos = new THREE.Vector3(cx, 0.15, cz - 2);
    const bonfire = this.assets.cloneModel('surv_bonfire');
    bonfire.position.copy(firePos);
    this.scene.add(bonfire);
    this.vfx.registerFireEmitter(firePos, 1.0);

    const fireLight = new THREE.PointLight(0xff7b29, 3.0, 12, 2);
    fireLight.position.set(firePos.x, 1.1, firePos.z);
    this.scene.add(fireLight);
    this.burningBarrels.push({ light: fireLight, baseIntensity: 3.0, phase: 0 });

    this.interactables.push({
      id: 'safehouse_campfire',
      type: 'campfire',
      label: 'Campfire Hub',
      subLabel: 'Rest (Heal) & Craft Ammo/Medkits [Tab]',
      position: firePos.clone(),
      radius: 2.8,
    });

    // Starter Supply Chest
    this.spawnLootCrate('crate_safehouse', cx - 5, cz - 3, 'ammo_pistol');
  }

  private populatePharmacy(cx: number, cz: number): void {
    this.placeModel('int_counter', cx, cz - 3.5, 0, true);
    this.placeModel('int_bookshelf', cx - 5.5, cz - 4.5, Math.PI / 2, true);
    this.placeModel('int_bookshelf', cx + 5.5, cz - 4.5, -Math.PI / 2, true);

    this.spawnLootCrate('crate_pharm_1', cx - 4, cz + 2, 'medkit');
    this.spawnLootCrate('crate_pharm_2', cx + 4, cz + 2, 'ammo_shells');
    this.spawnJerrycan('jerrycan_1', cx + 5, cz - 1.5);
  }

  private populateDiner(cx: number, cz: number): void {
    this.placeModel('int_counter', cx + 4.5, cz, -Math.PI / 2, true);
    this.placeModel('int_fridge', cx + 5.8, cz + 4.5, -Math.PI / 2, true);
    this.placeModel('int_table', cx - 3, cz + 3, 0, true);
    this.placeModel('int_table', cx - 3, cz - 3, 0, true);

    this.spawnLootCrate('crate_diner_1', cx + 3.5, cz - 4, 'burger');
    this.spawnLootCrate('crate_diner_2', cx - 4, cz + 4.5, 'water_bottle');
    this.spawnRadioBeacon('radio_beacon', cx + 4.5, cz + 0.2);
  }

  private buildOvergrownPark(cx: number, cz: number): void {
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x263826, roughness: 0.95 });
    const grass = new THREE.Mesh(new THREE.BoxGeometry(34, 0.18, 34), grassMat);
    grass.position.set(cx, 0.09, cz);
    grass.receiveShadow = true;
    this.scene.add(grass);

    // Tent & camp
    this.placeModel('surv_tent', cx + 6, cz - 6, -Math.PI / 4, true);

    // Dead trees, bushes, boulders
    const treeCoords = [
      [cx - 10, cz - 10],
      [cx + 11, cz + 8],
      [cx - 8, cz + 10],
      [cx + 10, cz - 12],
    ];
    for (let i = 0; i < treeCoords.length; i++) {
      const [tx, tz] = treeCoords[i];
      this.placeModel(i % 2 === 0 ? 'nat_deadtree' : 'nat_deadtree2', tx, tz, i * 1.2, true);
    }

    const bushCoords = [
      [cx - 4, cz - 6],
      [cx + 4, cz + 5],
      [cx - 12, cz + 2],
      [cx + 2, cz - 11],
    ];
    for (const [bx, bz] of bushCoords) {
      this.placeModel('nat_bush_large', bx, bz, Math.random() * 6, false);
    }

    this.placeModel('nat_rock', cx - 3, cz + 2, 0.5, true);
    this.placeModel('nat_rock', cx + 5, cz - 1, 2.1, true);

    // Park Jerrycan & Loot
    this.spawnJerrycan('jerrycan_2', cx + 6, cz - 4);
    this.spawnLootCrate('crate_park', cx - 4, cz + 4, 'ammo_rifle');
  }

  private buildSkylineBlock(cx: number, cz: number, w: number, d: number, h: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.9 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(cx, h / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.addStaticBox(cx, h / 2, cz, w, h, d, mesh);

    // Add Downtown City MegaKit facade accents along street-facing side
    const facade = this.assets.cloneModel('city_brick_wall');
    facade.position.set(cx, 0, cz + (cz < 0 ? d / 2 + 0.1 : -d / 2 - 0.1));
    facade.scale.set(2.2, 2.2, 2.2);
    this.scene.add(facade);
  }

  private buildStreetLights(): void {
    const positions = [
      [-8, -22, 0],
      [8, -22, Math.PI],
      [-8, 22, 0],
      [8, 22, Math.PI],
      [-24, -8, Math.PI / 2],
      [24, 8, -Math.PI / 2],
    ];
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff3d1,
      emissive: 0xffd27d,
      emissiveIntensity: 2.0,
    });

    for (const [x, z, rot] of positions) {
      const pole = this.assets.cloneModel('street_light_single');
      pole.position.set(x, 0, z);
      pole.rotation.y = rot;
      this.scene.add(pole);

      const light = new THREE.PointLight(0xffdca8, 2.2, 22, 1.7);
      light.position.set(x, 5.1, z);
      this.scene.add(light);

      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), bulbMat);
      bulb.position.set(x, 5.1, z);
      this.scene.add(bulb);

      this.streetLights.push({ light, bulbMat, baseIntensity: 2.2 });
    }
  }

  private buildTransitAndCover(): void {
    // Central Bus Depot & Intersection Wreckage
    this.placeVehicle('veh_bus', -2, -20, 0.35);
    this.placeVehicle('veh_schoolbus', 22, -4, Math.PI / 2 + 0.2);
    this.placeVehicle('veh_taxi', 5, 16, -0.5);
    this.placeVehicle('veh_ambulance', -16, -5, Math.PI / 2 - 0.2);

    // Jerrycan #3 at the Central Bus Depot
    this.spawnJerrycan('jerrycan_3', 2, -23);
    this.spawnLootCrate('crate_ambulance', -16, -2.5, 'medkit');
    this.spawnLootCrate('crate_bus', 22, 0.5, 'canned_food');

    // Shipping containers & road barriers
    this.placeModel('prop_container_green', -12, -38, 0.1, true);
    this.placeModel('prop_container_red', 14, 38, -0.15, true);
    this.placeModel('prop_barrier', -4, -10, 0.1, true);
    this.placeModel('prop_barrier', 4, 10, 0.2, true);
    this.placeModel('prop_hydrant', -8.5, 11, 0, false);
    this.placeModel('prop_cone', -3, -8, 0, false);
    this.placeModel('prop_cone', 3, 8, 0, false);

    // Dog spawn interactable (Recruitable Companion Dog near Safehouse street)
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

  private buildExtractionZone(pos: THREE.Vector3): THREE.PointLight {
    // Armored Extraction Truck (represented by Ambulance/Truck + barrier + pulsing beacon)
    const truck = this.assets.cloneModel('veh_ambulance');
    truck.position.copy(pos);
    truck.scale.setScalar(1.25);
    this.scene.add(truck);
    this.addStaticBox(pos.x, 1.4, pos.z, 3.2, 2.8, 6.4, truck);

    const beaconMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 3.0,
    });
    const beaconMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.45, 12), beaconMat);
    beaconMesh.position.set(pos.x, 3.1, pos.z);
    this.scene.add(beaconMesh);

    const beaconLight = new THREE.PointLight(0xf59e0b, 3.5, 24, 1.6);
    beaconLight.position.set(pos.x, 3.5, pos.z);
    this.scene.add(beaconLight);

    this.interactables.push({
      id: 'extraction_truck',
      type: 'extraction_truck',
      label: 'Armored Extraction Truck',
      subLabel: 'Requires 3 Jerrycans + Radio Beacon',
      position: pos.clone().add(new THREE.Vector3(0, 1, 3.5)),
      radius: 4.0,
    });

    return beaconLight;
  }

  private placeModel(key: string, x: number, z: number, rotY: number, hasCollider: boolean): THREE.Group {
    const model = this.assets.cloneModel(key);
    model.position.set(x, 0, z);
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
        model
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

    const box = new THREE.Box3().setFromObject(veh);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // Axis-aligned approximation for physics; tight enough for urban cover
    this.addStaticBox(center.x, center.y, center.z, size.x * 0.85, size.y, size.z * 0.85, veh);
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
    crate.position.set(x, 0.18, z);
    crate.rotation.y = Math.random() * Math.PI;
    this.scene.add(crate);

    this.interactables.push({
      id,
      type: 'loot',
      label: 'Supply Crate',
      subLabel: 'Press [E] to Scavenge',
      position: new THREE.Vector3(x, 0.6, z),
      radius: 2.5,
      consumed: false,
      mesh: crate,
      data: { itemId },
    });
  }

  private spawnJerrycan(id: string, x: number, z: number): void {
    const can = this.assets.cloneModel('surv_gascan');
    can.position.set(x, 0.18, z);
    this.scene.add(can);

    const glow = new THREE.PointLight(0xef4444, 1.4, 5);
    glow.position.set(x, 0.8, z);
    this.scene.add(glow);

    this.interactables.push({
      id,
      type: 'jerrycan',
      label: 'Fuel Jerrycan',
      subLabel: 'Extraction Objective [E]',
      position: new THREE.Vector3(x, 0.6, z),
      radius: 2.5,
      consumed: false,
      mesh: can,
      data: { glow },
    });
  }

  private spawnRadioBeacon(id: string, x: number, z: number): void {
    const radio = this.assets.cloneModel('surv_radio');
    radio.position.set(x, 1.0, z);
    this.scene.add(radio);

    const glow = new THREE.PointLight(0x38bdf8, 1.6, 5);
    glow.position.set(x, 1.4, z);
    this.scene.add(glow);

    this.interactables.push({
      id,
      type: 'beacon',
      label: 'Radio Beacon Parts',
      subLabel: 'Extraction Objective [E]',
      position: new THREE.Vector3(x, 1.0, z),
      radius: 2.5,
      consumed: false,
      mesh: radio,
      data: { glow },
    });
  }

  public placeBarricade(interactable: InteractableObject): void {
    if (interactable.consumed) return;
    interactable.consumed = true;

    const pallet = this.assets.cloneModel('prop_pallet');
    pallet.position.set(interactable.position.x, 0, interactable.position.z);
    const horizontal = Boolean(interactable.data?.horizontal);
    if (!horizontal) {
      pallet.rotation.y = Math.PI / 2;
    }
    pallet.scale.set(2.2, 1.6, 1.2);
    this.scene.add(pallet);

    const sx = horizontal ? 3.0 : 0.6;
    const sz = horizontal ? 0.6 : 3.0;
    const body = this.addStaticBox(interactable.position.x, 1.0, interactable.position.z, sx, 2.0, sz, pallet);
    this.barricadeBodies.set(interactable.id, body);
  }
}
