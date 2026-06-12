"""Replicate conform_to_body step by step for one frame and visualize which
pixels each phase contributes.

Usage: python tools/diag-steps.py <body> <item> <anim> <dir> <frame> [zoom]
Colors: grey=clip survivors, yellow=closing, green=grow-down, cyan=grow-up,
magenta=edge ring. Red overlay = legs-mask body pixels that ended up bare.
"""
import importlib.util
import sys

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("x3", "tools/extract-overlays-v3.py")
x3 = importlib.util.module_from_spec(spec)
sys.modules["x3"] = x3
spec.loader.exec_module(x3)

body, item, anim, dr, fi = sys.argv[1:6]
fi = int(fi)
zoom = int(sys.argv[6]) if len(sys.argv) > 6 else 6
cfg = x3.ITEMS[item]
FS = x3.FS

palette = x3.learn_garment_palette(body, item, cfg)
body_pal = x3.body_palette_of(body)
base = x3.base_frame(body, anim, dr, fi)
xfer = x3.xfer_frame(body, item, anim, dr, fi)
frame = x3.extract(base, xfer, palette, cfg)

bodym = base[..., 3] > 8
bodyd = x3.dilate1(x3.dilate1(bodym))
orig = frame.copy()
out = frame.copy()
keep = (out[..., 3] > 8) & bodyd
out[~keep] = 0
clip = out[..., 3] > 8

ys0 = np.nonzero(keep.any(axis=1))[0]
occl = x3.arm_occlusion(xfer, body_pal, int(ys0.min()), int(ys0.max()))

for _ in range(2):
    a = out[..., 3] > 8
    for y in range(FS):
        xs = np.nonzero(a[y])[0]
        for i in range(len(xs) - 1):
            x1, x2 = xs[i], xs[i + 1]
            if 1 < x2 - x1 <= 4:
                for x in range(x1 + 1, x2):
                    if bodym[y, x] and not a[y, x] and not occl[y, x]:
                        out[y, x] = out[y, x1]
    a = out[..., 3] > 8
    for x in range(FS):
        ys = np.nonzero(a[:, x])[0]
        for i in range(len(ys) - 1):
            y1, y2 = ys[i], ys[i + 1]
            if 1 < y2 - y1 <= 4:
                for y in range(y1 + 1, y2):
                    if bodym[y, x] and not a[y, x] and not occl[y, x]:
                        out[y, x] = out[y1, x]
closed = out[..., 3] > 8

a = out[..., 3] > 8
ys_any = np.nonzero(a.any(axis=1))[0]
y_top, y_hem = int(ys_any.min()), int(ys_any.max())
legs = x3.legs_mask_of(bodym, y_top, y_hem)
hand_px = a & bodym & ~legs
out[hand_px] = 0
a = out[..., 3] > 8

down = np.zeros((FS, FS), dtype=bool)
for y in range(y_top + 1, y_hem + 1):
    above = a[y - 1]
    row_src = (above | np.roll(above, 1) | np.roll(above, -1)
               | np.roll(above, 2) | np.roll(above, -2))
    for x in np.nonzero(row_src & legs[y] & ~a[y] & ~occl[y])[0]:
        for sx in (x, x - 1, x + 1, x - 2, x + 2):
            if 0 <= sx < FS and above[sx]:
                break
        out[y, x] = out[y - 1, sx]
        a[y, x] = True
        down[y, x] = True

up = np.zeros((FS, FS), dtype=bool)
for y in range(y_hem - 1, y_top - 1, -1):
    below = a[y + 1]
    row_src = (below | np.roll(below, 1) | np.roll(below, -1)
               | np.roll(below, 2) | np.roll(below, -2))
    for x in np.nonzero(row_src & legs[y] & ~a[y] & ~occl[y])[0]:
        for sx in (x, x - 1, x + 1, x - 2, x + 2):
            if 0 <= sx < FS and below[sx]:
                break
        out[y, x] = out[y + 1, sx]
        a[y, x] = True
        up[y, x] = True

ring = x3.dilate1(a) & (orig[..., 3] > 8) & ~a & bodyd & ~(bodym & ~legs)

print(f"y_top={y_top} y_hem={y_hem} clip={int(clip.sum())} "
      f"closed=+{int((closed & ~clip).sum())} hand_strip=-{int(hand_px.sum())} "
      f"down=+{int(down.sum())} up=+{int(up.sum())} ring=+{int(ring.sum())}")
zone = np.zeros((FS, FS), dtype=bool)
zone[y_top:y_hem + 1, :] = True
bare = legs & zone & ~a & ~ring
print(f"bare legs px remaining: {int(bare.sum())}")

img = np.zeros((FS, FS, 4), dtype=np.uint8)
img[..., :] = (25, 25, 25, 255)
img[bodym] = (70, 70, 70, 255)
img[clip] = (150, 150, 150, 255)
img[closed & ~clip] = (220, 210, 60, 255)
img[down] = (70, 200, 70, 255)
img[up] = (60, 200, 200, 255)
img[ring] = (200, 70, 200, 255)
img[bare] = (220, 50, 50, 255)
big = Image.fromarray(img, "RGBA").resize((FS * zoom, FS * zoom), Image.NEAREST)
out_p = f"tools/preview-output/steps_{body}_{anim}_{dr}_f{fi}.png"
big.save(out_p)
print(out_p)
