"""Verify generated STATE frames BEFORE extraction — catches the two
generation-lottery failures a human otherwise finds in-game:

  WRONGDIR  the frame's head best-matches a different direction's template
            (e.g. a north-facing frame baked into a south walk — reads as
            "the jacket is backwards" mid-cycle)
  NOSLEEVE  long-sleeve garment coverage collapsed on this frame (bare-arm
            vest instead of sleeves) — measured as garment-colored px count
            vs the anim's own median, so it adapts to any design

Usage:
  python tools/verify-state-frames.py <state_dir> [--min-ratio 0.6]
Exit 1 if any frame is flagged. Feed flagged lines to extract-overlays-v4
--bad-list (after reformatting) or re-roll the animation.
"""
import glob
import importlib.util
import os
import re
import sys

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location(
    "x4", os.path.join(os.path.dirname(__file__), "extract-overlays-v4.py"))
x4 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x4)

state_dir = sys.argv[1]
min_ratio = 0.6
if "--min-ratio" in sys.argv:
    min_ratio = float(sys.argv[sys.argv.index("--min-ratio") + 1])

FS = x4.FS


def head_dir(frame):
    """Best-matching head-template direction for this frame."""
    op = frame[..., 3] > 8
    rgb = frame[..., :3].astype(np.int32)
    best = (1e18, None)
    for tpl in x4._head_templates():
        tm, trgb = tpl["mask"], tpl["rgb"]
        th, tw = tm.shape
        tn = int(tm.sum())
        loc, lyx = 1e18, None
        for y in range(0, FS - th + 1, 2):
            for x in range(0, FS - tw + 1, 2):
                wop = op[y:y + th, x:x + tw]
                valid = tm & wop
                nv = int(valid.sum())
                if nv < tn * 0.6:
                    continue
                d = np.abs(rgb[y:y + th, x:x + tw] - trgb)[valid].mean()
                s = d + (1.0 - nv / tn) * 80.0
                if s < loc:
                    loc, lyx = s, (y, x)
        if lyx and loc < best[0]:
            best = (loc, tpl["dir"])
    return best[1]


def garment_px(frame):
    """Non-skin, non-hair opaque px = garment mass (colour-agnostic)."""
    op = frame[..., 3] > 8
    r = frame[..., 0].astype(np.int32)
    g = frame[..., 1].astype(np.int32)
    b = frame[..., 2].astype(np.int32)
    lum = (r + g + b) / 3.0
    skin = (r - b > 40) & (r > 130) & (lum > 100)
    hair = (r >= g) & (r - b > 10) & (r - b < 100) & (lum < 168)
    return int((op & ~skin & ~hair).sum())


# adjacency for direction tolerance (head match on diagonals is fuzzy)
ADJ = {
    "south": {"south", "south-east", "south-west"},
    "south-east": {"south-east", "south", "east"},
    "east": {"east", "south-east", "north-east"},
    "north-east": {"north-east", "north", "east"},
    "north": {"north", "north-east", "north-west"},
    "north-west": {"north-west", "north", "west"},
    "west": {"west", "north-west", "south-west"},
    "south-west": {"south-west", "south", "west"},
}

flags = []
by_anim_dir = {}
for p in sorted(glob.glob(os.path.join(state_dir, "*_f*.png"))):
    m = re.match(r"(\w+)_([a-z-]+)_f(\d+)\.png", os.path.basename(p))
    if not m:
        continue
    by_anim_dir.setdefault((m.group(1), m.group(2)), []).append(
        (int(m.group(3)), p))

for (anim, d), lst in sorted(by_anim_dir.items()):
    lst.sort()
    counts = []
    for fi, p in lst:
        fr = np.asarray(Image.open(p).convert("RGBA"))
        counts.append(garment_px(fr))
        hd = head_dir(fr)
        if hd is not None and hd not in ADJ.get(d, {d}):
            flags.append(f"{anim} {d} f{fi}: WRONGDIR (head reads {hd})")
    med = sorted(counts)[len(counts) // 2]
    for (fi, p), c in zip(lst, counts):
        if med > 60 and c < med * min_ratio:
            flags.append(f"{anim} {d} f{fi}: NOSLEEVE/DROPOUT "
                         f"(garment {c} vs median {med})")

print(f"STATE VERIFY {state_dir}: {len(flags)} flagged")
for f in flags:
    print(" ", f)
sys.exit(1 if flags else 0)
