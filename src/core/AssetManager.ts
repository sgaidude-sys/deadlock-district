import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Every 3D model comes from the Zombie Apocalypse Kit (Quaternius, CC0), used at its native scale
 * so characters, vehicles, props and 8 m street tiles all match. Surfaces the kit doesn't provide
 * (walls, ground) are generated procedurally in ProceduralTextures.ts. Audio is the only other pack.
 */
export interface AssetEntry {
  key: string;
  url: string;
  type: 'gltf' | 'audio';
  /** Re-centre X/Z on the origin and drop the lowest point to y = 0. */
  centerGround?: boolean;
}

const KIT = '/assets/zombie-kit';
const C = (name: string) => `${KIT}/Characters/glTF/${name}.gltf`;
const E = (name: string) => `${KIT}/Environment/glTF/${name}.gltf`;
const V = (name: string) => `${KIT}/Vehicles/glTF/${name}.gltf`;

export const ASSET_MANIFEST: AssetEntry[] = [
  // Survivors & companion (rigs carry every weapon on the hand bone; feet already at y = 0)
  { key: 'survivor_matt', url: C('Characters_Matt'), type: 'gltf' },
  { key: 'survivor_lis', url: C('Characters_Lis'), type: 'gltf' },
  { key: 'survivor_sam', url: C('Characters_Sam'), type: 'gltf' },
  { key: 'survivor_shaun', url: C('Characters_Shaun'), type: 'gltf' },
  { key: 'dog_shepherd', url: C('Characters_GermanShepherd'), type: 'gltf' },

  // Zombies
  { key: 'zombie_basic', url: C('Zombie_Basic'), type: 'gltf' },
  { key: 'zombie_chubby', url: C('Zombie_Chubby'), type: 'gltf' },
  { key: 'zombie_arm', url: C('Zombie_Arm'), type: 'gltf' },
  { key: 'zombie_ribcage', url: C('Zombie_Ribcage'), type: 'gltf' },

  // Streets
  { key: 'street_straight', url: E('Street_Straight'), type: 'gltf' },
  { key: 'street_crack1', url: E('Street_Straight_Crack1'), type: 'gltf' },
  { key: 'street_4way', url: E('Street_4Way'), type: 'gltf' },
  { key: 'street_t', url: E('Street_T'), type: 'gltf' },
  { key: 'street_light', url: E('StreetLights'), type: 'gltf' },
  { key: 'traffic_light', url: E('TrafficLight_1'), type: 'gltf' },
  { key: 'town_sign', url: E('TownSign'), type: 'gltf' },
  { key: 'water_tower', url: E('WaterTower'), type: 'gltf' },

  // Props
  { key: 'prop_barrel', url: E('Barrel'), type: 'gltf', centerGround: true },
  { key: 'prop_chest', url: E('Chest'), type: 'gltf', centerGround: true },
  { key: 'prop_chest_special', url: E('Chest_Special'), type: 'gltf', centerGround: true },
  { key: 'prop_cinder', url: E('CinderBlock'), type: 'gltf', centerGround: true },
  { key: 'prop_container_green', url: E('Container_Green'), type: 'gltf', centerGround: true },
  { key: 'prop_container_red', url: E('Container_Red'), type: 'gltf', centerGround: true },
  { key: 'prop_couch', url: E('Couch'), type: 'gltf', centerGround: true },
  { key: 'prop_hydrant', url: E('FireHydrant'), type: 'gltf', centerGround: true },
  { key: 'prop_pallet', url: E('Pallet'), type: 'gltf', centerGround: true },
  { key: 'prop_pallet_broken', url: E('Pallet_Broken'), type: 'gltf', centerGround: true },
  { key: 'prop_pipes', url: E('Pipes'), type: 'gltf', centerGround: true },
  { key: 'prop_plastic_barrier', url: E('PlasticBarrier'), type: 'gltf', centerGround: true },
  { key: 'prop_barrier', url: E('TrafficBarrier_1'), type: 'gltf', centerGround: true },
  { key: 'prop_barrier2', url: E('TrafficBarrier_2'), type: 'gltf', centerGround: true },
  { key: 'prop_cone', url: E('TrafficCone_1'), type: 'gltf', centerGround: true },
  { key: 'prop_cone2', url: E('TrafficCone_2'), type: 'gltf', centerGround: true },
  { key: 'prop_trashbag', url: E('TrashBag_1'), type: 'gltf', centerGround: true },
  { key: 'prop_trashbag2', url: E('TrashBag_2'), type: 'gltf', centerGround: true },
  { key: 'prop_wheel', url: E('Wheel'), type: 'gltf', centerGround: true },
  { key: 'prop_wheels', url: E('Wheels_Stack'), type: 'gltf', centerGround: true },
  { key: 'prop_blood1', url: E('Blood_1'), type: 'gltf' },
  { key: 'prop_blood2', url: E('Blood_2'), type: 'gltf' },
  { key: 'prop_blood3', url: E('Blood_3'), type: 'gltf' },

  // Vehicles
  { key: 'veh_pickup', url: V('Vehicle_Pickup'), type: 'gltf' },
  { key: 'veh_pickup_armored', url: V('Vehicle_Pickup_Armored'), type: 'gltf' },
  { key: 'veh_sports', url: V('Vehicle_Sports'), type: 'gltf' },
  { key: 'veh_sports_armored', url: V('Vehicle_Sports_Armored'), type: 'gltf' },
  { key: 'veh_truck', url: V('Vehicle_Truck'), type: 'gltf' },
  { key: 'veh_truck_armored', url: V('Vehicle_Truck_Armored'), type: 'gltf' },

  // Audio (800-game-sound-effects)
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
  private audioLoader = new THREE.AudioLoader();

  private models = new Map<string, THREE.Group>();
  private skinned = new Set<string>();
  private clips = new Map<string, THREE.AnimationClip[]>();
  private audioBuffers = new Map<string, AudioBuffer>();

  public async preloadAll(onProgress?: (loaded: number, total: number, currentLabel: string) => void): Promise<void> {
    const total = ASSET_MANIFEST.length;
    let loaded = 0;

    const loadOne = async (entry: AssetEntry) => {
      try {
        if (entry.type === 'audio') {
          this.audioBuffers.set(entry.key, await this.audioLoader.loadAsync(entry.url));
        } else {
          const gltf = await this.gltfLoader.loadAsync(entry.url);
          this.registerModel(entry, gltf.scene, gltf.animations);
        }
      } catch (err) {
        console.warn(`[AssetManager] Failed to load "${entry.key}" (${entry.url}):`, err);
        if (entry.type === 'gltf') this.models.set(entry.key, this.createFallbackModel(1));
      } finally {
        loaded++;
        onProgress?.(loaded, total, entry.key);
      }
    };

    const batchSize = 8;
    for (let i = 0; i < ASSET_MANIFEST.length; i += batchSize) {
      await Promise.all(ASSET_MANIFEST.slice(i, i + batchSize).map(loadOne));
    }
  }

  private registerModel(entry: AssetEntry, root: THREE.Object3D, animations: THREE.AnimationClip[]): void {
    const wrapper = new THREE.Group();
    let hasSkinned = false;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) hasSkinned = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (m instanceof THREE.MeshStandardMaterial) {
          m.roughness = Math.max(0.55, m.roughness);
          m.metalness = Math.min(0.2, m.metalness);
        }
      }
    });

    if (entry.centerGround) {
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      root.position.x -= center.x;
      root.position.z -= center.z;
      root.position.y -= box.min.y;
    }

    wrapper.add(root);
    this.models.set(entry.key, wrapper);
    if (hasSkinned) this.skinned.add(entry.key);
    if (animations.length > 0) this.clips.set(entry.key, animations);
  }

  private createFallbackModel(height: number): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(height * 0.5, height, height * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x52525b, roughness: 0.8 })
    );
    mesh.position.y = height * 0.5;
    mesh.castShadow = true;
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
    return this.skinned.has(key) ? (SkeletonUtils.clone(src) as THREE.Group) : src.clone(true);
  }

  public getClips(key: string): THREE.AnimationClip[] {
    return this.clips.get(key) ?? [];
  }

  /** Kept for API compatibility; all surface textures are procedural now. */
  public getTexture(_key: string): THREE.Texture | undefined {
    return undefined;
  }

  public getAudioBuffer(key: string): AudioBuffer | undefined {
    return this.audioBuffers.get(key);
  }
}
