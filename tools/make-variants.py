"""
Generate variant equipment items from existing overlay sheets.

Techniques:
  1. colorize  — replace hue/saturation while preserving pixel luminance
                 (works on grey sources, unlike plain hue-shift)
  2. darken    — scale luminance down (for "black" variants of pale sources)
  3. lighten   — scale luminance up toward white
  4. decal     — stamp a small graphic onto the chest area
  5. pattern   — multiply a repeating pattern over the overlay

Usage:
  python tools/make-variants.py

Covers: t-shirts, jeans (pants), sneakers.
"""

import colorsys
import math
import random
import sys
from pathlib import Path
from PIL import Image, ImageDraw

EQUIP_ROOT = Path("src/client/public/sprites/equipment")

# Body shape: selects which base overlay folder to recolor from and write into.
# Overridden by --body in main(). T-shirts and jeans are gendered (need both
# bodies); sneakers are shared (male-only — skipped when BODY != "male").
BODY = "male"

FRAME_SIZE = 92


# ─── Technique 1: HSL colorize (preserves luminance, replaces hue+sat) ────────

def colorize_image(img: Image.Image, target_h: float, target_s: float) -> Image.Image:
    """Replace hue/saturation while preserving each pixel's lightness.
    target_h in [0,1], target_s in [0,1]."""
    out = img.copy().convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            _, l, _ = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            nr, ng, nb = colorsys.hls_to_rgb(target_h, l, target_s)
            px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


def tone_image(img: Image.Image, lightness_mul: float, lightness_add: float = 0.0) -> Image.Image:
    """Shift luminance without touching hue/sat — for black/white variants."""
    out = img.copy().convert("RGBA")
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hh, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            l = max(0.0, min(1.0, l * lightness_mul + lightness_add))
            nr, ng, nb = colorsys.hls_to_rgb(hh, l, s)
            px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out


# ─── Technique 2: decal stamp (only on opaque pixels) ────────────────────────

def apply_decal_frame(frame: Image.Image, decal: Image.Image, anchor=(0.5, 0.42)) -> Image.Image:
    out = frame.copy().convert("RGBA")
    fw, fh = out.size
    dw, dh = decal.size
    ax, ay = int(fw * anchor[0] - dw / 2), int(fh * anchor[1] - dh / 2)
    opx = out.load()
    dpx = decal.load()
    for y in range(dh):
        for x in range(dw):
            dr, dg, db, da = dpx[x, y]
            if da == 0:
                continue
            tx, ty = ax + x, ay + y
            if 0 <= tx < fw and 0 <= ty < fh and opx[tx, ty][3] > 0:
                opx[tx, ty] = (dr, dg, db, 255)
    return out


def make_star_decal(size: int = 9) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size // 2
    yellow = (255, 220, 40, 255)
    d.rectangle([c - 1, c - 1, c + 1, c + 1], fill=yellow)
    d.rectangle([c, 0, c, c - 2], fill=yellow)
    d.rectangle([c, c + 2, c, size - 1], fill=yellow)
    d.rectangle([0, c, c - 2, c], fill=yellow)
    d.rectangle([c + 2, c, size - 1, c], fill=yellow)
    return img


