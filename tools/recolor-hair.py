"""Recolor the BLUE proxy hair overlays into the catalog colours (GDD 12 F3).

Blue is the extraction proxy (high-contrast against skin + baked brown hair, so
the overlay extracts cleanly). Each catalog colour is a 6-step ramp in
tools/hair-ramps.json; every opaque hair pixel is mapped by its luminance onto
that ramp (interpolated, so shading stays smooth and rank order is preserved).
Outline pixels (lum < 32, neutral near-black) are kept as-is so every colour
reads with a crisp dark outline. Alpha is copied verbatim.

Produces hair_<shape>_<colour>/<gender>/<anim>_<dir>.png for colour in
brown/black/blonde/red, mirroring the _blue folder exactly. No PixelLab, no
regeneration — pure palette swap, identical silhouette across colours.

Usage: python tools/recolor-hair.py [shapes...]   (default: all wave-1)
"""
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

SHAPES = ["short", "ponytail", "long", "afro", "dreads"]
ROOT = "src/client/public/sprites/equipment/hair"
CFG = json.load(open("tools/hair-ramps.json", encoding="utf-8"))
LMIN = CFG["source_luma"]["min"]
LMAX = CFG["source_luma"]["max"]


def hex2rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


RAMPS = {c: np.array([hex2rgb(x) for x in steps], np.float32)
         for c, steps in CFG["ramps"].items()}


def recolor(arr, ramp):
    a = arr.astype(np.float32)
    rgb = a[..., :3]
    A = a[..., 3]
    L = rgb.mean(2)
    op = A > 16
    body = op & (L >= 32)                    # non-outline hair
    t = np.clip((L - LMIN) / (LMAX - LMIN), 0, 1)
    pos = t * (len(ramp) - 1)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, len(ramp) - 1)
    f = (pos - i0)[..., None]
    col = ramp[i0] * (1 - f) + ramp[i1] * f  # interpolated ramp colour
    out = a.copy()
    out[body, :3] = col[body]                # outline pixels stay untouched
    out[..., 3] = A
    return np.clip(out, 0, 255).astype(np.uint8)


def run(shape):
    made = 0
    for g in ("male", "female"):
        src_dir = f"{ROOT}/hair_{shape}_blue/{g}"
        if not os.path.isdir(src_dir):
            print(f"  hair_{shape} {g}: SKIP (no blue source)")
            continue
        for color, ramp in RAMPS.items():
            dst_dir = f"{ROOT}/hair_{shape}_{color}/{g}"
            os.makedirs(dst_dir, exist_ok=True)
            for src in glob.glob(f"{src_dir}/*.png"):
                arr = np.asarray(Image.open(src).convert("RGBA"))
                out = recolor(arr, ramp)
                Image.fromarray(out).save(f"{dst_dir}/{os.path.basename(src)}")
                made += 1
    print(f"  hair_{shape}: wrote {made} sheets ({len(RAMPS)} colours x 2 genders)")


if __name__ == "__main__":
    todo = sys.argv[1:] or SHAPES
    for s in todo:
        run(s)
    print("DONE")
