"""
Builds the game's runtime assets in public/assets/ from the raw packs in the repo root.

  python scripts/prepare_assets.py

- SFX: selected WAVs from 800-game-sound-effects -> mono, peak-normalised OGG (sfx/)
- VFX: selected Brackeys alpha sprites -> 256 px PNG (vfx/)
- Nature: a few Stylized Nature Pack glTFs with textures downscaled (nature/)

Needs ffmpeg on PATH and Pillow. Safe to re-run; outputs are overwritten.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets"
SFX_SRC = ROOT / "800-game-sound-effects"
VFX_SRC = ROOT / "brackeys_vfx_bundle" / "brackeys_vfx_bundle" / "particles" / "alpha"
NATURE_SRC = ROOT / "Ultimate Stylized Nature Pack" / "glTF"

# output name -> (category folder, filename prefix before "_48kHz", loop?)
SFX: dict[str, tuple[str, str, bool]] = {
    # UI
    "ui_click": ("01_ui_interface", "btn_48kHz_16bit_0.31s_01_s01", False),
    "ui_back": ("01_ui_interface", "back_48kHz_16bit_0.06s_01_s13", False),
    "ui_alert": ("01_ui_interface", "alert_48kHz_16bit_0.31s_01_s29", False),
    "ui_hover": ("01_ui_interface", "hover_48kHz_16bit_0.06s_02_s16", False),
    "ui_confirm": ("01_ui_interface", "confirm_48kHz_16bit_0.54s_02_s13", False),
    "ui_open": ("01_ui_interface", "open_004_48kHz_16bit_0.32s_01_s13", False),
    "ui_close": ("01_ui_interface", "close_004_48kHz_16bit_0.32s_01_s13", False),
    "ui_error": ("01_ui_interface", "error_48kHz_16bit_0.16s_01_s13", False),
    "ui_powerup": ("01_ui_interface", "power_up_48kHz_16bit_0.8s_03_s11", False),
    "ui_game_over": ("01_ui_interface", "game_over_48kHz_16bit_2.4s_01_s29", False),
    "ui_complete": ("01_ui_interface", "complete_48kHz_16bit_3.22s_01_s62", False),
    # Footsteps by surface
    "step_concrete1": ("02_footsteps", "concrete_48kHz_16bit_0.11s_01_s12", False),
    "step_concrete2": ("02_footsteps", "concrete_48kHz_16bit_0.11s_02_s12", False),
    "step_concrete3": ("02_footsteps", "concrete_48kHz_16bit_0.11s_03_s12", False),
    "step_concrete4": ("02_footsteps", "concrete_48kHz_16bit_0.11s_04_s12", False),
    "step_grass1": ("02_footsteps", "grassy_footstep_48kHz_16bit_0.41s_01_s27", False),
    "step_grass2": ("02_footsteps", "grassy_footstep_48kHz_16bit_0.5s_02_s27", False),
    "step_grass3": ("02_footsteps", "grassy_footstep_48kHz_16bit_0.5s_03_s27", False),
    "step_wood1": ("02_footsteps", "wood_48kHz_16bit_0.25s_01_s12", False),
    "step_wood2": ("02_footsteps", "wood_48kHz_16bit_0.25s_02_s12", False),
    "step_wood3": ("02_footsteps", "wood_48kHz_16bit_0.25s_03_s12", False),
    "step_wood4": ("02_footsteps", "wood_48kHz_16bit_0.25s_04_s12", False),
    "step_heavy": ("10_impacts_materials", "heavy_thud_48kHz_16bit_0.51s_01_s12", False),
    "gear_rustle": ("03_movement_cloth_gear", "cloth_heavy_48kHz_16bit_0.37s_01_s35", False),
    # Weapons
    "gun_pistol": ("05_combat_ranged", "gunshot_48kHz_16bit_0.16s_01_s30", False),
    "gun_pistol2": ("05_combat_ranged", "gunshot_48kHz_16bit_0.1s_02_s30", False),
    "gun_smg": ("05_combat_ranged", "gunshot_48kHz_16bit_0.05s_03_s30", False),
    "gun_smg2": ("05_combat_ranged", "gunshot_48kHz_16bit_0.04s_04_s30", False),
    "gun_rifle": ("05_combat_ranged", "shot_48kHz_16bit_0.19s_01_s55", False),
    "gun_rifle2": ("05_combat_ranged", "shot_48kHz_16bit_0.28s_02_s55", False),
    "gun_sniper": ("05_combat_ranged", "gun_48kHz_16bit_0.77s_02_s29", False),
    "gun_shotgun": ("05_combat_ranged", "shotgun_48kHz_16bit_0.37s_01_s30", False),
    "gun_shotgun2": ("05_combat_ranged", "shotgun_48kHz_16bit_0.63s_02_s30", False),
    "gun_shotgun3": ("05_combat_ranged", "shotgun_48kHz_16bit_0.65s_03_s30", False),
    "gun_empty": ("05_combat_ranged", "empty_weapon_48kHz_16bit_0.12s_02_s29", False),
    "reload": ("05_combat_ranged", "reload_48kHz_16bit_0.49s_01_s29", False),
    "reload_mag": ("05_combat_ranged", "sfx_wpn_reload_48kHz_16bit_0.23s_01_s30", False),
    "ammo_pickup": ("05_combat_ranged", "ammo_48kHz_16bit_0.25s_01_s29", False),
    "casing1": ("12_items_inventory", "metal_small1_48kHz_16bit_0.2s_01_s35", False),
    "casing2": ("12_items_inventory", "metal_small2_48kHz_16bit_0.28s_01_s35", False),
    "casing3": ("12_items_inventory", "metal_small3_48kHz_16bit_0.34s_01_s35", False),
    # Melee
    "melee_swing": ("04_combat_melee", "swosh_48kHz_16bit_0.28s_01_s45", False),
    "melee_swing2": ("04_combat_melee", "woosh_1_48kHz_16bit_0.21s_01_s29", False),
    "melee_hit": ("10_impacts_materials", "chop_48kHz_16bit_0.24s_01_s14", False),
    "melee_hit_heavy": ("04_combat_melee", "punch_heavy_48kHz_16bit_0.54s_02_s12", False),
    # Bullet impacts
    "impact_flesh1": ("10_impacts_materials", "impact_meat_48kHz_16bit_0.5s_01_s44", False),
    "impact_flesh2": ("10_impacts_materials", "impact_meat_48kHz_16bit_0.5s_02_s44", False),
    "impact_metal": ("10_impacts_materials", "impact_metal_light_48kHz_16bit_0.24s_03_s12", False),
    "impact_metal2": ("10_impacts_materials", "impact_metal_light_48kHz_16bit_0.25s_02_s12", False),
    "impact_concrete": ("10_impacts_materials", "impact_generic_light_48kHz_16bit_0.14s_01_s12", False),
    "impact_concrete2": ("10_impacts_materials", "impact_generic_light_48kHz_16bit_0.12s_02_s12", False),
    "impact_wood": ("10_impacts_materials", "impact_wood_light_003_48kHz_16bit_0.27s_01_s12", False),
    "impact_glass": ("10_impacts_materials", "glass_breaking_1_48kHz_16bit_0.59s_01_s29", False),
    "wood_break": ("10_impacts_materials", "bfh1_breaking_03_48kHz_16bit_0.46s_01_s63", False),
    "wood_hit": ("10_impacts_materials", "impact_plank_medium_48kHz_16bit_0.5s_01_s12", False),
    "debris_fall": ("10_impacts_materials", "bfh1_rock_falling_09_48kHz_16bit_0.59s_01_s63", False),
    # Explosions
    "explosion": ("06_explosions_destruction", "explosion_crunch_48kHz_16bit_1.26s_03_s15", False),
    "explosion_low": ("06_explosions_destruction", "explosion_low_48kHz_16bit_2s_01_s15", False),
    "explosion_distant": ("06_explosions_destruction", "nenad_simic_muffled_distant_explosion_48kHz_16bit_3.25s_01_s22", False),
    # Zombies
    "zombie_groan1": ("08_creatures_monsters", "zombie_48kHz_16bit_0.66s_01_s36", False),
    "zombie_groan2": ("08_creatures_monsters", "zombie_48kHz_16bit_0.49s_02_s36", False),
    "zombie_groan3": ("08_creatures_monsters", "zombie_48kHz_16bit_0.77s_03_s36", False),
    "zombie_hurt1": ("08_creatures_monsters", "creature_hurt_48kHz_16bit_0.47s_04_s57", False),
    "zombie_hurt2": ("08_creatures_monsters", "creature_hurt_48kHz_16bit_0.49s_03_s57", False),
    "zombie_hurt3": ("08_creatures_monsters", "creature_hurt_48kHz_16bit_0.52s_01_s56", False),
    "zombie_death": ("08_creatures_monsters", "creature_death_48kHz_16bit_1.06s_01_s56", False),
    "zombie_shriek1": ("08_creatures_monsters", "sfx_deathscream_alien2_48kHz_16bit_0.78s_01_s30", False),
    "zombie_shriek2": ("08_creatures_monsters", "sfx_deathscream_alien4_48kHz_16bit_0.83s_01_s30", False),
    "zombie_aggro": ("08_creatures_monsters", "monster_9_48kHz_16bit_0.52s_01_s24", False),
    "zombie_breath": ("08_creatures_monsters", "breath_48kHz_16bit_0.62s_01_s57", False),
    "zombie_bite": ("08_creatures_monsters", "bite_small_48kHz_16bit_0.38s_01_s35", False),
    "zombie_roar": ("08_creatures_monsters", "roar_48kHz_16bit_0.64s_01_s56", False),
    "brute_roar": ("08_creatures_monsters", "roar_48kHz_16bit_0.95s_03_s56", False),
    "brute_grunt1": ("08_creatures_monsters", "giant_48kHz_16bit_0.6s_01_s35", False),
    "brute_grunt2": ("08_creatures_monsters", "giant_48kHz_16bit_0.69s_02_s35", False),
    "brute_hurt": ("08_creatures_monsters", "ogre_48kHz_16bit_0.4s_01_s35", False),
    # Player & dog
    "player_hurt1": ("10_impacts_materials", "impact_soft_heavy_48kHz_16bit_0.57s_01_s12", False),
    "player_gasp": ("09_human_nonverbal", "freakedbreath_48kHz_16bit_1.24s_01_s27", False),
    "heartbeat": ("09_human_nonverbal", "heartbeat_fast_0_48kHz_16bit_1.01s_01_s38", False),
    "scream_distant": ("09_human_nonverbal", "scream_48kHz_16bit_1.72s_03_s27", False),
    "dog_bark": ("08_creatures_monsters", "barking_02_48kHz_16bit_0.33s_01_s57", False),
    # Items & world
    "loot_pickup": ("12_items_inventory", "item_wood_48kHz_16bit_0.26s_02_s56", False),
    "crate_open": ("11_doors_locks", "latch_48kHz_16bit_0.26s_01_s14", False),
    "crate_creak": ("11_doors_locks", "creak_48kHz_16bit_0.65s_01_s14", False),
    "door_open": ("11_doors_locks", "door_08_48kHz_16bit_0.74s_01_s07", False),
    "objective_pickup": ("12_items_inventory", "gold_3_48kHz_16bit_0.43s_01_s29", False),
    "drink_sfx": ("12_items_inventory", "bottle_plastic_lid_unscrew_48kHz_16bit_1.24s_01_s32", False),
    "eat_sfx": ("12_items_inventory", "item_48kHz_16bit_0.34s_03_s56", False),
    "heal_sfx": ("12_items_inventory", "bottle_pills_shake_48kHz_16bit_0.27s_01_s32", False),
    "hammer": ("20_tools_household", "wood_hammer_02_48kHz_16bit_0.23s_01_s50", False),
    "switch": ("17_machinery_technology", "switch_48kHz_16bit_0.22s_01_s48", False),
    "thunder": ("15_nature_weather", "thunder_48kHz_16bit_5.26s_01_s49", False),
    "raven": ("15_nature_weather", "raven_48kHz_16bit_2.06s_02_s29", False),
    # Loops
    "loop_wind": ("15_nature_weather", "wind_48kHz_16bit_60s_01_s20", True),
    "loop_rain": ("15_nature_weather", "rain_loop_48kHz_16bit_6.83s_01_s53", True),
    "loop_fire": ("15_nature_weather", "fire_loop_48kHz_16bit_29.26s_01_s28", True),
    "loop_crickets": ("15_nature_weather", "cricket_48kHz_16bit_13.71s_01_s17", True),
    "loop_eerie": ("16_ambiences", "atmoseerie_48kHz_16bit_20.01s_01_s05", True),
    "loop_car_alarm": ("17_machinery_technology", "alarm_loop_48kHz_16bit_1.98s_01_s52", True),
    "loop_engine": ("17_machinery_technology", "engine_48kHz_16bit_5s_01_s15", True),
    "loop_record": ("17_machinery_technology", "record_player_loop_loop_48kHz_16bit_5.11s_01_s27", True),
}

VFX = [
    "muzzle_01", "muzzle_02", "muzzle_04", "flame_02", "flame_03", "flame_05", "fire_01",
    "smoke_01", "smoke_04", "smoke_07", "spark_01", "spark_04", "scorch_01", "scorch_02",
    "dirt_01", "dirt_03", "light_01", "light_02", "circle_05", "trace_01", "star_06",
]

NATURE = [
    "DeadTree_1", "DeadTree_2", "DeadTree_3", "DeadTree_6", "DeadTree_8", "DeadTree_10",
    "Bush_Small", "Bush", "Grass_Large", "Grass_Small",
]


def run(cmd: list[str]) -> str:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{res.stderr[-800:]}")
    return res.stderr


def find_wav(folder: str, prefix: str) -> Path:
    matches = sorted((SFX_SRC / folder).glob(prefix + "*.wav"))
    if not matches:
        sys.exit(f"missing sfx: {folder}/{prefix}*")
    return matches[0]


def build_sfx() -> None:
    out = OUT / "sfx"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name, (folder, prefix, loop) in SFX.items():
        src = find_wav(folder, prefix)
        stats = run(["ffmpeg", "-hide_banner", "-i", str(src), "-af", "volumedetect", "-f", "null", "-"])
        m = re.search(r"max_volume: (-?[\d.]+) dB", stats)
        peak = float(m.group(1)) if m else 0.0
        gain = -1.0 - peak  # peak-normalise to -1 dBFS
        af = f"volume={gain:.2f}dB"
        if loop:
            # gentle 20 ms fades at the ends avoid clicks at the loop seam
            af += ",afade=t=in:d=0.02"
        run([
            "ffmpeg", "-hide_banner", "-y", "-i", str(src), "-ac", "1", "-ar", "44100",
            "-af", af, "-c:a", "libvorbis", "-q:a", "3" if loop else "4", str(out / f"{name}.ogg"),
        ])
    print(f"sfx: {len(SFX)} files")


def build_vfx() -> None:
    out = OUT / "vfx"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in VFX:
        im = Image.open(VFX_SRC / f"{name}_a.png").convert("RGBA")
        im.resize((256, 256), Image.LANCZOS).save(out / f"{name}.png", optimize=True)
    print(f"vfx: {len(VFX)} sprites")


def build_nature() -> None:
    out = OUT / "nature"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    textures: set[str] = set()
    for name in NATURE:
        gltf = json.loads((NATURE_SRC / f"{name}.gltf").read_text())
        for buf in gltf.get("buffers", []):
            shutil.copy(NATURE_SRC / buf["uri"], out / buf["uri"])
        for img in gltf.get("images", []):
            textures.add(img["uri"])
        # Normal maps add 20 MB each for little visible gain at game distance — drop them.
        for mat in gltf.get("materials", []):
            mat.pop("normalTexture", None)
        (out / f"{name}.gltf").write_text(json.dumps(gltf))
    for tex in textures:
        if "_Normal" in tex:
            continue
        im = Image.open(NATURE_SRC / tex)
        im = im.resize((512, 512), Image.LANCZOS)
        if tex.lower().endswith(".jpg"):
            im.convert("RGB").save(out / tex, quality=85)
        else:
            im.save(out / tex, optimize=True)
    print(f"nature: {len(NATURE)} models, {len([t for t in textures if '_Normal' not in t])} textures")


if __name__ == "__main__":
    build_sfx()
    build_vfx()
    build_nature()
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"public/assets total: {total / 1e6:.1f} MB")
