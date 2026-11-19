import * as THREE from 'three';

export type SurvivorId = 'matt' | 'lis' | 'sam' | 'shaun';

export type WeaponId = 'axe' | 'pistol' | 'shotgun' | 'smg' | 'rifle' | 'sniper';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: number;
  isMelee: boolean;
  damage: number;
  fireRate: number; // shots per second
  magSize: number;
  reloadTime: number; // seconds
  spread: number; // radians
  pellets: number;
  range: number;
  recoil: number;
  noiseRadius: number; // meters
  trauma: number;
  modelKey: string;
  sfxKey: string;
  ammoType?: 'pistol' | 'shells' | 'rifle';
}

export type ItemCategory = 'food' | 'water' | 'medkit' | 'ammo' | 'scrap' | 'quest' | 'tool';
export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'quest';

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  rarity: ItemRarity;
  description: string;
  icon: string;
  hungerRestore?: number;
  thirstRestore?: number;
  healthRestore?: number;
  staminaBoost?: number;
  ammoAmount?: number;
  ammoType?: 'pistol' | 'shells' | 'rifle';
  stackable: boolean;
}

export interface InventorySlot {
  item: ItemDef;
  quantity: number;
}

export type ZombieArchetype = 'shambler' | 'sprinter' | 'brute' | 'crawler';
export type ZombieAIState = 'patrol' | 'investigate' | 'chase' | 'attack' | 'stagger' | 'dead';

export type DayPhase = 'day' | 'dusk' | 'night' | 'dawn';

export interface InteractableObject {
  id: string;
  type: 'loot' | 'jerrycan' | 'beacon' | 'entry' | 'campfire' | 'dog' | 'extraction_truck' | 'bed' | 'keys';
  label: string;
  subLabel?: string;
  position: THREE.Vector3;
  radius: number;
  consumed?: boolean;
  mesh?: THREE.Object3D;
  data?: Record<string, unknown>;
}

export interface WaypointState {
  label: string;
  distance: number;
  /** Screen position in pixels (clamped to the screen edge when off-screen). */
  x: number;
  y: number;
  onScreen: boolean;
  /** Arrow rotation (radians) when off-screen. */
  angle: number;
  color: string;
}

export interface DamageIndicator {
  /** Direction relative to the camera (radians, 0 = in front). */
  angle: number;
  alpha: number;
}

export interface HUDState {
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  hunger: number;
  thirst: number;
  scrap: number;
  noiseLevel: number; // 0..100
  flashlightOn: boolean;
  isAiming: boolean;
  isCrouching: boolean;
  isReloading: boolean;
  reloadProgress: number; // 0..1
  equippedWeapon: WeaponDef;
  magAmmo: Record<WeaponId, number>;
  reserveAmmo: Record<'pistol' | 'shells' | 'rifle', number>;
  unlockedWeapons: WeaponId[];
  dayNumber: number;
  timeOfDay: number; // 0..1 (0.0=dawn, 0.35=noon, 0.66=nightfall, 1.0=next dawn)
  phase: DayPhase;
  jerrycansCollected: number;
  beaconCollected: boolean;
  extractionActive: boolean;
  extractionTimer: number; // 60s countdown
  dogRecruited: boolean;
  dogAlertTimer: number;
  zombieCount: number;
  kills: number;
  nearbyInteractable: InteractableObject | null;
  inventoryOpen: boolean;
  inventory: InventorySlot[];
  toastMessage: string | null;
  crosshairSpread: number;
  hitMarkerTimer: number;
  hitKind: 'hit' | 'head' | 'kill';
  damageFlashTimer: number;
  inventoryVersion: number;
  waypoint: WaypointState | null;
  damageIndicators: DamageIndicator[];
  extractionInRange: boolean;
  isSprinting: boolean;
  chapterLabel: string;
  objectiveText: string;
  radio: { speaker: string; text: string; progress: number } | null;
  bossHealth: number | null;
  rest: { clock: string; status: string } | null;
  cinematic: boolean;
  cameraYaw: number;
  objectiveBearing: number | null;
  dodgeReady: number; // 0..1
  chapterBanner: { chapter: number; title: string; alpha: number } | null;
  healFlashTimer: number;
  isSniperADS: boolean;
}
