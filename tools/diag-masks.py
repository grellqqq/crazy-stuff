"""Visualize conform_to_body's masks for one frame.

Usage: python tools/diag-masks.py <body> <item> <anim> <dir> <frame> [zoom]
Panels: base | legs(green)/non-leg-body(red) | occl raw(yellow)/kept(orange)
        | extracted pre-conform | final overlay
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
zoom = int(sys.argv[6]) if len(sys.argv) > 6 else 5
cfg = x3.ITEMS[item]
FS = x3.FS

palette = x3.learn_garment_palette(body, item, cfg)
body_pal = x3.body_palette_of(body)
base = x3.base_frame(body, anim, dr, fi)
xfer = x3.xfer_frame(body, item, anim, dr, fi)

pre = x3.extract(base, xfer, palette, cfg)
fin = x3.conform_to_body(pre, base, palette, xfer, body_pal)

bodym = base[..., 3] > 8
keep = (pre[..., 3] > 8) & x3.dilate1(x3.dilate1(bodym))
ys0 = np.nonzero(keep.any(axis=1))[0]
y_top = int(ys0.min()) if len(ys0) else 0
a_fin = fin[..., 3] > 8
ys_f = np.nonzero(a_fin.any(axis=1))[0]
y_hem = int(ys_f.max()) if len(ys_f) else FS - 1
legs = x3.legs_mask_of(bodym, y_top, y_hem)
ys_k = np.nonzero(keep.any(axis=1))[0]
occl_raw = x3.skin_over_garment(xfer, body_pal)
occl_kept = x3.arm_occlusion(xfer, body_pal, int(ys_k.min()), int(ys_k.max())) \
    if len(ys_k) else occl_raw

def tint(mask_colors):
    img = np.zeros((FS, FS, 4), dtype=np.uint8)
    img[..., :] = (30, 30, 30, 255)
    for mask, col in mask_colors:
        img[mask] = col
    return img

p_legs = tint([(bodym & ~legs, (200, 60, 60, 255)), (legs, (60, 200, 60, 255))])
p_occl = tint([(occl_raw, (220, 220, 60, 255)), (occl_kept, (240, 140, 30, 255))])

def comp(fr):
    return np.asarray(Image.alpha_composite(
        Image.fromarray(base.astype(np.uint8), "RGBA"),
        Image.fromarray(fr.astype(np.uint8), "RGBA")))

panels = [base.astype(np.uint8), p_legs, p_occl, comp(pre), comp(fin)]
W = FS * len(panels) + 4 * (len(panels) - 1)
canvas = Image.new("RGBA", (W, FS), (255, 255, 255, 255))
for i, p in enumerate(panels):
    canvas.paste(Image.fromarray(p, "RGBA"), (i * (FS + 4), 0))
canvas = canvas.resize((canvas.width * zoom, canvas.height * zoom), Image.NEAREST)
out = f"tools/preview-output/masks_{body}_{anim}_{dr}_f{fi}.png"
canvas.save(out)
print(out, f"y_top={y_top} y_hem={y_hem}")
