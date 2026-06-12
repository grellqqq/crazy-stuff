"""Remove red wrong-garment artifacts from the base body sheets.

The medium-body base generations drew red costume pieces (boxing-glove
hands, boots, sports tops, arm sleeves) on MANY anim frames — the same
class of bug as the April white hand-wraps that clean-base-hands.py fixed.
In-game these flash as a red outfit on the bare body, and the garment
states inherited the corruption (handled separately via the extractor's
force-borrow).

Rule: a red pixel (r>100, r>g+60, r>b+80) below row 32 (lips/face stay)
gets recolored to its nearest non-red, non-outline neighbour over a few
flood passes — red boots become skin, red patches over underwear pick up
the underwear colour from adjacent pixels.

Applies to the in-game strips (sprites/characters/<body>) and re-slices
the v2 extraction frames afterwards.

Usage: python tools/clean-base-red.py [body ...]   (default: the 4 med/dark)
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image

FS = 92
BODIES = sys.argv[1:] or ["female-medium", "male-medium",
                          "female-dark", "male-dark"]
FACE_ROW = 33  # red above this row is lips/face detail — untouched


def fix_frame(fr, aggressive=False):
    c = fr[..., :3].astype(np.int32)
    op = fr[..., 3] > 8
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    # bright red (gloves/tops) OR deep crimson (boot shading — green channel
    # near zero, which warm skin shadows never have)
    red = op & (((r > 100) & (r > g + 60) & (r > b + 80)) |
                ((r > 60) & (g < 35) & (r > g + 40) & (b < 70)))
    if aggressive:
        # DISABLED: a mid-tone maroon rule ((g < r*0.6) etc.) was tried here
        # and washed out medium-skin shading — the mid maroons overlap real
        # skin shadow tones too closely for a colour rule. Residual maroon
        # on a few east/west run/jump frames is a documented known-issue;
        # the real fix is regenerating the medium base animations.
        pass
    red[:FACE_ROW, :] = False
    if not red.any():
        return 0
    lum = c.mean(axis=2)
    donor = op & ~red & (lum > 50)  # exclude the black outline as a source
    fixed = 0
    todo = {(int(y), int(x)) for y, x in zip(*np.nonzero(red))}
    for _ in range(30):
        done = []
        for (y, x) in list(todo):
            for ny, nx in ((y - 1, x), (y, x - 1), (y, x + 1), (y + 1, x)):
                if 0 <= ny < FS and 0 <= nx < FS and donor[ny, nx]:
                    fr[y, x, :3] = fr[ny, nx, :3]
                    donor[y, x] = True
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
            fixed += fix_frame(arr[:, i * FS:(i + 1) * FS],
                               aggressive=body.endswith("-medium"))
        if fixed:
            Image.fromarray(arr.astype(np.uint8), "RGBA").save(p)
            btotal += fixed
    print(f"{body}: recolored {btotal} px")
    total += btotal
print(f"TOTAL {total}px")
for b in BODIES:
    subprocess.run([sys.executable, "tools/slice-base-frames.py", b],
                   check=True, capture_output=True)
print("v2 frames re-sliced")
