"""Validate base-body anatomy separation: arms vs legs vs briefs/bra vs hair.

skin = warm AND (r-b)>=50 AND 85<=lum<=215   (excludes outlines, briefs/bra,
hair-browns; the dark 1px outline between overlapping limbs then splits
their components)

Usage: python tools/diag-anatomy.py <body> <anim> <dir> <frame> [zoom]
Panel: base | skin components colored (arm-side=red, leg-side=green,
       briefs/bra=white, other body=grey)
"""
import importlib.util
import sys

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("x3", "tools/extract-overlays-v3.py")
x3 = importlib.util.module_from_spec(spec)
sys.modules["x3"] = x3
spec.loader.exec_module(x3)

body, anim, dr, fi = sys.argv[1:5]
fi = int(fi)
zoom = int(sys.argv[5]) if len(sys.argv) > 5 else 6
FS = x3.FS
base = x3.base_frame(body, anim, dr, fi)

r = base[..., 0].astype(np.int32)
g = base[..., 1].astype(np.int32)
b = base[..., 2].astype(np.int32)
lum = (r + g + b) / 3.0
op = base[..., 3] > 8
skin = op & (r > g) & (g >= b) & ((r - b) >= 50) & (lum >= 85) & (lum <= 215)
briefs = op & (lum > 175) & ((np.maximum(np.maximum(r, g), b)
                              - np.minimum(np.minimum(r, g), b)) < 45) & ~skin

# briefs anchor: waist row = top of the biggest briefs blob in the lower half
ys_b, xs_b = np.nonzero(briefs)
waist = int(np.median(ys_b)) if len(ys_b) else 45
lower = ys_b[ys_b > FS * 0.35]
if len(lower):
    waist = int(lower.min())
print(f"waist(briefs top) = {waist}")

# label skin components
labels = np.zeros((FS, FS), dtype=np.int32)
cur = 0
comp_info = {}
for sy in range(FS):
    for sx in range(FS):
        if skin[sy, sx] and labels[sy, sx] == 0:
            cur += 1
            stack = [(sy, sx)]
            labels[sy, sx] = cur
            ymin, ymax, n = sy, sy, 0
            while stack:
                y, x = stack.pop()
                n += 1
                ymin = min(ymin, y)
                ymax = max(ymax, y)
                for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                    if 0 <= ny < FS and 0 <= nx < FS and skin[ny, nx] and labels[ny, nx] == 0:
                        labels[ny, nx] = cur
                        stack.append((ny, nx))
            comp_info[cur] = (ymin, ymax, n)

img = np.zeros((FS, FS, 4), dtype=np.uint8)
img[...] = (25, 25, 25, 255)
img[op] = (90, 90, 90, 255)
img[briefs] = (240, 240, 240, 255)
for cid, (ymin, ymax, n) in comp_info.items():
    m = labels == cid
    if ymin < waist - 4:           # reaches well above the waist: arm/head side
        img[m] = (220, 60, 60, 255)
    else:                          # starts at/below waist: leg side
        img[m] = (60, 210, 60, 255)
    kind = "ARM/HEAD" if ymin < waist - 4 else "LEG"
    print(f"  comp {cid}: rows {ymin}-{ymax} n={n} -> {kind}")

panel = np.concatenate([base.astype(np.uint8), img], axis=1)
big = Image.fromarray(panel, "RGBA").resize((panel.shape[1]*zoom, panel.shape[0]*zoom), Image.NEAREST)
out = f"tools/preview-output/anatomy_{body}_{anim}_{dr}_f{fi}.png"
big.save(out)
print(out)
