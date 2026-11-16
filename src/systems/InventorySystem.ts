import { ITEMS } from '../data/catalog';
import { PlayerController } from '../entities/PlayerController';
import { AudioManager } from '../core/AudioManager';
import { InventorySlot, ItemDef } from '../types/game';

export class InventorySystem {
  public slots: InventorySlot[] = [];
  /** Bumped whenever the pack changes, so the HUD only re-renders when needed. */
  public version = 0;

  constructor(private audio: AudioManager) {
    this.addItem('canned_food', 1);
    this.addItem('water_bottle', 1);
    this.addItem('bandages', 2);
  }

  public addItem(itemId: string, quantity = 1): boolean {
    const def = ITEMS[itemId];
    if (!def) return false;
    this.version++;
    if (def.stackable) {
      const existing = this.slots.find((s) => s.item.id === itemId);
      if (existing) {
        existing.quantity += quantity;
        return true;
      }
    }
    this.slots.push({ item: def, quantity });
    return true;
  }

  /** Loot pickup: ammo goes straight into the reserve, everything else into the pack. */
  public pickup(itemId: string, player: PlayerController): string {
    const def = ITEMS[itemId];
    if (!def) return '';
    if (def.category === 'ammo' && def.ammoType && def.ammoAmount) {
      player.reserveAmmo[def.ammoType] += def.ammoAmount;
      return `+${def.ammoAmount} ${def.name}`;
    }
    this.addItem(itemId, 1);
    return `${def.icon} ${def.name}`;
  }

  public useItem(index: number, player: PlayerController): string | null {
    const slot = this.slots[index];
    if (!slot) return null;
    const item: ItemDef = slot.item;

    if (item.category === 'ammo' && item.ammoType && item.ammoAmount) {
      player.reserveAmmo[item.ammoType] += item.ammoAmount;
      this.audio.playUI('loot_pickup', 0.5);
      this.consumeSlot(index);
      return `Loaded +${item.ammoAmount} ${item.name} into reserve.`;
    }

    if (item.category === 'medkit' && player.health >= player.maxHealth) {
      return 'Already at full health.';
    }

    if (item.hungerRestore) player.hunger = Math.min(100, player.hunger + item.hungerRestore);
    if (item.thirstRestore) player.thirst = Math.min(100, player.thirst + item.thirstRestore);
    if (item.healthRestore) player.health = Math.min(player.maxHealth, player.health + item.healthRestore);
    if (item.staminaBoost) player.stamina = Math.min(player.maxStamina, player.stamina + item.staminaBoost);

    if (item.category === 'water') {
      this.audio.playUI('drink_sfx', 0.55);
    } else if (item.category === 'medkit') {
      this.audio.playUI('heal_sfx', 0.6);
    } else {
      this.audio.playUI('eat_sfx', 0.5);
    }

    this.consumeSlot(index);
    return `Used ${item.name}`;
  }

  public useQuickMedkit(player: PlayerController): string | null {
    // Prefer bandages for small wounds, medkits for big ones
    const missing = player.maxHealth - player.health;
    const order = missing > 40 ? ['medkit', 'bandages'] : ['bandages', 'medkit'];
    for (const id of order) {
      const idx = this.slots.findIndex((s) => s.item.id === id);
      if (idx !== -1) return this.useItem(idx, player);
    }
    return null;
  }

  public craftMedkit(player: PlayerController): string {
    if (player.scrap < 15) return 'Need 15 Scrap to craft First-Aid Kit.';
    player.scrap -= 15;
    this.addItem('medkit', 1);
    this.audio.playUI('heal_sfx', 0.5);
    return 'Crafted First-Aid Kit!';
  }

  public craftAmmo(player: PlayerController, type: 'pistol' | 'shells' | 'rifle'): string {
    const cost = type === 'pistol' ? 8 : 12;
    if (player.scrap < cost) return `Need ${cost} Scrap to craft ammo.`;
    player.scrap -= cost;
    this.version++;
    if (type === 'pistol') player.reserveAmmo.pistol += 15;
    else if (type === 'shells') player.reserveAmmo.shells += 6;
    else player.reserveAmmo.rifle += 15;
    this.audio.playUI('reload', 0.5);
    return `Crafted ${type === 'pistol' ? '9mm' : type === 'shells' ? 'Buckshot' : 'Rifle'} Ammo!`;
  }

  private consumeSlot(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    this.version++;
    slot.quantity--;
    if (slot.quantity <= 0) {
      this.slots.splice(index, 1);
    }
  }
}
