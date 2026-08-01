"""Build hair overlays from the character ROTATIONS, not the animations.

WHY (found 2026-07-27): PixelLab's static rotations draw the hair correctly from
every angle (full tail/curtain/dreads from behind, clean face from front). The
ANIMATION step drops the hanging hair on back views and shoves dreads onto the
face on some front frames. The old pipeline extracted from those corrupted
animation frames — the source of every recurring hair bug.

This pipeline instead:
  1. isolates the hair from each of the 5 east-side ROTATIONS (bluehair gate),
  2. head-locks that rotation-hair onto every animation frame of the SAME
     direction (translate by base head-anchor delta) — each direction uses its
     OWN rotation, so there is NO cross-direction synthesis to glitch,
  3. covers any baked base-hair peeking at the hairline, keeps the throat clear,
  4. mirrors the 5 east sheets to the 3 west files (engine flips east for west).

Hair is rigid enough that a per-direction static canonical head-locked to the
body reads correctly (same approach the masks/run-jump already use).

Inputs (downloaded to scratchpad):
  <SC>/allrot/<shape>_<gender>_<dir>.png   hair-state rotations (8 dirs)
  <SC>/baserot/<gender>_<dir>.png          base-body rotations (5 dirs)
Base animation frames: src/client/public/sprites/characters/<g>/<anim>_<d>.png

Usage: python tools/bake-hair-from-rotations.py [shapes...]
"""
import importlib.util
import os
import sys

import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

spec = importlib.util.spec_from_file_location("xt", "tools/extract-overlays-v4.py")
xt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xt)

FS = 92
SHAPES = ["short", "ponytail", "long", "afro", "dreads"]
EAST = ["south", "south-east", "east", "north-east", "north"]
MIRROR = {"west": "east", "north-west": "north-east", "south-west": "south-east"}
ANIMS = {"walk": 6, "idle": 4, "run": 6, "jump": 9}
SC = ("C:/Users/gabri/AppData/Local/Temp/claude/"
      "C--Users-gabri-OneDrive-Documents-Crazy-Stuff-crazy-stuff/"
      "abff873f-86cd-4c77-96a4-b8a760241d67/scratchpad")
BODY = "src/client/public/sprites/characters/{g}"
OUT = "src/client/public/sprites/equipment/hair/{item}/{g}"


def load(p):
    return np.asarray(Image.open(p).convert("RGBA")).astype(np.int16)


def head_anchor(frame):
    hr = xt.head_region(frame)
    if not hr.any():
        return None
    ys, xs = np.nonzero(hr)
    return np.array([xs.mean(), ys.mean()])


def isolate_hair(rot):
    """Blue hair (+ its dark outline) of a rotation, despeckled."""
    r, g, b = rot[..., 0], rot[..., 1], rot[..., 2]
    a = rot[..., 3] > 16
    lum = (r + g + b) / 3.0
    m = a & (((b > r + 12) & (b > 60)) | ((lum < 34) & (b >= r)))
    m = xt.components_keep(m, 6)
    out = np.zeros_like(rot)
    out[m] = rot[m]
    return out


def coverage_fill(ov, base):
    """Cover baked base-hair peeking at the hairline; never touch the throat."""
    hr = xt.head_region(base)
    fr = xt.face_region(base)
    r, g, b = base[..., 0], base[..., 1], base[..., 2]
    lum = (r + g + b) / 3.0
    hairish = (r > b + 12) & (r >= g) & (lum > 22) & (lum < 150)
    baked = hr & ~fr & (base[..., 3] > 8) & hairish
    if fr.any():
        fy, fx = np.nonzero(fr)
        chin, cx = int(fy.max()), int(fx.mean())
        baked[chin:min(FS, chin + 12), max(0, cx - 7):min(FS, cx + 8)] = False
    op = ov[..., 3] > 8
    out = ov.copy()
    todo = baked & ~op
    if todo.any() and op.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~op, return_indices=True)
        ys, xs = np.nonzero(todo)
        out[ys, xs] = out[iy[ys, xs], ix[ys, xs]]
    return out


def run(item):
    shape = item[len("hair_"):]
    for g in ["male", "female"]:
        canon = {}
        a0 = {}
        for d in EAST:
            rot = load(f"{SC}/allrot/{shape}_{g}_{d}.png")
            canon[d] = isolate_hair(rot)
            a0[d] = head_anchor(load(f"{SC}/baserot/{g}_{d}.png"))
        os.makedirs(OUT.format(item=item, g=g), exist_ok=True)
        for anim, nf in ANIMS.items():
            for d in EAST:
                bods = load(BODY.format(g=g) + f"/{anim}_{d}.png")
                out = np.zeros((FS, FS * nf, 4), dtype=np.int16)
                for i in range(nf):
                    body = bods[:, i * FS:(i + 1) * FS]
                    af = head_anchor(body)
                    if af is None or a0[d] is None:
                        continue
                    fr_ = xt.shift_rgba(canon[d], int(round(af[0] - a0[d][0])),
                                        int(round(af[1] - a0[d][1])))
                    out[:, i * FS:(i + 1) * FS] = coverage_fill(fr_, body)
                xt.save_rgba(out, OUT.format(item=item, g=g) + f"/{anim}_{d}.png")
            # mirror east → west files (engine flips east for west facings)
            for dst, src in MIRROR.items():
                ImageOps.mirror(Image.open(OUT.format(item=item, g=g) + f"/{anim}_{src}.png")) \
                    .save(OUT.format(item=item, g=g) + f"/{anim}_{dst}.png")
        print(f"  {item} {g}: built from rotations")


if __name__ == "__main__":
    todo = sys.argv[1:] or [f"hair_{s}" for s in SHAPES]
    for it in todo:
        run(it)
    print("DONE — hair rebuilt from rotations")
