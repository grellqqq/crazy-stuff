"""Remove the white hand/wrist patches from the base body sheets.

The April base generation drew white wraps on the hands in SOME walk/run/
jump frames only — in motion they flash as white squares crossing the
belly/hips (the bug v3's denim-mitten defect accidentally masked).

Rule: a white component (lum>215, sat<25) that lies fully within rows
42-78, is smaller than 55px, and is adjacent to skin gets recolored to its
neighbouring skin tone. The briefs are a larger central component and the
bra sits above row 42 — both untouched.

Applies to the in-game strips (sprites/characters/<body>) and re-slices
the v2 extraction frames afterwards.

Usage: python tools/clean-base-hands.py [body ...]   (default: all six)
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image

FS = 92
BODIES = sys.argv[1:] or ["female", "male", "female-medium", "male-medium",
                          "female-dark", "male-dark"]


def fix_frame(fr):
    c = fr[..., :3].astype(np.int32)
    lum = c.mean(axis=2)
    sat = c.max(axis=2) - c.min(axis=2)
    op = fr[..., 3] > 8
    white = op & (lum > 215) & (sat < 25)
    skin = op & (c[..., 0] > c[..., 2] + 25) & (lum > 95) & (lum < 230)
    h, w = white.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    fixed = 0
    for sy in range(h):
        for sx in range(w):
            if white[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                comp = [(sy, sx)]
                labels[sy, sx] = cur
                k = 0
                while k < len(comp):
                    y, x = comp[k]
                    k += 1
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                        if 0 <= ny < h and 0 <= nx < w and white[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            comp.append((ny, nx))
                ys = [p[0] for p in comp]
                if min(ys) < 42 or max(ys) > 78:
                    continue
                # PIXEL-LEVEL briefs protection: hands may touch the briefs
                # and merge into one white component, so protect by POSITION —
                # white pixels in the central column band are underwear and
                # stay; lateral pixels (swinging hands/wrist wraps) recolor.
                comp = [(y, x) for (y, x) in comp
                        if not (39 <= x <= 53 and 44 <= y <= 66)]
                if not comp or len(comp) >= 80:
                    continue
                touches = any(
                    0 <= y+dy < h and 0 <= x+dx < w and skin[y+dy, x+dx]
                    for y, x in comp for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)))
                if not touches:
                    continue
                # recolor each px to nearest skin neighbour (few passes)
                todo = set(comp)
                for _ in range(6):
                    done = []
                    for (y, x) in list(todo):
                        for ny, nx in ((y-1,x),(y,x-1),(y,x+1),(y+1,x)):
                            if 0 <= ny < h and 0 <= nx < w and skin[ny, nx]:
                                fr[y, x, :3] = fr[ny, nx, :3]
                                skin[y, x] = True
                                done.append((y, x))
                                fixed += 1
                                break
                    todo -= set(done)
                    if not todo:
                        break
    return fixed


total = 0
for body in BODIES:
    root = f"src/client/public/sprites/characters/{body}"
    if not os.path.isdir(root):
        print(f"skip {body} (no dir)")
        continue
    btotal = 0
    for name in sorted(os.listdir(root)):
        if not name.endswith(".png"):
            continue
        p = os.path.join(root, name)
        img = Image.open(p).convert("RGBA")
        if img.height != FS or img.width % FS:
            continue
        arr = np.asarray(img).astype(np.int32).copy()
        n = img.width // FS
        fixed = 0
        for i in range(n):
            fixed += fix_frame(arr[:, i*FS:(i+1)*FS])
        if fixed:
            Image.fromarray(arr.astype(np.uint8), "RGBA").save(p)
            btotal += fixed
    print(f"{body}: recolored {btotal} px")
    total += btotal
print(f"TOTAL {total}px")
# re-slice extraction frames for light bodies
for b in ("female", "male"):
    subprocess.run([sys.executable, "tools/slice-base-frames.py", b], check=True,
                   capture_output=True)
print("v2 frames re-sliced")
