"""Head transplant for the male jump_north / jump_north-east BASE body sheets.

PixelLab generated those two jump sheets with FACE-VISIBLE heads (blue eye
showing) while every other north-facing anim (walk/run/idle) uses a back-view
head — in motion the head appears to flash to a wrong direction mid-jump
(user report: "jumping on WD flashes the head in a wrong direction"; WD/WA
both render the north-east sheet).

Fix: replace the head on every jump frame with the back-view head from the
same direction's run_f1, crown-aligned per frame (jump translates the body
vertically). The garment overlays are untouched — they carry no head pixels.

Also rebuilds the game's character strip sheets for the patched directions.
Run tools/recolor-skin.py afterwards to refresh the medium/dark tone bodies.

Usage: python tools/fix-jump-heads.py
"""
import os
import shutil

import numpy as np
from PIL import Image

FS = 92
BODY = "male"
DIRS = ["north", "north-east"]
BASE = f"tools/pixellab-downloads/v2/base-{BODY}-frames"
CHAR_SHEET = f"src/client/public/sprites/characters/{BODY}"
BOX_H = 21          # rows below the crown to replace (hair+face, above shoulders)
BOX_W = 15          # half-width around the crown centre

def crown(arr):
    op = arr[..., 3] > 8
    ys, xs = np.nonzero(op)
    t = int(ys.min())
    row = op[t:t + 5, :]
    cxs = np.nonzero(row.any(axis=0))[0]
    return t, (int(np.median(cxs)) if len(cxs) else FS // 2)

def load(p):
    return np.asarray(Image.open(p).convert("RGBA")).copy()

for d in DIRS:
    donor = load(f"{BASE}/run_{d}_f1.png")
    t_d, cx_d = crown(donor)
    dy0, dy1 = t_d, min(FS, t_d + BOX_H)
    dx0, dx1 = max(0, cx_d - BOX_W), min(FS, cx_d + BOX_W + 1)
    head = donor[dy0:dy1, dx0:dx1]

    frames = []
    for f in range(1, 10):
        p = f"{BASE}/jump_{d}_f{f}.png"
        bak = p + ".pre-headfix.bak"
        if not os.path.exists(bak):
            shutil.copy(p, bak)
        tgt = load(bak)  # always patch from the pristine original
        t_t, cx_t = crown(tgt)
        h = dy1 - dy0
        w = dx1 - dx0
        ty0 = t_t
        ty1 = min(FS, ty0 + h)
        tx0 = max(0, cx_t - BOX_W)
        tx1 = min(FS, tx0 + w)
        tgt[ty0:ty1, tx0:tx1] = head[: ty1 - ty0, : tx1 - tx0]
        Image.fromarray(tgt, "RGBA").save(p)
        frames.append(tgt)
        print(f"  jump_{d} f{f}: head <- run_{d}_f1 (crown {t_t},{cx_t})")

    sheet = np.zeros((FS, FS * 9, 4), dtype=np.uint8)
    for i, fr in enumerate(frames):
        sheet[:, i * FS:(i + 1) * FS] = fr
    out = f"{CHAR_SHEET}/jump_{d}.png"
    shutil.copy(out, out + ".pre-headfix.bak") if not os.path.exists(out + ".pre-headfix.bak") else None
    Image.fromarray(sheet, "RGBA").save(out)
    print(f"  rebuilt {out}")
print("DONE — now run: python tools/recolor-skin.py")
