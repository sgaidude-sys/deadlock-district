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
}

export const ASSET_MANIFEST: AssetEntry[] = [
  // 1. Zombie Apocalypse Kit — Survivors, Dog, Zombies, Props, Barricades
  { key: 'survivor_matt', url: '/assets/zombie-kit/Characters/glTF/Characters_Matt.gltf', type: 'gltf', targetHeight: 1.82, centerGround: true },
  { key: 'survivor_lis', url: '/assets/zombie-kit/Characters/glTF/Characters_Lis.gltf', type: 'gltf', targetHeight: 1.76, centerGround: true },
  { key: 'survivor_sam', url: '/assets/zombie-kit/Characters/glTF/Characters_Sam.gltf', type: 'gltf', targetHeight: 1.82, centerGround: true },
  { key: 'survivor_shaun', url: '/assets/zombie-kit/Characters/glTF/Characters_Shaun.gltf', type: 'gltf', targetHeight: 1.82, centerGround: true },
  { key: 'dog_shepherd', url: '/assets/zombie-kit/Characters/glTF/Characters_GermanShepherd.gltf', type: 'gltf', targetHeight: 0.78, centerGround: true },
  { key: 'zombie_basic', url: '/assets/zombie-kit/Characters/glTF/Zombie_Basic.gltf', type: 'gltf', targetHeight: 1.82, centerGround: true },
  { key: 'zombie_chubby', url: '/assets/zombie-kit/Characters/glTF/Zombie_Chubby.gltf', type: 'gltf', targetHeight: 2.15, centerGround: true },
  { key: 'zombie_ribcage', url: '/assets/zombie-kit/Characters/glTF/Zombie_Ribcage.gltf', type: 'gltf', targetHeight: 1.75, centerGround: true },

  // Zombie Kit Environment & Weapons
  { key: 'prop_barrel', url: '/assets/zombie-kit/Environment/glTF/Barrel.gltf', type: 'gltf', targetHeight: 1.05, centerGround: true },
  { key: 'prop_chest', url: '/assets/zombie-kit/Environment/glTF/Chest.gltf', type: 'gltf', targetHeight: 0.75, centerGround: true },
  { key: 'prop_chest_special', url: '/assets/zombie-kit/Environment/glTF/Chest_Special.gltf', type: 'gltf', targetHeight: 0.85, centerGround: true },
  { key: 'prop_container_green', url: '/assets/zombie-kit/Environment/glTF/Container_Green.gltf', type: 'gltf', targetHeight: 2.7, centerGround: true },
  { key: 'prop_container_red', url: '/assets/zombie-kit/Environment/glTF/Container_Red.gltf', type: 'gltf', targetHeight: 2.7, centerGround: true },
  { key: 'prop_pallet', url: '/assets/zombie-kit/Environment/glTF/Pallet.gltf', type: 'gltf', targetHeight: 1.25, centerGround: true },
  { key: 'prop_barrier', url: '/assets/zombie-kit/Environment/glTF/TrafficBarrier_1.gltf', type: 'gltf', targetHeight: 1.1, centerGround: true },
  { key: 'prop_plastic_barrier', url: '/assets/zombie-kit/Environment/glTF/PlasticBarrier.gltf', type: 'gltf', targetHeight: 1.0, centerGround: true },
  { key: 'prop_cone', url: '/assets/zombie-kit/Environment/glTF/TrafficCone_1.gltf', type: 'gltf', targetHeight: 0.7, centerGround: true },
  { key: 'prop_hydrant', url: '/assets/zombie-kit/Environment/glTF/FireHydrant.gltf', type: 'gltf', targetHeight: 0.85, centerGround: true },
  { key: 'prop_trashbag', url: '/assets/zombie-kit/Environment/glTF/TrashBag_1.gltf', type: 'gltf', targetHeight: 0.65, centerGround: true },
  { key: 'prop_blood', url: '/assets/zombie-kit/Environment/glTF/Blood_1.gltf', type: 'gltf', targetHeight: 0.05, centerGround: true },
  { key: 'weapon_axe', url: '/assets/zombie-kit/Weapons/glTF/Axe.gltf', type: 'gltf', targetHeight: 0.75, centerGround: false },

  // 2. Animated Zombie Pack (FBX)
  { key: 'zombie_animated_tex', url: '/assets/animated-zombie/ZombieTexture.png', type: 'texture' },
  { key: 'zombie_animated', url: '/assets/animated-zombie/ZombieSmooth.fbx', type: 'fbx', targetHeight: 1.85, centerGround: true, textureOverride: 'zombie_animated_tex' },

  // 3. Downtown City MegaKit (Modular Urban Facades)
  { key: 'city_brick_wall', url: '/assets/downtown-city/Brick_Inset_Window.gltf', type: 'gltf', targetHeight: 3.6, centerGround: true },
  { key: 'city_brick_plain', url: '/assets/downtown-city/Brick_Corner_Plain.gltf', type: 'gltf', targetHeight: 3.6, centerGround: true },

  // 4. Modular Streets Pack
  { key: 'street_light_single', url: '/assets/modular-streets/Streetlight_Single.fbx', type: 'fbx', targetHeight: 5.5, centerGround: true },
  { key: 'street_light_double', url: '/assets/modular-streets/Streetlight_Double.fbx', type: 'fbx', targetHeight: 5.5, centerGround: true },
  { key: 'sign_stop', url: '/assets/modular-streets/Sign_Stop.fbx', type: 'fbx', targetHeight: 2.6, centerGround: true },

  // 5. Public Transport Pack
  { key: 'veh_bus', url: '/assets/public-transport/Bus.fbx', type: 'fbx', targetHeight: 3.1, centerGround: true },
  { key: 'veh_schoolbus', url: '/assets/public-transport/SchoolBus.fbx', type: 'fbx', targetHeight: 3.0, centerGround: true },
  { key: 'veh_taxi', url: '/assets/public-transport/Taxi.fbx', type: 'fbx', targetHeight: 1.55, centerGround: true },
  { key: 'veh_ambulance', url: '/assets/public-transport/Ambulance.fbx', type: 'fbx', targetHeight: 2.35, centerGround: true },

  // 6. Ultimate House Interior Pack
  { key: 'int_bed', url: '/assets/house-interior/Bed_Single.fbx', type: 'fbx', targetHeight: 0.85, centerGround: true },
  { key: 'int_bookshelf', url: '/assets/house-interior/Bookshelf.fbx', type: 'fbx', targetHeight: 2.1, centerGround: true },
  { key: 'int_chair', url: '/assets/house-interior/Chair_1.fbx', type: 'fbx', targetHeight: 0.95, centerGround: true },
  { key: 'int_couch', url: '/assets/house-interior/Couch_1.fbx', type: 'fbx', targetHeight: 0.95, centerGround: true },
  { key: 'int_table', url: '/assets/house-interior/Table_1.fbx', type: 'fbx', targetHeight: 0.82, centerGround: true },
  { key: 'int_counter', url: '/assets/house-interior/Counter_1.fbx', type: 'fbx', targetHeight: 1.0, centerGround: true },
  { key: 'int_fridge', url: '/assets/house-interior/Fridge.fbx', type: 'fbx', targetHeight: 2.0, centerGround: true },

  // 7. Survival Pack
  { key: 'surv_bonfire', url: '/assets/survival-pack/Bonfire.fbx', type: 'fbx', targetHeight: 0.65, centerGround: true },
  { key: 'surv_gascan', url: '/assets/survival-pack/GasCan.fbx', type: 'fbx', targetHeight: 0.55, centerGround: true },
  { key: 'surv_radio', url: '/assets/survival-pack/Radio.fbx', type: 'fbx', targetHeight: 0.45, centerGround: true },
  { key: 'surv_tent', url: '/assets/survival-pack/Tent.fbx', type: 'fbx', targetHeight: 1.9, centerGround: true },
  { key: 'surv_medkit', url: '/assets/survival-pack/FirstAidKit_Hard.fbx', type: 'fbx', targetHeight: 0.35, centerGround: true },
  { key: 'surv_backpack', url: '/assets/survival-pack/Backpack.fbx', type: 'fbx', targetHeight: 0.6, centerGround: true },

  // 8. Ultimate Food Pack
  { key: 'food_apple', url: '/assets/food-pack/Apple.fbx', type: 'fbx', targetHeight: 0.22, centerGround: true },
  { key: 'food_bottle', url: '/assets/food-pack/Bottle1.fbx', type: 'fbx', targetHeight: 0.32, centerGround: true },
  { key: 'food_burger', url: '/assets/food-pack/Burger.fbx', type: 'fbx', targetHeight: 0.22, centerGround: true },

  // 9. Ultimate Guns Pack
  { key: 'gun_pistol', url: '/assets/guns-pack/Pistol_1.fbx', type: 'fbx', targetHeight: 0.22, centerGround: false },
  { key: 'gun_shotgun', url: '/assets/guns-pack/Shotgun_1.fbx', type: 'fbx', targetHeight: 0.26, centerGround: false },
  { key: 'gun_smg', url: '/assets/guns-pack/SubmachineGun_1.fbx', type: 'fbx', targetHeight: 0.26, centerGround: false },
  { key: 'gun_rifle', url: '/assets/guns-pack/AssaultRifle_1.fbx', type: 'fbx', targetHeight: 0.28, centerGround: false },
  { key: 'gun_sniper', url: '/assets/guns-pack/SniperRifle_1.fbx', type: 'fbx', targetHeight: 0.30, centerGround: false },

  // 10. Ultimate Stylized Nature Pack
  { key: 'nat_deadtree', url: '/assets/nature-pack/DeadTree_1.gltf', type: 'gltf', targetHeight: 5.5, centerGround: true },
  { key: 'nat_deadtree2', url: '/assets/nature-pack/DeadTree_3.gltf', type: 'gltf', targetHeight: 4.8, centerGround: true },
  { key: 'nat_bush', url: '/assets/nature-pack/Bush.gltf', type: 'gltf', targetHeight: 1.25, centerGround: true },
  { key: 'nat_bush_large', url: '/assets/nature-pack/Bush_Large.gltf', type: 'gltf', targetHeight: 1.85, centerGround: true },
  { key: 'nat_rock', url: '/assets/nature-pack/Rock_1.gltf', type: 'gltf', targetHeight: 1.4, centerGround: true },

  // 11. Brackeys VFX Textures
  { key: 'vfx_flare', url: '/assets/vfx/flare_01_a.png', type: 'texture' },
  { key: 'vfx_fire', url: '/assets/vfx/fire_01_a.png', type: 'texture' },
  { key: 'vfx_flame', url: '/assets/vfx/flame_01_a.png', type: 'texture' },
  { key: 'vfx_circle', url: '/assets/vfx/circle_05_a.png', type: 'texture' },
  { key: 'vfx_dirt', url: '/assets/vfx/dirt_01_a.png', type: 'texture' },
  { key: 'vfx_spark', url: '/assets/vfx/spark_01_a.png', type: 'texture' },
  { key: 'vfx_smoke', url: '/assets/vfx/smoke_01_a.png', type: 'texture' },

  // 12. 800-game-sound-effects (SFX)
  { key: 'ui_click', url: '/assets/sfx/btn_48kHz_16bit_0.31s_01_s01.wav', type: 'audio' },
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
          tex.colorSpace = THREE.SRGBColorSpace;
          this.textures.set(entry.key, tex);
        } else if (entry.type === 'audio') {
          const buf = await this.audioLoader.loadAsync(entry.url);
          this.audioBuffers.set(entry.key, buf);
        } else if (entry.type === 'gltf') {
          const gltf = await this.gltfLoader.loadAsync(entry.url);
          const normalized = this.normalizeModel(
            gltf.scene,
            entry.targetHeight,
            entry.centerGround ?? true
          );
          this.models.set(entry.key, normalized);
          if (gltf.animations && gltf.animations.length > 0) {
            this.clips.set(entry.key, gltf.animations);
          }
        } else if (entry.type === 'fbx') {
          const fbx = await this.fbxLoader.loadAsync(entry.url);
          if (entry.textureOverride) {
            const overrideTex = this.textures.get(entry.textureOverride);
            if (overrideTex) {
              fbx.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                  const m = child as THREE.Mesh;
                  m.material = new THREE.MeshStandardMaterial({
                    map: overrideTex,
                    roughness: 0.75,
                    metalness: 0.1,
                  });
                }
              });
            }
          }
          const normalized = this.normalizeModel(
            fbx,
            entry.targetHeight,
            entry.centerGround ?? true
          );
          this.models.set(entry.key, normalized);
          if (fbx.animations && fbx.animations.length > 0) {
            this.clips.set(entry.key, fbx.animations);
          }
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

    // Load remaining assets in batches of 6 for fast, reliable browser loading
    const batchSize = 6;
    for (let i = 0; i < otherEntries.length; i += batchSize) {
      const batch = otherEntries.slice(i, i + batchSize);
      await Promise.all(batch.map(loadOne));
    }
  }

  private normalizeModel(
    root: THREE.Object3D,
    targetHeight?: number,
    centerGround = true
  ): THREE.Group {
    const wrapper = new THREE.Group();
    root.updateMatrixWorld(true);

    // Enable shadows and ensure materials render nicely
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((mat) => {
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.roughness = Math.min(0.95, Math.max(0.35, mat.roughness || 0.75));
              mat.metalness = Math.min(0.4, mat.metalness || 0.1);
            }
          });
        }
      }
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

  public cloneModel(key: string): THREE.Group {
    const src = this.models.get(key);
    if (!src) {
      console.warn(`[AssetManager] Missing model key "${key}", returning fallback.`);
      return this.createFallbackModel(1.0);
    }

    let hasSkinned = false;
    src.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkinned = true;
    });

    if (hasSkinned) {
      const cloned = SkeletonUtils.clone(src) as THREE.Group;
      return cloned;
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