def make_heart_decal(size: int = 9) -> Image.Image:
    """Simple pixel-art heart."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    red = (220, 40, 60, 255)
    # 9x9 heart bitmap
    pattern = [
        "0110110",
        "1111111",
        "1111111",
        "0111110",
        "0011100",
        "0001000",
    ]
    ox = (size - 7) // 2
    oy = (size - 6) // 2
    for py, row in enumerate(pattern):
        for px_i, ch in enumerate(row):
            if ch == "1":
                px[ox + px_i, oy + py] = red
    return img


# ─── Technique 3: pattern overlay ────────────────────────────────────────────

def apply_pattern_frame(frame: Image.Image, pattern: Image.Image) -> Image.Image:
    out = frame.copy().convert("RGBA")
    fw, fh = out.size
    opx = out.load()
    ppx = pattern.load()
    pw, ph = pattern.size
    for y in range(fh):
        for x in range(fw):
            ot = opx[x, y]
            if ot[3] == 0:
                continue
            pr, pg, pb, pa = ppx[x % pw, y % ph]
            if pa == 0:
                continue
            a = pa / 255
            opx[x, y] = (
                int(ot[0] * (1 - a) + pr * a),
                int(ot[1] * (1 - a) + pg * a),
                int(ot[2] * (1 - a) + pb * a),
                ot[3],
            )
    return out


def make_stripes_pattern(size: int, stripe_w: int = 2, color=(40, 40, 40, 180)) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(0, size, stripe_w * 2):
        d.rectangle([0, y, size - 1, y + stripe_w - 1], fill=color)
    return img


def make_tiedye_pattern(size: int) -> Image.Image:
    """Bold spiral tie-dye with big saturated color bands — readable at pixel scale."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    cx, cy = size / 2, size / 2
    # Big bold colors: hot pink, electric blue, bright yellow, lime
    palette = [
        (230, 50, 120),   # hot pink
        (50, 120, 230),   # electric blue
        (240, 210, 40),   # bright yellow
        (80, 200, 80),    # lime green
    ]
    n = len(palette)
    for y in range(size):
        for x in range(size):
            angle = math.atan2(y - cy, x - cx)  # -pi to pi
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            # spiral: angle + distance rotation = band index
            spiral = (angle / (2 * math.pi) + dist / 12) * n
            idx = int(spiral) % n
            r, g, b = palette[idx]
            px[x, y] = (r, g, b, 200)
    return img


