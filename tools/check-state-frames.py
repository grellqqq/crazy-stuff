"""Source-level garment-presence check for v4 state frames.

The state animation renders occasionally drop the garment on individual
frames (apex of jump, some run cycles). Detect by counting garment-colored
pixels on the STATE frame itself:
  blue_jeans      — blue-hue pixels (b > r+15, b > 60) below mid-frame
  worn_tshirt     — low-saturation mid-luminance greys in the torso band
  beatup_sneakers — near-white pixels in the feet band

Prints item-body anim_dir frame for every bad frame.
Usage: python tools/check-state-frames.py [threshold_scale]
"""
import os
import sys

import numpy as np
from PIL import Image

FS = 92
ANIMS = [("walk", 6), ("run", 6), ("jump", 9), ("idle", 4)]
DIRS = ["south", "east", "north", "south-east", "north-east"]


def garment_px(item, arr, anim=None):
    r = arr[..., 0].astype(np.int32)
    g = arr[..., 1].astype(np.int32)
    b = arr[..., 2].astype(np.int32)
    op = arr[..., 3] > 8
    if item == "blue_jeans":
        m = op & (b > r + 15) & (b > 60)
        m[:FS // 3, :] = False
        total = int(m.sum())
        # FULL-LENGTH test: the renders sometimes draw SHORTS (read in-game
        # as underwear). Ground anims must have denim on the SHINS; an
        # airborne jump tuck legitimately lifts the hem, so jump is exempt
        # via the caller passing anim.
        return total
    if item == "worn_tshirt":
        sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
        lum = (r + g + b) / 3
        m = op & (sat < 28) & (lum > 95) & (lum < 215)
        m[:18, :] = False
        m[60:, :] = False
        return int(m.sum())
    if item == "beatup_sneakers":
        lum = (r + g + b) / 3
        sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
        m = op & (lum > 175) & (sat < 60)
        m[:55, :] = False
        return int(m.sum())
    return 0


FLOORS = {"blue_jeans": 80, "worn_tshirt": 60, "beatup_sneakers": 12}

bad = []
for item in ["worn_tshirt", "blue_jeans", "beatup_sneakers"]:
    for body in ["female", "male"]:
        root = f"tools/pixellab-downloads/v4/{item}-{body}"
        for anim, nf in ANIMS:
            for d in DIRS:
                for fi in range(1, nf + 1):
                    p = f"{root}/{anim}_{d}_f{fi}.png"
                    if not os.path.exists(p):
                        bad.append(f"{item} {body} {anim} {d} f{fi} MISSING")
                        continue
                    arr = np.asarray(Image.open(p).convert("RGBA")).astype(np.int32)
                    n = garment_px(item, arr, anim)
                    short = False
                    if item == "blue_jeans" and anim != "jump":
                        r2 = arr[..., 0].astype(np.int32)
                        b2 = arr[..., 2].astype(np.int32)
                        shin = (arr[..., 3] > 8) & (b2 > r2 + 15) & (b2 > 60)
                        shin[:64, :] = False
                        short = int(shin.sum()) < 20
                    if n < FLOORS[item] or short:
                        why = "SHORTS" if short and n >= FLOORS[item] else f"{n}px"
                        bad.append(f"{item} {body} {anim} {d} f{fi} ({why})")
print("\n".join(bad) if bad else "ALL STATE FRAMES HAVE GARMENTS")
print(f"\n{len(bad)} bad frames")
