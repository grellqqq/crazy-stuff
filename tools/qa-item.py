"""Motion-QA contact sheet for a SINGLE equipment item.

Composites one overlay alone onto the base body frames, runtime-accurate
(west-side mirrored exactly like IsoScene), as a direction(rows) x frame(cols)
grid per anim — the in-MOTION view that idle-only QA misses. Self-contained:
does NOT depend on items.ts parsing, so it works for mk()-generated items too.

Usage:
  python tools/qa-item.py <item_id> <slot> <body> [anim ...]
  # default anims: walk run jump idle
Example:
  python tools/qa-item.py leather_jacket upper_body male run jump
Output: tools/preview-output/qa_<item>_<body>_<anim>.png
"""
import os
import sys
from PIL import Image, ImageDraw, ImageOps

EQUIP_ROOT = "src/client/public/sprites/equipment"
BASE_FRAMES = "tools/pixellab-downloads/v2/base-{body}-frames"
OUT_DIR = "tools/preview-output"
FS = 92
SCALE = 2
PAD = 4
BG = (40, 40, 48, 255)
FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
DIRS = ["south", "south-east", "east", "north-east", "north",
        "north-west", "west", "south-west"]
RUNTIME_MIRROR = {"west": "east", "south-west": "south-east",
                  "north-west": "north-east"}
_cache = {}


def overlay_frame(item_id, slot, eq_body, anim, direction, fi):
    path = f"{EQUIP_ROOT}/{slot}/{item_id}/{eq_body}/{anim}_{direction}.png"
    if path not in _cache:
        _cache[path] = Image.open(path).convert("RGBA") if os.path.exists(path) else None
    sheet = _cache[path]
    if sheet is None:
        return None
    return sheet.crop((fi * FS, 0, (fi + 1) * FS, FS))


def composed_frame(item_id, slot, body, eq_body, anim, direction, fi):
    src = RUNTIME_MIRROR.get(direction)
    if src:
        return ImageOps.mirror(
            composed_frame(item_id, slot, body, eq_body, anim, src, fi))
    base = Image.open(
        f"{BASE_FRAMES.format(body=body)}/{anim}_{direction}_f{fi + 1}.png"
    ).convert("RGBA")
    out = Image.new("RGBA", (FS, FS), (0, 0, 0, 0))
    out.alpha_composite(base)
    fr = overlay_frame(item_id, slot, eq_body, anim, direction, fi)
    if fr is not None:
        out.alpha_composite(fr)
    return out


def qa_grid(item_id, slot, body, anim):
    eq_body = "female" if body.startswith("female") else "male"
    nf = FRAME_COUNTS[anim]
    cw = ch = FS * SCALE
    label_w = 110
    W = label_w + nf * (cw + PAD) + PAD
    H = 24 + len(DIRS) * (ch + PAD) + PAD
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((6, 4), f"{item_id} / {body} / {anim} (alone)", fill=(220, 220, 230))
    for r, direction in enumerate(DIRS):
        y = 24 + PAD + r * (ch + PAD)
        d.text((6, y + ch // 2 - 6), direction, fill=(170, 180, 200))
        for fi in range(nf):
            img = composed_frame(item_id, slot, body, eq_body, anim, direction, fi)
            sheet.alpha_composite(img.resize((cw, ch), Image.NEAREST),
                                  (label_w + PAD + fi * (cw + PAD), y))
    p = f"{OUT_DIR}/qa_{item_id}_{body}_{anim}.png"
    sheet.save(p)
    print(f"  {p}")


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        raise SystemExit(__doc__)
    item_id, slot, body = args[0], args[1], args[2]
    anims = args[3:] or ["walk", "run", "jump", "idle"]
    os.makedirs(OUT_DIR, exist_ok=True)
    for anim in anims:
        qa_grid(item_id, slot, body, anim)


if __name__ == "__main__":
    main()