def make_digital_camo_pattern(size: int, block: int = 4, seed: int = 7) -> Image.Image:
    """High-contrast digital camo with bigger blocks for pixel readability."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rng = random.Random(seed)
    colors = [
        (60, 90, 40, 200),    # forest green
        (30, 50, 20, 200),    # dark green
        (140, 130, 80, 200),  # sand/tan
        (90, 70, 40, 200),    # brown
    ]
    for y in range(0, size, block):
        for x in range(0, size, block):
            c = rng.choice(colors)
            d.rectangle([x, y, x + block - 1, y + block - 1], fill=c)
    return img


# ─── Sheet-level helpers ─────────────────────────────────────────────────────

def process_sheet(src_path: Path, transform_frame) -> Image.Image:
    sheet = Image.open(src_path).convert("RGBA")
    w, h = sheet.size
    frames = w // FRAME_SIZE
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for f in range(frames):
        fr = sheet.crop((f * FRAME_SIZE, 0, (f + 1) * FRAME_SIZE, FRAME_SIZE))
        out.paste(transform_frame(fr), (f * FRAME_SIZE, 0))
    return out


def generate_variant(source_dir: Path, variant_id: str, slot: str, transform_frame):
    out_dir = EQUIP_ROOT / slot / variant_id / BODY
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in source_dir.glob("*.png"):
        process_sheet(src, transform_frame).save(out_dir / src.name)
    print(f"  OK {variant_id}")


# ─── Color presets (hue 0-1, sat 0-1) ────────────────────────────────────────

COLORS = {
    "red":    (0.00, 0.75),
    "blue":   (0.60, 0.70),
    "green":  (0.33, 0.60),
    "purple": (0.77, 0.55),
    "yellow": (0.14, 0.85),
    "pink":   (0.92, 0.60),
    "brown":  (0.08, 0.55),
}

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    global BODY
    # Parse --body <male|female> (default male).
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--body":
            BODY = args[i + 1]; i += 2
        elif a.startswith("--body="):
            BODY = a.split("=", 1)[1]; i += 1
        else:
            i += 1

    # Source overlays for this body — the base variants we recolor from.
    TSHIRT_SRC   = EQUIP_ROOT / "upper_body" / "worn_tshirt"     / BODY
    JEANS_SRC    = EQUIP_ROOT / "lower_body" / "blue_jeans"      / BODY
    SNEAKERS_SRC = EQUIP_ROOT / "feet"       / "beatup_sneakers" / BODY

    for label, src in (("worn_tshirt", TSHIRT_SRC), ("blue_jeans", JEANS_SRC)):
        if not src.is_dir() or not any(src.glob("*.png")):
            print(f"ERROR: missing {BODY} source overlays: {src}")
            print(f"  (generate them first: python tools/transfer-outfit-batch.py {label} --body {BODY})")
            sys.exit(1)
    print(f"Body: {BODY}")

    # T-SHIRTS (worn_tshirt is the starter; variants are just "tshirt_X")
    print("T-shirts:")
    for name, (h, s) in COLORS.items():
        generate_variant(TSHIRT_SRC, f"tshirt_{name}", "upper_body",
                         lambda fr, h=h, s=s: colorize_image(fr, h, s))
    generate_variant(TSHIRT_SRC, "tshirt_black", "upper_body",
                     lambda fr: tone_image(fr, lightness_mul=0.35))
    generate_variant(TSHIRT_SRC, "tshirt_white", "upper_body",
                     lambda fr: tone_image(fr, lightness_mul=1.0, lightness_add=0.35))
    stripes = make_stripes_pattern(FRAME_SIZE)
    generate_variant(TSHIRT_SRC, "tshirt_stripes", "upper_body",
                     lambda fr: apply_pattern_frame(fr, stripes))
    # NOTE: tshirt_tiedye / tshirt_camo are NOT in src/shared/items.ts, so the
    # game never loads them. Generation removed so orphan sprite dirs stop
    # reappearing. To ship them: add catalog entries first, then restore
    # generate_variant calls using make_tiedye_pattern / make_digital_camo_pattern.

    # JEANS / PANTS
    print("Pants:")
    generate_variant(JEANS_SRC, "jeans_black", "lower_body",
                     lambda fr: tone_image(fr, lightness_mul=0.35))
    generate_variant(JEANS_SRC, "jeans_grey", "lower_body",
                     lambda fr: colorize_image(fr, 0.0, 0.0))
    generate_variant(JEANS_SRC, "jeans_brown", "lower_body",
                     lambda fr: colorize_image(fr, 0.08, 0.55))
    generate_variant(JEANS_SRC, "jeans_khaki", "lower_body",
                     lambda fr: colorize_image(fr, 0.12, 0.35))
    generate_variant(JEANS_SRC, "jeans_red", "lower_body",
                     lambda fr: colorize_image(fr, 0.00, 0.70))
    generate_variant(JEANS_SRC, "jeans_green", "lower_body",
                     lambda fr: colorize_image(fr, 0.33, 0.55))

    # SNEAKERS — shared item (one set serves both bodies), so male-only.
    if BODY != "male":
        print("Sneakers: skipped (shared item, male-only)")
        return
    print("Sneakers:")
    generate_variant(SNEAKERS_SRC, "sneakers_red", "feet",
                     lambda fr: colorize_image(fr, 0.00, 0.75))
    generate_variant(SNEAKERS_SRC, "sneakers_blue", "feet",
                     lambda fr: colorize_image(fr, 0.60, 0.70))
    generate_variant(SNEAKERS_SRC, "sneakers_green", "feet",
                     lambda fr: colorize_image(fr, 0.33, 0.60))
    generate_variant(SNEAKERS_SRC, "sneakers_yellow", "feet",
                     lambda fr: colorize_image(fr, 0.14, 0.85))
    generate_variant(SNEAKERS_SRC, "sneakers_black", "feet",
                     lambda fr: tone_image(fr, lightness_mul=0.30))
    generate_variant(SNEAKERS_SRC, "sneakers_pink", "feet",
                     lambda fr: colorize_image(fr, 0.92, 0.60))


if __name__ == "__main__":
    main()
