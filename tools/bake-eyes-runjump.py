"""Bake FEMALE eyewear overlays by head-locking the approved MALE walk art.

Gabriel-verified: male eyewear is correct in all movements; female is
misaligned, worst on run. Same root cause as the masks — the female run/jump
choreography differs from the male's (head up to 13px away on jump), so any
male-fitted sheet drifts on her. Same cure as the masks (user-approved there):

  female/walk+idle = the approved male sheets, copied verbatim (walk head
                     positions match within ~1px between the bodies);
  female/run+jump  = the fullest frame of the male WALK overlay, translated to
                     the FEMALE body's measured head anchor per frame
                     (template-matched head_region — includes the back views,
                     so the strap/temple content rides her head from behind).

MALE files are never touched — his art is approved as-is.

Usage: python tools/bake-eyes-runjump.py
"""
import importlib.util
import os
import shutil

import numpy as np
from PIL import Image, ImageOps

spec = importlib.util.spec_from_file_location("xt", "tools/extract-overlays-v4.py")
xt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xt)

FS = 92
ITEMS = ["sunglasses", "round_glasses", "nerd_glasses", "aviators",
         "3d_glasses", "eyepatch"]
NATIVE = ["south", "south-east", "east", "north-east", "north"]
MIRROR = {"west": "east", "north-west": "north-east", "south-west": "south-east"}
TARGET_ANIMS = {"run": 6, "jump": 9}
BODY = "src/client/public/sprites/characters/{g}"
EQ = "src/client/public/sprites/equipment/eyes_accessory/{item}/{g}"


def sheet_frames(path, n):
    a = np.asarray(Image.open(path).convert("RGBA")).astype(np.int16)
    assert a.shape[1] == FS * n, f"{path}: width {a.shape[1]} != {FS*n}"
    return [a[:, i * FS:(i + 1) * FS] for i in range(n)]


def head_anchor(frame):
    hr = xt.head_region(frame)
    if not hr.any():
        return None
    ys, xs = np.nonzero(hr)
    return np.array([xs.mean(), ys.mean()])


checks = []
for item in ITEMS:
    male_dir = EQ.format(item=item, g="male")
    fem_dir = EQ.format(item=item, g="female")
    os.makedirs(fem_dir, exist_ok=True)
    # 1) female walk/idle = approved male sheets, verbatim
    for anim in ("walk", "idle"):
        for d in NATIVE + list(MIRROR):
            src = f"{male_dir}/{anim}_{d}.png"
            if os.path.exists(src):
                shutil.copyfile(src, f"{fem_dir}/{anim}_{d}.png")
    # 2) female run/jump = head-locked male walk canonical (back views included)
    for d in NATIVE:
        wov = sheet_frames(f"{male_dir}/walk_{d}.png", 6)
        counts = [(f[..., 3] > 8).sum() for f in wov]
        ci = int(np.argmax(counts))
        canon = wov[ci]
        canon_px = int(counts[ci])
        fwalk = sheet_frames(BODY.format(g="female") + f"/walk_{d}.png", 6)
        a0 = head_anchor(fwalk[ci])
        for anim, nf in TARGET_ANIMS.items():
            body = sheet_frames(BODY.format(g="female") + f"/{anim}_{d}.png", nf)
            out = np.zeros((FS, FS * nf, 4), dtype=np.int16)
            for i in range(nf):
                lbl = f"{item} female {anim}_{d} f{i+1}"
                if canon_px == 0 or a0 is None:
                    checks.append((lbl, True, "empty canonical"))
                    continue
                af = head_anchor(body[i])
                if af is None:
                    checks.append((lbl, False, "no head anchor"))
                    continue
                fr = xt.shift_rgba(canon, int(round(af[0] - a0[0])),
                                   int(round(af[1] - a0[1])))
                out[:, i * FS:(i + 1) * FS] = fr
                kept = int((fr[..., 3] > 8).sum())
                checks.append((lbl, kept >= 0.95 * canon_px,
                               f"px {kept}/{canon_px}"))
            xt.save_rgba(out, f"{fem_dir}/{anim}_{d}.png")
    for anim in TARGET_ANIMS:
        for dst, src in MIRROR.items():
            ImageOps.mirror(Image.open(f"{fem_dir}/{anim}_{src}.png")) \
                .save(f"{fem_dir}/{anim}_{dst}.png")
    print(f"baked {item} (female)")

bad = [c for c in checks if not c[1]]
print(f"\nframes checked: {len(checks)}  FAIL: {len(bad)}")
for lbl, _, det in bad:
    print(f"  FAIL {lbl}: {det}")
