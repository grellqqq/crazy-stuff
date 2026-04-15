"""
Generate variant equipment items from existing overlay sheets.
Three techniques demonstrated:
  1. recolor — hue-shift every non-transparent pixel
  2. decal   — stamp a small graphic onto the front/back of each frame
  3. pattern — multiply a pattern texture over the overlay
Usage:
  python tools/make-variants.py
Produces demo variants under src/client/public/sprites/equipment/... for:
  - worn_tshirt_red     (recolor)
  - worn_tshirt_star    (decal)
  - worn_tshirt_stripes (pattern)
"""

import colorsys, shutil
from pathlib import Path
from PIL import Image, ImageDraw

EQUIP_ROOT = Path("src/client/public/sprites/equipment")
SOURCE = EQUIP_ROOT / "upper_body" / "worn_tshirt" / "male"

FRAME_SIZE = 92


# ─── Technique 1: recolor via hue shift ──────────────────────────────────────

def recolor_image(img: Image.Image, hue_shift_deg: float) -> Image.Image:
    out = img.copy().convert("RGBA")
    px = out.load()
    w, h = out.size
    shift = hue_shift_deg / 360.0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hsv_h, hsv_s, hsv_v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            hsv_h = (hsv_h + shift) % 1.0
            nr, ng, nb = colorsys.hsv_to_rgb(hsv_h, hsv_s, hsv_v)
            px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


# ─── Technique 2: decal stamp ────────────────────────────────────────────────

def make_star_decal(size: int = 9) -> Image.Image:
    """Tiny yellow 5-point star on transparent bg."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # very rough 5-pixel star: center + 4 arms (looks like a plus/star at 9px)
    c = size // 2
    yellow = (255, 220, 40, 255)
    # center
    d.rectangle([c - 1, c - 1, c + 1, c + 1], fill=yellow)
    # arms
    d.rectangle([c, 0, c, c - 2], fill=yellow)
    d.rectangle([c, c + 2, c, size - 1], fill=yellow)
    d.rectangle([0, c, c - 2, c], fill=yellow)
    d.rectangle([c + 2, c, size - 1, c], fill=yellow)
    return img


def apply_decal_frame(frame: Image.Image, decal: Image.Image, anchor=(0.5, 0.42)) -> Image.Image:
    """Stamp decal at (ax*w, ay*h) — centered on the chest region by default."""
    out = frame.copy().convert("RGBA")
    fw, fh = out.size
    dw, dh = decal.size
    px_anchor = (int(fw * anchor[0] - dw / 2), int(fh * anchor[1] - dh / 2))
    # Only stamp where the overlay pixel is non-transparent (so decal only lands on shirt fabric)
    opx = out.load()
    dpx = decal.load()
    for y in range(dh):
        for x in range(dw):
            dr, dg, db, da = dpx[x, y]
            if da == 0:
                continue
            tx, ty = px_anchor[0] + x, px_anchor[1] + y
            if 0 <= tx < fw and 0 <= ty < fh and opx[tx, ty][3] > 0:
                opx[tx, ty] = (dr, dg, db, 255)
    return out


# ─── Technique 3: pattern overlay ────────────────────────────────────────────

def make_stripes_pattern(size: int, stripe_w: int = 2, color=(40, 40, 40, 180)) -> Image.Image:
    """Dark horizontal stripes with 50% spacing."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(0, size, stripe_w * 2):
        d.rectangle([0, y, size - 1, y + stripe_w - 1], fill=color)
    return img


def apply_pattern_frame(frame: Image.Image, pattern_tile: Image.Image) -> Image.Image:
    """Overlay pattern only where the garment is non-transparent."""
    out = frame.copy().convert("RGBA")
    fw, fh = out.size
    opx = out.load()
    # Resize pattern tile to frame size (pattern tile is already frame-sized in our case)
    ppx = pattern_tile.load()
    for y in range(fh):
        for x in range(fw):
            ot = opx[x, y]
            if ot[3] == 0:
                continue
            pr, pg, pb, pa = ppx[x % pattern_tile.width, y % pattern_tile.height]
            if pa == 0:
                continue
            # Simple alpha-over: blend pattern pixel on top of overlay
            a = pa / 255
            nr = int(ot[0] * (1 - a) + pr * a)
            ng = int(ot[1] * (1 - a) + pg * a)
            nb = int(ot[2] * (1 - a) + pb * a)
            opx[x, y] = (nr, ng, nb, ot[3])
    return out


# ─── Sheet-level helpers ─────────────────────────────────────────────────────

def process_sheet(src_path: Path, transform_frame) -> Image.Image:
    sheet = Image.open(src_path).convert("RGBA")
    w, h = sheet.size
    frames = w // FRAME_SIZE
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for f in range(frames):
        fr = sheet.crop((f * FRAME_SIZE, 0, (f + 1) * FRAME_SIZE, FRAME_SIZE))
        new_fr = transform_frame(fr)
        out.paste(new_fr, (f * FRAME_SIZE, 0))
    return out


def generate_variant(variant_id: str, slot: str, transform_frame):
    out_dir = EQUIP_ROOT / slot / variant_id / "male"
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in SOURCE.glob("*.png"):
        new_sheet = process_sheet(src, transform_frame)
        new_sheet.save(out_dir / src.name)
    print(f"Generated variant: {variant_id} ({slot})")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    # 1. Red tshirt (hue shift -130deg pushes grey-blue toward red)
    generate_variant(
        "worn_tshirt_red",
        "upper_body",
        lambda fr: recolor_image(fr, hue_shift_deg=180),
    )

    # 2. Star-chest tshirt — stamp a yellow star on the front of every frame
    decal = make_star_decal(size=9)
    generate_variant(
        "worn_tshirt_star",
        "upper_body",
        lambda fr: apply_decal_frame(fr, decal, anchor=(0.5, 0.42)),
    )

    # 3. Striped tshirt — multiply dark horizontal stripes
    stripes = make_stripes_pattern(FRAME_SIZE)
    generate_variant(
        "worn_tshirt_stripes",
        "upper_body",
        lambda fr: apply_pattern_frame(fr, stripes),
    )


if __name__ == "__main__":
    main()
