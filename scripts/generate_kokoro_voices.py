"""Generate studio-polished Captain Reyes radio voiceovers using Kokoro-82M ONNX + FFmpeg."""
import os
import subprocess
import tempfile
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR = os.path.expanduser(
    r"~\.cache\huggingface\hub\models--fastrtc--kokoro-onnx\snapshots\8d07950c9b6c87ce6809e9bba7bd494336217c2a"
)
MODEL_PATH = os.path.join(MODEL_DIR, "kokoro-v1.0.onnx")
VOICES_PATH = os.path.join(MODEL_DIR, "voices-v1.0.bin")
OUT_DIR = os.path.join("public", "assets", "voice")
os.makedirs(OUT_DIR, exist_ok=True)

# (id, text, speed)
LINES = [
    ("reyes_01", "Anyone still breathing in Sector Four, this is Captain Reyes, Evac Command. Get off the street.", 1.00),
    ("reyes_02", "There's a marked safehouse south-west of the main crossing. Get inside before they notice you.", 1.02),
    ("reyes_03", "Good. Lock down what you can. There should be a supply drop crate in there. Grab it.", 1.00),
    ("reyes_04", "If a German Shepherd's hanging around outside, he's friendly. Take him with you.", 0.99),
    ("reyes_05", "My transmitter's failing. There's a working shortwave in Joe's Diner, east side. Find it and I can talk you out.", 1.02),
    ("reyes_06", "Signal's clean now. Listen: there's an armored truck at the North Gate. That's your ride out.", 1.01),
    ("reyes_07", "It's bone dry. Find fuel, three cans at least. Try the pharmacy, the freight yard, or the wrecks on the avenue.", 1.02),
    ("reyes_08", "That's enough fuel. But it's getting dark, and you can't push through a horde blind.", 0.98),
    ("reyes_09", "Get back to the safehouse. Board up every door and window, then rest until dawn. Do not let them in.", 1.00),
    ("reyes_10", "Hear that siren? That's the Blood Siren. They get faster after dark. Stay off the open street.", 1.04),
    ("reyes_11", "You made it through. Bad news: the truck's driver turned before we could pull him out. He's still got the keys.", 1.01),
    ("reyes_12", "Big one. What's left of a butcher's apron. Last seen in the freight yard, north-east. Put him down.", 0.99),
    ("reyes_13", "That's him. Get those keys off what's left of him.", 1.03),
    ("reyes_14", "Get to the truck. Once that engine turns over, every dead thing for a mile will hear it.", 1.03),
    ("reyes_15", "The gate motor runs off the truck. You'll have to hold them off while it warms up.", 1.02),
    ("reyes_16", "Engine is cold. Sixty seconds. Stay close to the truck!", 1.08),
    ("reyes_17", "Gate motor's live! Get in the truck!", 1.12),
    ("reyes_18", "You're in! Floor it, straight through the gate and don't stop for anything!", 1.10),
    # Dynamic tactical combat & survival callouts
    ("reyes_callout_headshot", "Clean headshot. Keep dropping them!", 1.06),
    ("reyes_callout_limb", "Blew its arm clean off. Stay sharp!", 1.06),
    ("reyes_callout_lowhp", "You're bleeding out. Patch yourself up!", 1.06),
    ("reyes_callout_dog", "Good boy. Keep that shepherd close, he'll watch your six.", 1.00),
]

def main():
    print("Loading Kokoro-82M ONNX...")
    kokoro = Kokoro(MODEL_PATH, VOICES_PATH)

    # Blend am_onyx (deep gritty baritone) + am_michael (natural warm clarity) for Captain Reyes
    v_onyx = kokoro.get_voice_style("am_onyx")
    v_michael = kokoro.get_voice_style("am_michael")
    reyes_voice = (v_onyx * 0.58 + v_michael * 0.42).astype(np.float32)

    durations = {}
    with tempfile.TemporaryDirectory() as tmp:
        for vid, text, speed in LINES:
            samples, sr = kokoro.create(text, voice=reyes_voice, speed=speed, lang="en-us", trim=True)
            # Subtle warm radio presence without harsh tinny distortion
            raw_wav = os.path.join(tmp, f"{vid}.wav")
            sf.write(raw_wav, samples, sr)

            out_ogg = os.path.join(OUT_DIR, f"{vid}.ogg")
            # Warm military shortwave polish: gentle rolloffs, vocal clarity boost, smooth broadcast compression
            af = (
                "highpass=f=180,"
                "lowpass=f=5200,"
                "equalizer=f=2100:t=q:w=1.2:g=2.8,"
                "equalizer=f=320:t=q:w=1.0:g=1.4,"
                "acompressor=threshold=-18dB:ratio=3.2:attack=5:release=90:makeup=2,"
                "alimiter=limit=0.92"
            )
            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", raw_wav,
                "-af", af,
                "-c:a", "libvorbis", "-q:a", "4",
                out_ogg,
            ]
            subprocess.run(cmd, check=True)
            dur = len(samples) / float(sr)
            durations[vid] = round(dur, 2)
            kb = os.path.getsize(out_ogg) / 1024
            print(f"  {vid}.ogg  ({dur:.2f}s, {kb:.1f} KB)")

    print("Done! Total clips:", len(durations))
    print("Durations:", durations)

if __name__ == "__main__":
    main()
