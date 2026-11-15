import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface AssetEntry {
  key: string;
  url: string;
  type: 'gltf' | 'fbx' | 'texture' | 'audio';
  targetHeight?: number;
  centerGround?: boolean;
  textureOverride?: string;
  /** Tiling texture (RepeatWrapping + anisotropy). */
  repeat?: boolean;
  /** Non-colour data texture (normal maps). */
  linear?: boolean;
  /** Recolour untextured materials: material-name keyword -> hex colour. '*' is the fallback. */
  palette?: Record<string, number>;
}

const BUS_PALETTE: Record<string, number> = {
  window: 0x1b2430,
  glass: 0x1b2430,
  light: 0xfff1c2,
  bumper: 0x1e2023,
  bottom: 0x2b2e33,
  detail: 0x6b7078,
  '*': 0x2f6fb0,
};
const SCHOOLBUS_PALETTE: Record<string, number> = { ...BUS_PALETTE, bottom: 0x22252a, '*': 0xd99a16 };
const AMBULANCE_PALETTE: Record<string, number> = { ...BUS_PALETTE, detail: 0xb91c1c, '*': 0xd8dadc };

export const ASSET_MANIFEST: AssetEntry[] = [
  // 1. Zombie Apocalypse Kit — Survivors, Dog, Props, Barricades, Vehicles
  { key: 'survivor_matt', url: '/assets/zombie-kit/Characters/glTF/Characters_Matt.gltf', type: 'gltf', targetHeight: 1.82 },
  { key: 'survivor_lis', url: '/assets/zombie-kit/Characters/glTF/Characters_Lis.gltf', type: 'gltf', targetHeight: 1.76 },
  { key: 'survivor_sam', url: '/assets/zombie-kit/Characters/glTF/Characters_Sam.gltf', type: 'gltf', targetHeight: 1.82 },
  { key: 'survivor_shaun', url: '/assets/zombie-kit/Characters/glTF/Characters_Shaun.gltf', type: 'gltf', targetHeight: 1.82 },
  { key: 'dog_shepherd', url: '/assets/zombie-kit/Characters/glTF/Characters_GermanShepherd.gltf', type: 'gltf', targetHeight: 0.78 },

  { key: 'prop_barrel', url: '/assets/zombie-kit/Environment/glTF/Barrel.gltf', type: 'gltf', targetHeight: 1.05 },
  { key: 'prop_chest_special', url: '/assets/zombie-kit/Environment/glTF/Chest_Special.gltf', type: 'gltf', targetHeight: 0.85 },
  { key: 'prop_container_green', url: '/assets/zombie-kit/Environment/glTF/Container_Green.gltf', type: 'gltf', targetHeight: 2.7 },
  { key: 'prop_container_red', url: '/assets/zombie-kit/Environment/glTF/Container_Red.gltf', type: 'gltf', targetHeight: 2.7 },
  { key: 'prop_pallet', url: '/assets/zombie-kit/Environment/glTF/Pallet.gltf', type: 'gltf', targetHeight: 1.25 },
  { key: 'prop_pallet_broken', url: '/assets/zombie-kit/Environment/glTF/Pallet_Broken.gltf', type: 'gltf', targetHeight: 0.4 },
  { key: 'prop_barrier', url: '/assets/zombie-kit/Environment/glTF/TrafficBarrier_1.gltf', type: 'gltf', targetHeight: 1.1 },
  { key: 'prop_barrier2', url: '/assets/zombie-kit/Environment/glTF/TrafficBarrier_2.gltf', type: 'gltf', targetHeight: 1.1 },
  { key: 'prop_plastic_barrier', url: '/assets/zombie-kit/Environment/glTF/PlasticBarrier.gltf', type: 'gltf', targetHeight: 1.0 },
  { key: 'prop_cone', url: '/assets/zombie-kit/Environment/glTF/TrafficCone_1.gltf', type: 'gltf', targetHeight: 0.7 },
  { key: 'prop_hydrant', url: '/assets/zombie-kit/Environment/glTF/FireHydrant.gltf', type: 'gltf', targetHeight: 0.85 },
  { key: 'prop_trashbag', url: '/assets/zombie-kit/Environment/glTF/TrashBag_1.gltf', type: 'gltf', targetHeight: 0.65 },
  { key: 'prop_trashbag2', url: '/assets/zombie-kit/Environment/glTF/TrashBag_2.gltf', type: 'gltf', targetHeight: 0.55 },
  { key: 'prop_wheels', url: '/assets/zombie-kit/Environment/glTF/Wheels_Stack.gltf', type: 'gltf', targetHeight: 1.1 },
  { key: 'prop_cinder', url: '/assets/zombie-kit/Environment/glTF/CinderBlock.gltf', type: 'gltf', targetHeight: 0.3 },
  { key: 'prop_couch', url: '/assets/zombie-kit/Environment/glTF/Couch.gltf', type: 'gltf', targetHeight: 1.0 },
  { key: 'prop_blood1', url: '/assets/zombie-kit/Environment/glTF/Blood_1.gltf', type: 'gltf' },
  { key: 'prop_blood2', url: '/assets/zombie-kit/Environment/glTF/Blood_2.gltf', type: 'gltf' },
  { key: 'prop_blood3', url: '/assets/zombie-kit/Environment/glTF/Blood_3.gltf', type: 'gltf' },
  { key: 'veh_truck_armored', url: '/assets/zombie-kit/Vehicles/glTF/Vehicle_Truck_Armored.gltf', type: 'gltf' },
  { key: 'veh_truck', url: '/assets/zombie-kit/Vehicles/glTF/Vehicle_Truck.gltf', type: 'gltf' },
  { key: 'veh_pickup', url: '/assets/zombie-kit/Vehicles/glTF/Vehicle_Pickup.gltf', type: 'gltf' },
  { key: 'veh_sports', url: '/assets/zombie-kit/Vehicles/glTF/Vehicle_Sports.gltf', type: 'gltf' },

  // 2. Animated Zombie Pack (FBX)
  { key: 'zombie_animated_tex', url: '/assets/animated-zombie/ZombieTexture.png', type: 'texture' },
  { key: 'zombie_animated', url: '/assets/animated-zombie/ZombieSmooth.fbx', type: 'fbx', targetHeight: 1.85, textureOverride: 'zombie_animated_tex' },

  // 3. Downtown City MegaKit — full buildings (native metre scale) + tiling surface textures
  { key: 'bld_large', url: '/assets/downtown-city/Building_Large_2.gltf', type: 'gltf' },
  { key: 'bld_medium', url: '/assets/downtown-city/Building_Medium_2_001.gltf', type: 'gltf' },
  { key: 'bld_small', url: '/assets/downtown-city/Building_Small_1.gltf', type: 'gltf' },
  { key: 'prop_ac', url: '/assets/downtown-city/Prop_ACUnit.gltf', type: 'gltf', targetHeight: 1.0 },
  { key: 'tex_asphalt', url: '/assets/downtown-city/T_Concrete_Asphalt_BaseColor.png', type: 'texture', repeat: true },
  { key: 'tex_concrete', url: '/assets/downtown-city/T_Concrete_BaseColor.png', type: 'texture', repeat: true },
  { key: 'tex_concrete_n', url: '/assets/downtown-city/T_Concrete_Normal.png', type: 'texture', repeat: true, linear: true },
  { key: 'tex_brick', url: '/assets/downtown-city/T_RedBrick_BaseColor.png', type: 'texture', repeat: true },
  { key: 'tex_brick_n', url: '/assets/downtown-city/T_RedBrick_Normal.png', type: 'texture', repeat: true, linear: true },
  { key: 'tex_dirt', url: '/assets/downtown-city/T_Dirt_BaseColor.png', type: 'texture', repeat: true },
  { key: 'tex_metal', url: '/assets/downtown-city/T_MetalConcrete_BaseColor.png', type: 'texture', repeat: true },
  { key: 'tex_marble', url: '/assets/downtown-city/T_MarbleFloor_BaseColor.png', type: 'texture', repeat: true },

  // 4. Modular Streets Pack
  { key: 'street_light_single', url: '/assets/modular-streets/Streetlight_Single.fbx', type: 'fbx', targetHeight: 5.5 },

  // 5. Public Transport Pack (untextured — recoloured by material name)
  { key: 'veh_bus', url: '/assets/public-transport/Bus.fbx', type: 'fbx', targetHeight: 3.1, palette: BUS_PALETTE },
  { key: 'veh_schoolbus', url: '/assets/public-transport/SchoolBus.fbx', type: 'fbx', targetHeight: 3.0, palette: SCHOOLBUS_PALETTE },
  { key: 'veh_ambulance', url: '/assets/public-transport/Ambulance.fbx', type: 'fbx', targetHeight: 2.35, palette: AMBULANCE_PALETTE },

  // 6. Ultimate House Interior Pack
  { key: 'int_bed', url: '/assets/house-interior/Bed_Single.fbx', type: 'fbx', targetHeight: 0.85 },
  { key: 'int_bookshelf', url: '/assets/house-interior/Bookshelf.fbx', type: 'fbx', targetHeight: 2.1 },
  { key: 'int_shelf', url: '/assets/house-interior/Shelf_1.fbx', type: 'fbx', targetHeight: 1.9 },
  { key: 'int_chair', url: '/assets/house-interior/Chair_1.fbx', type: 'fbx', targetHeight: 0.95 },

  // 7. Survival Pack
  { key: 'surv_bonfire', url: '/assets/survival-pack/Bonfire.fbx', type: 'fbx', targetHeight: 0.65 },
  { key: 'surv_gascan', url: '/assets/survival-pack/GasCan.fbx', type: 'fbx', targetHeight: 0.55 },
  { key: 'surv_radio', url: '/assets/survival-pack/Radio.fbx', type: 'fbx', targetHeight: 0.45 },
  { key: 'surv_tent', url: '/assets/survival-pack/Tent.fbx', type: 'fbx', targetHeight: 1.9 },
  { key: 'surv_trashcan', url: '/assets/survival-pack/Trashcan.fbx', type: 'fbx', targetHeight: 1.0 },
  { key: 'surv_propane', url: '/assets/survival-pack/PropaneTank.fbx', type: 'fbx', targetHeight: 0.9 },

  // 10. Ultimate Stylized Nature Pack
  { key: 'nat_deadtree', url: '/assets/nature-pack/DeadTree_1.gltf', type: 'gltf', targetHeight: 5.5 },
  { key: 'nat_deadtree2', url: '/assets/nature-pack/DeadTree_3.gltf', type: 'gltf', targetHeight: 4.8 },
  { key: 'nat_deadtree3', url: '/assets/nature-pack/DeadTree_6.gltf', type: 'gltf', targetHeight: 4.2 },
  { key: 'nat_bush_large', url: '/assets/nature-pack/Bush_Large.gltf', type: 'gltf', targetHeight: 1.85 },
  { key: 'nat_bush_small', url: '/assets/nature-pack/Bush_Small.gltf', type: 'gltf', targetHeight: 0.8 },
  { key: 'nat_grass', url: '/assets/nature-pack/Grass_Large.gltf', type: 'gltf', targetHeight: 0.6 },

  // 11. Brackeys VFX Textures
  { key: 'vfx_flare', url: '/assets/vfx/flare_01_a.png', type: 'texture' },
  { key: 'vfx_fire', url: '/assets/vfx/fire_01_a.png', type: 'texture' },
  { key: 'vfx_flame', url: '/assets/vfx/flame_01_a.png', type: 'texture' },
  { key: 'vfx_dirt', url: '/assets/vfx/dirt_01_a.png', type: 'texture' },
  { key: 'vfx_spark', url: '/assets/vfx/spark_01_a.png', type: 'texture' },
  { key: 'vfx_smoke', url: '/assets/vfx/smoke_01_a.png', type: 'texture' },

  // 12. 800-game-sound-effects (SFX)
  { key: 'ui_click', url: '/assets/sfx/btn_48kHz_16bit_0.31s_01_s01.wav', type: 'audio' },
  { key: 'ui_back', url: '/assets/sfx/back_48kHz_16bit_0.06s_01_s13.wav', type: 'audio' },
  { key: 'ui_alert', url: '/assets/sfx/alert_48kHz_16bit_0.31s_01_s29.wav', type: 'audio' },
  { key: 'step_concrete1', url: '/assets/sfx/concrete_48kHz_16bit_0.11s_01_s12.wav', type: 'audio' },
  { key: 'step_concrete2', url: '/assets/sfx/concrete_48kHz_16bit_0.11s_02_s12.wav', type: 'audio' },
  { key: 'melee_swing', url: '/assets/sfx/blade_03_48kHz_16bit_0.33s_01_s56.wav', type: 'audio' },
  { key: 'melee_hit', url: '/assets/sfx/hit29_mp3_48kHz_16bit_0.53s_01_s66.wav', type: 'audio' },
  { key: 'gun_pistol', url: '/assets/sfx/gunshot_48kHz_16bit_0.16s_01_s30.wav', type: 'audio' },
  { key: 'gun_shotgun', url: '/assets/sfx/shotgun_48kHz_16bit_0.37s_01_s30.wav', type: 'audio' },
  { key: 'gun_smg', url: '/assets/sfx/sfx_weapon_singleshot3_48kHz_16bit_0.19s_01_s30.wav', type: 'audio' },
  { key: 'gun_rifle', url: '/assets/sfx/gun_48kHz_16bit_0.74s_01_s29.wav', type: 'audio' },
  { key: 'reload', url: '/assets/sfx/reload_48kHz_16bit_0.49s_01_s29.wav', type: 'audio' },
  { key: 'loot_pickup', url: '/assets/sfx/ammo_48kHz_16bit_0.25s_01_s29.wav', type: 'audio' },
  { key: 'explosion', url: '/assets/sfx/explosion_48kHz_16bit_0.59s_01_s29.wav', type: 'audio' },
  { key: 'zombie_groan1', url: '/assets/sfx/zombie_48kHz_16bit_0.66s_01_s36.wav', type: 'audio' },
  { key: 'zombie_groan2', url: '/assets/sfx/zombie_48kHz_16bit_0.49s_02_s36.wav', type: 'audio' },
  { key: 'zombie_groan3', url: '/assets/sfx/zombie_48kHz_16bit_0.77s_03_s36.wav', type: 'audio' },
  { key: 'zombie_roar', url: '/assets/sfx/roar_48kHz_16bit_0.64s_01_s56.wav', type: 'audio' },
  { key: 'dog_bark', url: '/assets/sfx/barking_02_48kHz_16bit_0.33s_01_s57.wav', type: 'audio' },
  { key: 'wood_break', url: '/assets/sfx/bfh1_breaking_03_48kHz_16bit_0.46s_01_s63.wav', type: 'audio' },
  { key: 'door_open', url: '/assets/sfx/door_08_48kHz_16bit_0.74s_01_s07.wav', type: 'audio' },
  { key: 'drink_sfx', url: '/assets/sfx/bottle_48kHz_16bit_0.43s_01_s35.wav', type: 'audio' },
  { key: 'heal_sfx', url: '/assets/sfx/bottle_pills_shake_48kHz_16bit_0.27s_01_s32.wav', type: 'audio' },
];

