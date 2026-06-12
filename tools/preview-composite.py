"""
Composite contact sheets for visual equipment QA.

Recreates what the game renders — base body frame + equipment overlays in
layer order — and tiles the results into reviewable grid PNGs:

  1. composite_{body}_{anim}.png  — full outfit (jeans + tee + sneakers
     [+ hat on walk/idle]) for every direction (rows) x frame (cols).
  2. catalog_{body}.png           — every catalog item equipped alone on the
     body (idle_south f1), labelled, to eyeball each variant's colour/fit.

Shared items (sneakers, hat) composite from /male/ onto BOTH bodies — exactly
what the game does (equipmentBodyKey).

Usage:
  python tools/preview-composite.py
Output: tools/preview-output/
"""
import os
import re
import sys
from PIL import Image, ImageDraw

EQUIP_ROOT = "src/client/public/sprites/equipment"
BASE_FRAMES = "tools/pixellab-downloads/v2/base-{body}-frames"
OUT_DIR = "tools/preview-output"
ITEMS_TS = "src/shared/items.ts"

FS = 92
SCALE = 2
FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
DIRS = ["south", "south-east", "east", "north-east", "north",
        "north-west", "west", "south-west"]
FULL_ANIMS = ["walk", "idle", "run", "jump"]
# body-relative paste order for equipped slots (subset of IsoScene LAYER_ORDER
# that exists in the catalog today, body first)
SLOT_PASTE_ORDER = ["lower_body", "feet", "upper_body", "head_accessory"]

OUTFIT = {  # full-outfit composite per slot
    "lower_body": "blue_jeans",
    "upper_body": "worn_tshirt",
    "feet": "beatup_sneakers",
    "head_accessory": "wizard_hat",
}
BG = (40, 40, 48, 255)
PAD = 4


def parse_items_ts():
    items = {}
    src = open(ITEMS_TS, encoding="utf8").read()
    for m in re.finditer(
            r"\{\s*id:\s*'([^']+)',\s*slot:\s*'([^']+)',\s*fitProfile:\s*'(\w+)'([^}]*)\}",
            src):
        iid, slot, fit, rest = m.groups()
        fs = re.search(r"frameSize:\s*(\d+)", rest)
        anims = FULL_ANIMS if "FULL_ANIMS" in rest else None
        if anims is None:
            am = re.search(r"availableAnims:\s*\[([^\]]*)\]", rest)
            anims = re.findall(r"'(\w+)'", am.group(1)) if am else ["walk", "idle"]
        items[iid] = {"slot": slot, "fit": fit,
                      "frame": int(fs.group(1)) if fs else 92, "anims": anims}
    return items


ITEMS = parse_items_ts()
_sheet_cache = {}


def overlay_frame(item_id, body, anim, direction, fi):
    """Frame fi (0-based) of an item's overlay, resized to 92px if needed.
    Returns None when the item has no sheet for this anim."""
    it = ITEMS[item_id]
    if anim not in it["anims"]:
        return None
    eq_body = body if it["fit"] == "gendered" else "male"
    path = f"{EQUIP_ROOT}/{it['slot']}/{item_id}/{eq_body}/{anim}_{direction}.png"
    if path not in _sheet_cache:
        _sheet_cache[path] = Image.open(path).convert("RGBA") if os.path.exists(path) else None
    sheet = _sheet_cache[path]
    if sheet is None:
        return None
    f = it["frame"]
    fr = sheet.crop((fi * f, 0, (fi + 1) * f, f))
    if f != FS:
        # Same maths as in-game scale (0.75 * 92/frameSize vs body 0.75) with a
        # shared (0.5, 0.85) origin: a plain resize to 92px lands on the same
        # anchor, so no extra offset is needed.
        fr = fr.resize((FS, FS), Image.NEAREST)
    return fr


# The game never renders west-side textures: IsoScene reuses east-side sheets
# with flipX for SA/A/WA facings (body AND equipment, kept in sync). Mirror
# the composed east frame so previews match what players actually see.
RUNTIME_MIRROR = {"west": "east", "south-west": "south-east",
                  "north-west": "north-east"}


