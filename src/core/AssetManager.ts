import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Every 3D model comes from the Zombie Apocalypse Kit (Quaternius, CC0), used at its native scale
 * so characters, vehicles, props and 8 m street tiles all match. Surfaces the kit doesn't provide
 * (walls, ground) are generated procedurally in ProceduralTextures.ts. Other packs are used only
 * through scripts/prepare_assets.py, which ships small, normalised copies: sounds (OGG), particle
 * sprites (256 px) and a handful of nature models with downscaled textures.
 */
export interface AssetEntry {
  key: string;
  url: string;
  type: 'gltf' | 'audio' | 'texture';
  /** Re-centre X/Z on the origin and drop the lowest point to y = 0. */
  centerGround?: boolean;
}

const KIT = '/assets/zombie-kit';
const C = (name: string) => `${KIT}/Characters/glTF/${name}.gltf`;
const E = (name: string) => `${KIT}/Environment/glTF/${name}.gltf`;
const V = (name: string) => `${KIT}/Vehicles/glTF/${name}.gltf`;

const SFX_KEYS = [
  'ui_click',
  'ui_back',
  'ui_alert',
  'ui_hover',
  'ui_confirm',
  'ui_open',
  'ui_close',
  'ui_error',
  'ui_powerup',
  'ui_game_over',
  'ui_complete',
  'step_concrete1',
  'step_concrete2',
  'step_concrete3',
  'step_concrete4',
  'step_grass1',
  'step_grass2',
  'step_grass3',
  'step_wood1',
  'step_wood2',
  'step_wood3',
  'step_wood4',
  'step_heavy',
  'gear_rustle',
  'gun_pistol',
  'gun_pistol2',
  'gun_smg',
  'gun_smg2',
  'gun_rifle',
  'gun_rifle2',
  'gun_sniper',
  'gun_shotgun',
  'gun_shotgun2',
  'gun_shotgun3',
  'gun_empty',
  'reload',
  'reload_mag',
  'ammo_pickup',
  'casing1',
  'casing2',
  'casing3',
  'melee_swing',
  'melee_swing2',
  'melee_hit',
  'melee_hit_heavy',
  'impact_flesh1',
  'impact_flesh2',
  'impact_metal',
  'impact_metal2',
  'impact_concrete',
  'impact_concrete2',
  'impact_wood',
  'impact_glass',
  'wood_break',
  'wood_hit',
  'debris_fall',
  'explosion',
  'explosion_low',
  'explosion_distant',
  'zombie_groan1',
  'zombie_groan2',
  'zombie_groan3',
  'zombie_hurt1',
  'zombie_hurt2',
  'zombie_hurt3',
  'zombie_death',
  'zombie_shriek1',
  'zombie_shriek2',
  'zombie_aggro',
  'zombie_breath',
  'zombie_bite',
  'zombie_roar',
  'brute_roar',
  'brute_grunt1',
  'brute_grunt2',
  'brute_hurt',
  'player_hurt1',
  'player_gasp',
  'heartbeat',
  'scream_distant',
  'dog_bark',
  'loot_pickup',
  'crate_open',
  'crate_creak',
  'door_open',
  'objective_pickup',
  'drink_sfx',
  'eat_sfx',
  'heal_sfx',
  'hammer',
  'switch',
  'thunder',
  'raven',
  'loop_wind',
  'loop_rain',
  'loop_fire',
  'loop_crickets',
  'loop_eerie',
  'loop_car_alarm',
  'loop_engine',
  'loop_record',
];

