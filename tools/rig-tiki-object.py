"""Rig the CLEAN standalone tiki-mask OBJECT (PixelLab 8-dir, no head/hair) onto
the avatar. Gabriel 2026-07-30: extracting tiki from the character rotations was
unwinnable (tiki brown == hair brown). This uses a mask generated in isolation,
so there is no head to grab — it just gets scaled to head size and head-locked
onto every frame, per direction, for both genders.

Object rotations (68x68, transparent) live in scratchpad/tikiobj/<dir>.png.
Front/3-4/side show the face; north-east/north show the carved WOOD BACK, so the
mask reads correctly from behind too (no more "gone from behind").

Usage: python tools/rig-tiki-object.py [SCALE] [VOFF]   (defaults 0.5 0)
"""
import importlib.util
import sys
import numpy as np
from PIL import Image, ImageOps

spec = importlib.util.spec_from_file_location("xt", "tools/extract-overlays-v4.py")
xt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xt)

FS = 92
# The object is a tall totem (34w x 61h); the avatar head is ~21w x 26h. Scale X
# and Y independently to squish it back to face-like proportions.
SX = float(sys.argv[1]) if len(sys.argv) > 1 else 0.62
SY = float(sys.argv[2]) if len(sys.argv) > 2 else 0.42
# Bottom offset: the mask's CHIN is anchored to the avatar's chin; +BOFF nudges
# it down a hair. (Anchoring the chin, not the box-centre, keeps the mask ON the
# face instead of floating above it; the crown rises up naturally.)
BOFF = int(sys.argv[3]) if len(sys.argv) > 3 else 2
OBJ = ("C:/Users/gabri/AppData/Local/Temp/claude/"
       "C--Users-gabri-OneDrive-Documents-Crazy-Stuff-crazy-stuff/"
       "abff873f-86cd-4c77-96a4-b8a760241d67/scratchpad/tikiobj")
DIRS = ["south", "south-east", "east", "north-east", "north"]
MIRROR = {"west": "east", "north-west": "north-east", "south-west": "south-east"}
# The tiki is a full carved mask, visible from EVERY angle (Gabriel: an empty
# back is "stupid"). Back-facing sheets (north-east=WD/WA, north=W) show the
# carved WOOD BACK of the mask, chin-anchored like the rest so it sits ON the
# head (not floating on top, which was the old placement bug).
EMPTY = set()
# Per-direction (dx, dy) nudge, in east-sheet space (engine mirrors for the west
# facings, flipping dx automatically). south: recentre (+2 was too far right);
# south-east: drop it so it covers the chin; east: shove FORWARD so the nose
# doesn't poke in front of the profile.
OFF = {"south": (1, 0), "south-east": (2, 2), "east": (4, 0),
       "north-east": (0, 0), "north": (0, 0)}
ANIMS = {"walk": 6, "idle": 4, "run": 6, "jump": 9}
BODY = "src/client/public/sprites/characters/{g}"
EQ = "src/client/public/sprites/equipment/face_accessory/tiki_mask/{g}"


def load_mask(d):
    a = np.asarray(Image.open(f"{OBJ}/{d}.png").convert("RGBA"))
    op = a[..., 3] > 8
    ys, xs = np.nonzero(op)
    crop = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = crop.shape[:2]
    nw, nh = max(1, round(w * SX)), max(1, round(h * SY))
    im = Image.fromarray(crop.astype(np.uint8)).resize((nw, nh), Image.LANCZOS)
    arr = np.asarray(im).astype(np.int16).copy()
    arr[..., 3] = np.where(arr[..., 3] > 90, 255, 0)     # crisp alpha
    return arr


def face_anchor(f):
    """Return (x, chin_y) to hang the mask from. Prefer the FACE (front-shifted
    on side views, so the mask sits on the face not the head-centre); fall back
    to the head silhouette for the wood-back (no face) views."""
    fr = xt.face_region(f)
    if int(fr.sum()) >= 10:
        ys, xs = np.nonzero(fr)
        return np.array([xs.mean(), ys.max()])
    hr = xt.head_region(f)
    if not hr.any():
        return None
    ys, xs = np.nonzero(hr)
    return np.array([xs.mean(), ys.max()])


def blit(dst, m, cx, by):
    """Place mask m so its horizontal centre is cx and its BOTTOM row is by."""
    mh, mw = m.shape[:2]
    top = int(round(by - mh)); left = int(round(cx - mw / 2))
    for yy in range(mh):
        dy = top + yy
        if dy < 0 or dy >= FS:
            continue
        for xx in range(mw):
            dx = left + xx
            if dx < 0 or dx >= FS:
                continue
            if m[yy, xx, 3] > 8:
                dst[dy, dx] = m[yy, xx]


def run():
    masks = {d: load_mask(d) for d in DIRS}
    for g in ["male", "female"]:
        for anim, nf in ANIMS.items():
            for d in DIRS:
                bs = np.asarray(Image.open(f"{BODY.format(g=g)}/{anim}_{d}.png")
                                .convert("RGBA")).astype(np.int16)
                out = np.zeros((FS, FS * nf, 4), np.int16)
                if d not in EMPTY:
                    m = masks[d]; dx, dy = OFF.get(d, (0, 0))
                    for i in range(nf):
                        base = bs[:, i * FS:(i + 1) * FS]
                        af = face_anchor(base)
                        if af is None:
                            continue
                        cell = out[:, i * FS:(i + 1) * FS]
                        blit(cell, m, af[0] + dx, af[1] + BOFF + dy)
                xt.save_rgba(out, f"{EQ.format(g=g)}/{anim}_{d}.png")
            for dst, src in MIRROR.items():
                ImageOps.mirror(Image.open(f"{EQ.format(g=g)}/{anim}_{src}.png")) \
                    .save(f"{EQ.format(g=g)}/{anim}_{dst}.png")
        print(f"  tiki {g}: rigged from object (sx={SX} sy={SY} boff={BOFF})")


if __name__ == "__main__":
    run()
    print("DONE")