def composed_frame(body, anim, direction, fi, loadout):
    src = RUNTIME_MIRROR.get(direction)
    if src:
        from PIL import ImageOps
        return ImageOps.mirror(composed_frame(body, anim, src, fi, loadout))
    base = Image.open(
        f"{BASE_FRAMES.format(body=body)}/{anim}_{direction}_f{fi + 1}.png"
    ).convert("RGBA")
    out = Image.new("RGBA", (FS, FS), (0, 0, 0, 0))
    out.alpha_composite(base)
    for slot in SLOT_PASTE_ORDER:
        iid = loadout.get(slot)
        if not iid:
            continue
        fr = overlay_frame(iid, body, anim, direction, fi)
        if fr is not None:
            out.alpha_composite(fr)
    return out


def cell(img):
    return img.resize((FS * SCALE, FS * SCALE), Image.NEAREST)


def outfit_grid(body, anim):
    nf = FRAME_COUNTS[anim]
    cw, ch = FS * SCALE, FS * SCALE
    label_w = 110
    W = label_w + nf * (cw + PAD) + PAD
    H = 24 + len(DIRS) * (ch + PAD) + PAD
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((6, 4), f"{body} / {anim} — jeans+tee+sneakers"
           + ("+hat" if anim in ITEMS["wizard_hat"]["anims"] else ""), fill=(220, 220, 230))
    for r, direction in enumerate(DIRS):
        y = 24 + PAD + r * (ch + PAD)
        d.text((6, y + ch // 2 - 6), direction, fill=(170, 180, 200))
        for fi in range(nf):
            img = composed_frame(body, anim, direction, fi, OUTFIT)
            sheet.alpha_composite(cell(img), (label_w + PAD + fi * (cw + PAD), y))
    p = f"{OUT_DIR}/composite_{body}_{anim}.png"
    sheet.save(p)
    print(f"  {p}")


def catalog_grid(body):
    ids = sorted(ITEMS)
    cols = 7
    rows = -(-len(ids) // cols)
    cw, ch = FS * SCALE, FS * SCALE + 16
    W = PAD + cols * (cw + PAD)
    H = 24 + rows * (ch + PAD)
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((6, 4), f"{body} — every catalog item, idle_south f1", fill=(220, 220, 230))
    for i, iid in enumerate(ids):
        r, c = divmod(i, cols)
        x = PAD + c * (cw + PAD)
        y = 24 + r * (ch + PAD)
        img = composed_frame(body, "idle", "south", 0, {ITEMS[iid]["slot"]: iid})
        sheet.alpha_composite(cell(img), (x, y))
        d.text((x + 2, y + FS * SCALE + 2), iid, fill=(170, 180, 200))
    p = f"{OUT_DIR}/catalog_{body}.png"
    sheet.save(p)
    print(f"  {p}")


def single_row(body, anim, direction, scale=4, loadout=None):
    """One direction at high zoom, frame-numbered — for close inspection."""
    loadout = OUTFIT if loadout is None else loadout
    nf = FRAME_COUNTS[anim]
    cw = ch = FS * scale
    W = PAD + nf * (cw + PAD)
    H = 20 + ch + PAD
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    for fi in range(nf):
        x = PAD + fi * (cw + PAD)
        img = composed_frame(body, anim, direction, fi, loadout)
        sheet.alpha_composite(img.resize((cw, ch), Image.NEAREST), (x, 20))
        d.text((x + 2, 4), f"{body} {anim} {direction} f{fi + 1}", fill=(200, 210, 225))
    p = f"{OUT_DIR}/row_{body}_{anim}_{direction}.png"
    sheet.save(p)
    print(f"  {p}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    args = sys.argv[1:]
    if args and args[0] == "--row":
        # --row <body> <anim> <dir> [scale] [bare|jeans]
        body, anim, direction = args[1], args[2], args[3]
        scale = int(args[4]) if len(args) > 4 else 4
        loadout = None
        if "bare" in args:
            loadout = {}
        elif "jeans" in args:
            loadout = {"lower_body": "blue_jeans"}
        single_row(body, anim, direction, scale, loadout)
        return
    for body in ("male", "female"):
        for anim in FULL_ANIMS:
            outfit_grid(body, anim)
        catalog_grid(body)
    print("DONE")


if __name__ == "__main__":
    main()