const VOICE_KEYS = [
  'reyes_01',
  'reyes_02',
  'reyes_03',
  'reyes_04',
  'reyes_05',
  'reyes_06',
  'reyes_07',
  'reyes_08',
  'reyes_09',
  'reyes_10',
  'reyes_11',
  'reyes_12',
  'reyes_13',
  'reyes_14',
  'reyes_15',
  'reyes_16',
  'reyes_17',
  'reyes_18',
  'reyes_callout_headshot',
  'reyes_callout_limb',
  'reyes_callout_lowhp',
  'reyes_callout_dog',
];

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

  // Blender-sliced severed zombie body parts & bloody bone stumps (centerGround omitted so COM stays centered for tumbling)
  { key: 'gib_head', url: '/assets/gibs/gib_head.glb', type: 'gltf' },
  { key: 'gib_brute_head', url: '/assets/gibs/gib_brute_head.glb', type: 'gltf' },
  { key: 'gib_arm_l', url: '/assets/gibs/gib_arm_l.glb', type: 'gltf' },
  { key: 'gib_arm_r', url: '/assets/gibs/gib_arm_r.glb', type: 'gltf' },
  { key: 'gib_leg_l', url: '/assets/gibs/gib_leg_l.glb', type: 'gltf' },
  { key: 'gib_leg_r', url: '/assets/gibs/gib_leg_r.glb', type: 'gltf' },
  { key: 'gib_chunk', url: '/assets/gibs/gib_chunk.glb', type: 'gltf' },
  { key: 'gib_stump', url: '/assets/gibs/gib_stump.glb', type: 'gltf' },

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

  // Stylized Nature Pack (via scripts/prepare_assets.py)
  { key: 'nat_deadtree_1', url: '/assets/nature/DeadTree_1.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_deadtree_2', url: '/assets/nature/DeadTree_2.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_deadtree_3', url: '/assets/nature/DeadTree_3.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_deadtree_6', url: '/assets/nature/DeadTree_6.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_deadtree_8', url: '/assets/nature/DeadTree_8.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_deadtree_10', url: '/assets/nature/DeadTree_10.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_bush_small', url: '/assets/nature/Bush_Small.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_bush', url: '/assets/nature/Bush.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_grass_large', url: '/assets/nature/Grass_Large.gltf', type: 'gltf', centerGround: true },
  { key: 'nat_grass_small', url: '/assets/nature/Grass_Small.gltf', type: 'gltf', centerGround: true },

  // Brackeys particle sprites (via scripts/prepare_assets.py)
  { key: 'vfx_muzzle_01', url: '/assets/vfx/muzzle_01.png', type: 'texture' },
  { key: 'vfx_muzzle_02', url: '/assets/vfx/muzzle_02.png', type: 'texture' },
  { key: 'vfx_muzzle_04', url: '/assets/vfx/muzzle_04.png', type: 'texture' },
  { key: 'vfx_flame_02', url: '/assets/vfx/flame_02.png', type: 'texture' },
  { key: 'vfx_flame_03', url: '/assets/vfx/flame_03.png', type: 'texture' },
  { key: 'vfx_flame_05', url: '/assets/vfx/flame_05.png', type: 'texture' },
  { key: 'vfx_fire_01', url: '/assets/vfx/fire_01.png', type: 'texture' },
  { key: 'vfx_smoke_01', url: '/assets/vfx/smoke_01.png', type: 'texture' },
  { key: 'vfx_smoke_04', url: '/assets/vfx/smoke_04.png', type: 'texture' },
  { key: 'vfx_smoke_07', url: '/assets/vfx/smoke_07.png', type: 'texture' },
  { key: 'vfx_spark_01', url: '/assets/vfx/spark_01.png', type: 'texture' },
  { key: 'vfx_spark_04', url: '/assets/vfx/spark_04.png', type: 'texture' },
  { key: 'vfx_scorch_01', url: '/assets/vfx/scorch_01.png', type: 'texture' },
  { key: 'vfx_scorch_02', url: '/assets/vfx/scorch_02.png', type: 'texture' },
  { key: 'vfx_dirt_01', url: '/assets/vfx/dirt_01.png', type: 'texture' },
  { key: 'vfx_dirt_03', url: '/assets/vfx/dirt_03.png', type: 'texture' },
  { key: 'vfx_light_01', url: '/assets/vfx/light_01.png', type: 'texture' },
  { key: 'vfx_light_02', url: '/assets/vfx/light_02.png', type: 'texture' },
  { key: 'vfx_circle_05', url: '/assets/vfx/circle_05.png', type: 'texture' },
  { key: 'vfx_trace_01', url: '/assets/vfx/trace_01.png', type: 'texture' },
  { key: 'vfx_star_06', url: '/assets/vfx/star_06.png', type: 'texture' },

  // Sound effects: 800-game-sound-effects, normalised OGG (via scripts/prepare_assets.py)
  ...SFX_KEYS.map((key): AssetEntry => ({ key, url: `/assets/sfx/${key}.ogg`, type: 'audio' })),

  // Captain Reyes studio-mastered Kokoro-82M radio voiceovers (via scripts/generate_kokoro_voices.py)
  ...VOICE_KEYS.map((key): AssetEntry => ({ key: `voice_${key}`, url: `/assets/voice/${key}.ogg`, type: 'audio' })),
];

export class AssetManager {
  private gltfLoader = new GLTFLoader();
  private audioLoader = new THREE.AudioLoader();
  private textureLoader = new THREE.TextureLoader();
  private textures = new Map<string, THREE.Texture>();

  private models = new Map<string, THREE.Group>();
  private skinned = new Set<string>();
  private clips = new Map<string, THREE.AnimationClip[]>();
  private audioBuffers = new Map<string, AudioBuffer>();
  public isLoaded = false;

  public async preloadAll(onProgress?: (loaded: number, total: number, currentLabel: string) => void): Promise<void> {
    const total = ASSET_MANIFEST.length;
    if (this.isLoaded) {
      onProgress?.(total, total, 'ready');
      return;
    }
    let loaded = 0;

    const loadOne = async (entry: AssetEntry) => {
      try {
        if (entry.type === 'audio') {
          this.audioBuffers.set(entry.key, await this.audioLoader.loadAsync(entry.url));
        } else if (entry.type === 'texture') {
          const tex = await this.textureLoader.loadAsync(entry.url);
          tex.colorSpace = THREE.SRGBColorSpace;
          this.textures.set(entry.key, tex);
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
    this.isLoaded = true;
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
          // Preserve glossy wet blood & flesh specular highlights on Blender gore meshes
          if (!/WetGore|DarkBlood/i.test(m.name)) {
            m.roughness = Math.max(0.55, m.roughness);
            m.metalness = Math.min(0.2, m.metalness);
          }
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

  public getTexture(key: string): THREE.Texture | undefined {
    return this.textures.get(key);
  }

  public hasAudio(key: string): boolean {
    return this.audioBuffers.has(key);
  }

  public getAudioBuffer(key: string): AudioBuffer | undefined {
    return this.audioBuffers.get(key);
  }
}