export class AssetManager {
  private gltfLoader = new GLTFLoader();
  private fbxLoader = new FBXLoader();
  private textureLoader = new THREE.TextureLoader();
  private audioLoader = new THREE.AudioLoader();

  private models = new Map<string, THREE.Group>();
  private skinned = new Set<string>();
  private clips = new Map<string, THREE.AnimationClip[]>();
  private textures = new Map<string, THREE.Texture>();
  private audioBuffers = new Map<string, AudioBuffer>();

  public async preloadAll(
    onProgress?: (loaded: number, total: number, currentLabel: string) => void
  ): Promise<void> {
    const total = ASSET_MANIFEST.length;
    let loaded = 0;

    // Load textures first so textureOverride works
    const textureEntries = ASSET_MANIFEST.filter((e) => e.type === 'texture');
    const otherEntries = ASSET_MANIFEST.filter((e) => e.type !== 'texture');

    const loadOne = async (entry: AssetEntry) => {
      try {
        if (entry.type === 'texture') {
          const tex = await this.textureLoader.loadAsync(entry.url);
          tex.colorSpace = entry.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
          if (entry.repeat) {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = 8;
          }
          this.textures.set(entry.key, tex);
        } else if (entry.type === 'audio') {
          const buf = await this.audioLoader.loadAsync(entry.url);
          this.audioBuffers.set(entry.key, buf);
        } else if (entry.type === 'gltf') {
          const gltf = await this.gltfLoader.loadAsync(entry.url);
          this.registerModel(entry, gltf.scene, gltf.animations);
        } else if (entry.type === 'fbx') {
          const fbx = await this.fbxLoader.loadAsync(entry.url);
          if (entry.textureOverride) {
            const overrideTex = this.textures.get(entry.textureOverride);
            if (overrideTex) {
              fbx.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                  (child as THREE.Mesh).material = new THREE.MeshStandardMaterial({
                    map: overrideTex,
                    roughness: 0.75,
                    metalness: 0.1,
                  });
                }
              });
            }
          }
          this.registerModel(entry, fbx, fbx.animations);
        }
      } catch (err) {
        console.warn(`[AssetManager] Failed to load "${entry.key}" (${entry.url}):`, err);
        if (entry.type === 'gltf' || entry.type === 'fbx') {
          this.models.set(entry.key, this.createFallbackModel(entry.targetHeight ?? 1));
        }
      } finally {
        loaded++;
        onProgress?.(loaded, total, entry.key);
      }
    };

    // Load textures in parallel
    await Promise.all(textureEntries.map(loadOne));

    // Load remaining assets in batches for fast, reliable browser loading
    const batchSize = 8;
    for (let i = 0; i < otherEntries.length; i += batchSize) {
      const batch = otherEntries.slice(i, i + batchSize);
      await Promise.all(batch.map(loadOne));
    }
  }

  private registerModel(entry: AssetEntry, root: THREE.Object3D, animations: THREE.AnimationClip[]): void {
    const normalized = this.normalizeModel(root, entry.targetHeight, entry.centerGround ?? true, entry.palette);
    this.models.set(entry.key, normalized);
    let hasSkinned = false;
    normalized.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkinned = true;
    });
    if (hasSkinned) this.skinned.add(entry.key);
    if (animations && animations.length > 0) {
      this.clips.set(entry.key, animations);
    }
  }

  private normalizeModel(
    root: THREE.Object3D,
    targetHeight?: number,
    centerGround = true,
    palette?: Record<string, number>
  ): THREE.Group {
    const wrapper = new THREE.Group();
    root.updateMatrixWorld(true);

    // Enable shadows and convert legacy FBX Phong/Lambert materials to PBR so every
    // prop responds to the same lighting, fog and tone-mapping as the glTF assets.
    root.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (!mesh.material) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => this.toStandard(m, palette))
        : this.toStandard(mesh.material, palette);
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);

    if (targetHeight && size.y > 0.0001) {
      const scale = targetHeight / size.y;
      root.scale.multiplyScalar(scale);
      root.updateMatrixWorld(true);
    }

    if (centerGround) {
      const scaledBox = new THREE.Box3().setFromObject(root);
      const center = new THREE.Vector3();
      scaledBox.getCenter(center);
      root.position.x -= center.x;
      root.position.z -= center.z;
      root.position.y -= scaledBox.min.y;
    }

    wrapper.add(root);
    return wrapper;
  }

  private toStandard(mat: THREE.Material, palette?: Record<string, number>): THREE.Material {
    let std: THREE.MeshStandardMaterial;
    if (mat instanceof THREE.MeshStandardMaterial) {
      std = mat;
      std.roughness = Math.min(0.95, Math.max(0.35, std.roughness || 0.75));
      std.metalness = Math.min(0.4, std.metalness || 0.1);
    } else if (mat instanceof THREE.MeshPhongMaterial || mat instanceof THREE.MeshLambertMaterial) {
      std = new THREE.MeshStandardMaterial({
        name: mat.name,
        color: mat.color.clone(),
        map: mat.map ?? null,
        transparent: mat.transparent,
        opacity: mat.opacity,
        roughness: 0.78,
        metalness: 0.08,
      });
    } else {
      return mat;
    }

    if (palette) {
      const name = (std.name || '').toLowerCase();
      const key = Object.keys(palette).find((k) => k !== '*' && name.includes(k));
      const hex = key ? palette[key] : palette['*'];
      if (hex !== undefined) std.color.setHex(hex);
      if (key === 'light') {
        std.emissive.setHex(0xffe6a3);
        std.emissiveIntensity = 0.5;
      } else if (key === 'window' || key === 'glass') {
        std.roughness = 0.18;
        std.metalness = 0.55;
      }
    }
    return std;
  }

  private createFallbackModel(height: number): THREE.Group {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(height * 0.5, height, height * 0.5);
    const mat = new THREE.MeshStandardMaterial({ color: 0x52525b, roughness: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = height * 0.5;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return g;
  }

  public hasModel(key: string): boolean {
    return this.models.has(key);
  }

  public cloneModel(key: string): THREE.Group {
    const src = this.models.get(key);
    if (!src) {
      console.warn(`[AssetManager] Missing model key "${key}", returning fallback.`);
      return this.createFallbackModel(1.0);
    }
    if (this.skinned.has(key)) {
      return SkeletonUtils.clone(src) as THREE.Group;
    }
    return src.clone(true);
  }

  public getClips(key: string): THREE.AnimationClip[] {
    return this.clips.get(key) ?? [];
  }

  public getTexture(key: string): THREE.Texture | undefined {
    return this.textures.get(key);
  }

  public getAudioBuffer(key: string): AudioBuffer | undefined {
    return this.audioBuffers.get(key);
  }
}
