"""Gas mask: colour-capture extraction (grey, not diff).

The grey gas mask is too close to skin/shadow for the diff to separate cleanly
(gaps) and face_replace bakes the head in (male head on female). Instead: in the
head band, keep the masked character's NON-brown pixels — the gas mask is grey/
desaturated, the character's hair/skin is warm brown, so this grabs the complete
mask and nothing of the head. No baked hair, no cutting.

Writes gas_mask/male/{walk,idle}_{dir}.png for all 8 directions (5 native + 3
mirrored), matching the extractor's output layout.
"""
import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

FS = 92
NATIVE = ["south", "south-east", "east", "north-east", "north"]
MIRROR = {"south-west": "south-east", "west": "east", "north-west": "north-east"}
# WALK/IDLE ONLY: run/jump gas sheets are BAKED (head-locked walk mask) by
# tools/bake-mask-runjump.py — raw capture has no pose alignment, so run/jump
# capture floats off the head. Never re-add run/jump here.
ANIMS = {"walk": 6, "idle": 4}
BAND = (14, 40)
BANDS = {"walk": (14, 40), "idle": (14, 40)}
STATE = "tools/pixellab-downloads/v4/gas_mask-male"
OUT = "src/client/public/sprites/equipment/face_accessory/gas_mask/male"


def load(p):
    return np.asarray(Image.open(p).convert("RGBA")).astype(int)


def capture(masked, band=BAND):
    R, G, B = masked[..., 0], masked[..., 1], masked[..., 2]
    a = masked[..., 3] > 16
    reg = np.zeros(masked.shape[:2], bool)
    reg[band[0]:band[1], :] = True
    brown = (R > B + 14) & (R > G + 2) & (G > B + 2)   # hair/skin
    keep = a & reg & ~brown
    lbl, n = ndimage.label(keep)
    if n:
        for i in range(1, n + 1):
            if (lbl == i).sum() < 6:
                keep[lbl == i] = False
    ov = np.zeros_like(masked)
    ov[keep] = masked[keep]
    return ov.astype(np.uint8)


for anim, nf in ANIMS.items():
    # native directions
    for d in NATIVE:
        sheet = np.zeros((FS, FS * nf, 4), dtype=np.uint8)
        for i in range(nf):
            s = load(f"{STATE}/{anim}_{d}_f{i+1}.png")
            sheet[:, i * FS:(i + 1) * FS] = capture(s, BANDS[anim])
        Image.fromarray(sheet, "RGBA").save(f"{OUT}/{anim}_{d}.png")
    # mirror the west-side directions from their east-side counterparts
    for dst, src in MIRROR.items():
        Image.fromarray(np.asarray(ImageOps.mirror(Image.open(f"{OUT}/{anim}_{src}.png"))), "RGBA") \
            .save(f"{OUT}/{anim}_{dst}.png")
print("gas mask re-extracted (grey colour-capture, no baked head, no cutting)")
