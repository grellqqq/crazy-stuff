"""Generate medium/dark skin-tone body variants by recoloring the LIGHT bodies.

Replaces the per-tone distinct characters (whose generated animations came
back corrupted — frozen garments, gap flashes, red costume artifacts) with
palette-swapped copies of the QA-clean light bodies. Because the silhouette
is then IDENTICAL to the light body, the light bodies' equipment overlays
fit every tone pixel-for-pixel — no per-tone garment generation ever again.
Hairstyle/build variety returns later as a hair equipment slot.

How it works:
  1. Collect every opaque color across all of a light body's strips.
  2. Classify "skin" by the peachy signature (r-b >= 45, r-g >= 28, lum >= 85)
     — hair, outline, underwear greys, eyes and deep shadows don't match and
     are left untouched (dark-brown shadows read naturally under any tone).
  3. Map each skin color onto the target tone ramp by normalized luminance
     position, preserving the shading structure.
  4. Write recolored strips to src/client/public/sprites/characters/<target>.

Target ramps are sampled from the previous medium/dark art so the chosen
skin tones stay; ramps are interpolated in RGB for in-between shades.

Usage: python tools/recolor-skin.py            # all four variants
       python tools/recolor-skin.py female-medium ...
"""
import os
import sys

import numpy as np
from PIL import Image

FS = 92
CHAR_ROOT = "src/client/public/sprites/characters"

# source light body for each target variant
SOURCE = {
    "female-medium": "female", "female-dark": "female",
    "male-medium": "male", "male-dark": "male",
}

# Skin ramps sampled from the previous med/dark base art (dark -> light).
RAMPS = {
    # Tan midpoint between light and dark. The dominant skin pixel maps to the
    # ramp HIGHLIGHT (ramp[-1]); that value is the whole tone-separation lever.
    # Light highlight ≈ lum 210, dark ≈ 122; medium highlight targets ≈ 167 so
    # it reads clearly between both. (First sample lum 154 → too dark; second
    # lum 192 → too close to light. This one is centered.)
    "medium": [(100, 58, 46), (120, 72, 55), (140, 88, 68), (158, 102, 80),
               (174, 116, 92), (188, 130, 104), (200, 142, 114),
               (210, 150, 120), (218, 158, 126)],
    # Deepened 2026-06-13: previous highlight lum 122 → dominant ~116 read too
    # light. Lowered highlight to lum ~90 for a rich, clearly-dark brown.
    "dark":   [(46, 24, 20), (57, 31, 25), (69, 39, 32), (81, 47, 38),
               (92, 55, 44), (102, 62, 50), (110, 68, 55), (118, 74, 60),
               (126, 80, 64)],
}


def is_skin(r, g, b):
    lum = (r + g + b) / 3
    return (r - b >= 45) and (r - g >= 28) and (lum >= 85)


def ramp_color(ramp, t):
    """Interpolated color at normalized position t in [0,1] along the ramp."""
    pos = t * (len(ramp) - 1)
    i = int(pos)
    if i >= len(ramp) - 1:
        return ramp[-1]
    f = pos - i
    a, b = ramp[i], ramp[i + 1]
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


def build_mapping(src_dir, ramp):
    """Map every distinct skin color in the source body to the target ramp."""
    colors = set()
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".png"):
            continue
        a = np.asarray(Image.open(os.path.join(src_dir, name)).convert("RGBA"))
        op = a[..., 3] > 8
        for r, g, b in {tuple(c) for c in a[op][:, :3]}:
            colors.add((int(r), int(g), int(b)))
    skin = sorted((c for c in colors if is_skin(*c)),
                  key=lambda c: sum(c))
    if not skin:
        raise SystemExit(f"no skin colors classified in {src_dir}")
    lums = [sum(c) / 3 for c in skin]
    lo, hi = min(lums), max(lums)
    span = max(1.0, hi - lo)
    mapping = {c: ramp_color(ramp, (sum(c) / 3 - lo) / span) for c in skin}
    return mapping, skin


def recolor_body(target):
    src = SOURCE[target]
    tone = "medium" if target.endswith("-medium") else "dark"
    src_dir = os.path.join(CHAR_ROOT, src)
    dst_dir = os.path.join(CHAR_ROOT, target)
    os.makedirs(dst_dir, exist_ok=True)
    mapping, skin = build_mapping(src_dir, RAMPS[tone])
    print(f"{target}: {len(skin)} skin shades mapped from {src} "
          f"(lum {sum(skin[0])//3}..{sum(skin[-1])//3})")
    lut = {}
    n_files = 0
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".png"):
            continue
        img = Image.open(os.path.join(src_dir, name)).convert("RGBA")
        a = np.asarray(img).astype(np.uint8).copy()
        op = a[..., 3] > 8
        ys, xs = np.nonzero(op)
        for y, x in zip(ys, xs):
            key = (a[y, x, 0], a[y, x, 1], a[y, x, 2])
            if key in lut:
                rep = lut[key]
            else:
                rep = mapping.get((int(key[0]), int(key[1]), int(key[2])))
                lut[key] = rep
            if rep is not None:
                a[y, x, 0], a[y, x, 1], a[y, x, 2] = rep
        Image.fromarray(a, "RGBA").save(os.path.join(dst_dir, name))
        n_files += 1
    print(f"  {n_files} strips written to {dst_dir}")


def main():
    targets = sys.argv[1:] or list(SOURCE.keys())
    for t in targets:
        recolor_body(t)
    print("DONE — re-slice v2 frames if pipeline tools need them")


if __name__ == "__main__":
    main()
