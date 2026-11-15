import { ITEMS } from '../data/catalog';
import { PlayerController } from '../entities/PlayerController';
import { AudioManager } from '../core/AudioManager';
import { InventorySlot, ItemDef } from '../types/game';

export class InventorySystem {
  public slots: InventorySlot[] = [];

  constructor(private audio: AudioManager) {
    // Starter survival kit
    this.addItem('canned_food', 1);
    this.addItem('water_bottle', 1);
    this.addItem('bandages', 2);
  }

  public addItem(itemId: string, quantity = 1): boolean {
    const def = ITEMS[itemId];
    if (!def) return false;

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

    if (item.hungerRestore) {
      player.hunger = Math.min(100, player.hunger + item.hungerRestore);
    }
    if (item.thirstRestore) {
      player.thirst = Math.min(100, player.thirst + item.thirstRestore);
    }
    if (item.healthRestore) {
      player.health = Math.min(player.maxHealth, player.health + item.healthRestore);
    }
    if (item.staminaBoost) {
      player.stamina = Math.min(player.maxStamina, player.stamina + item.staminaBoost);
    }

    if (item.category === 'water') {
      this.audio.playUI('drink_sfx', 0.55);
    } else if (item.category === 'medkit') {
      this.audio.playUI('heal_sfx', 0.6);
    } else {
      this.audio.playUI('loot_pickup', 0.45);
    }

    this.consumeSlot(index);
    return `Used ${item.name}`;
  }

  public useQuickMedkit(player: PlayerController): string | null {
    const idx = this.slots.findIndex((s) => s.item.category === 'medkit');
    if (idx === -1) return null;
    return this.useItem(idx, player);
  }

  public craftMedkit(player: PlayerController): string {
    if (player.scrap < 15) return 'Need 15 Scrap to craft First-Aid Kit.';
    player.scrap -= 15;
    this.addItem('medkit', 1);
    this.audio.playUI('loot_pickup', 0.6);
    return 'Crafted First-Aid Kit!';
  }

  public craftAmmo(player: PlayerController, type: 'pistol' | 'shells' | 'rifle'): string {
    const cost = type === 'pistol' ? 8 : 12;
    if (player.scrap < cost) return `Need ${cost} Scrap to craft ammo.`;
    player.scrap -= cost;
    if (type === 'pistol') player.reserveAmmo.pistol += 15;
    else if (type === 'shells') player.reserveAmmo.shells += 6;
    else player.reserveAmmo.rifle += 15;
    this.audio.playUI('reload', 0.5);
    return `Crafted ${type.toUpperCase()} Ammo!`;
  }

  private consumeSlot(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    slot.quantity--;
    if (slot.quantity <= 0) {
      this.slots.splice(index, 1);
    }
  }
}
