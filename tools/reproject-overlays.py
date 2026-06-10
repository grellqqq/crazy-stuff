"""
Canonical-shape reproject for equipment overlays.

Replaces the noisy per-frame diff extraction (transfer-outfit-batch.py
diff_and_export) for clothing whose shape is stable across a pose's frames.

Method
------
For each direction:
  1. Extract ONE clean garment cutout from the cleanest frame (idle f1) by
     diffing the bare base against the PixelLab transfer frame, rejecting any
     pixel whose colour matches the bare body palette (kills hair/skin/underwear
     bleed) and keeping the largest connected component.
  2. For every other frame (all anims), find the (dx,dy) that aligns the
     canonical body's tracking band onto the target frame's body (min mean-sq
     luminance diff), then translate the canonical cutout by that offset.

Because every frame reuses the SAME clean cutout, there is no per-frame shape
variance (no "blinking") and no per-frame colour bleed. The garment is rigid —
it follows the torso/hips but does not deform with limbs. Fine for tees/pants at
sprite scale.

East-side directions are generated, then mirrored to their west-side twins
(matching transfer-outfit-batch.py's MIRROR_PAIRS), since PixelLab's west output
is unreliable.

Usage:
  python tools/reproject-overlays.py --body female worn_tshirt blue_jeans
"""
import os, sys, math
from PIL import Image, ImageOps

FS = 92
ANIMS = ["idle", "walk", "run", "jump"]
FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
PRIMARY_DIRS = ["south", "north", "east", "south-east", "north-east"]
MIRROR_PAIRS = [("east", "west"), ("south-east", "south-west"), ("north-east", "north-west")]

# Per-slot config: garment band (canonical extraction), tracking band (offset
# search), and palette-reject distance.
SLOT_CFG = {
    "upper_body": {"garment_y": (26, 60), "trk_y": (28, 56), "trk_x": (28, 64), "reject": 26},
    "lower_body": {"garment_y": (46, 90), "trk_y": (46, 66), "trk_x": (30, 62), "reject": 26},
    "feet":       {"garment_y": (70, 92), "trk_y": (70, 90), "trk_x": (24, 68), "reject": 22},
}

# Items handled by reproject (slot + which transfer-result folder feeds it).
ITEMS = {
    "worn_tshirt": "upper_body",
    "blue_jeans": "lower_body",
}


def load(p):
    return Image.open(p).convert("RGBA")


def build_palette(img):
    px = img.load(); pal = set()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a > 0:
                pal.add((r, g, b))
    return pal


def near_palette(rgb, pal, d):
    r1, g1, b1 = rgb; t = d * d
    for (r2, g2, b2) in pal:
        dr, dg, dbb = r1 - r2, g1 - g2, b1 - b2
        if dr * dr + dg * dg + dbb * dbb <= t:
            return True
    return False


def keep_largest(img):
    px = img.load(); w, h = img.size
    seen = [[False] * w for _ in range(h)]; best = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] and not seen[y][x]:
                stack = [(x, y)]; comp = []
                while stack:
                    cx, cy = stack.pop()
                    if cx < 0 or cy < 0 or cx >= w or cy >= h or seen[cy][cx] or not px[cx, cy][3]:
                        continue
                    seen[cy][cx] = True; comp.append((cx, cy))
                    stack += [(cx+1,cy),(cx-1,cy),(cx,cy+1),(cx,cy-1)]
                if len(comp) > len(best):
                    best = comp
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0)); opx = out.load()
    for (x, y) in best:
        opx[x, y] = px[x, y]
    return out


def extract_canonical(base_img, xfer_img, cfg):
    pal = build_palette(base_img)
    bpx = base_img.load(); xpx = xfer_img.load()
    out = Image.new("RGBA", (FS, FS), (0, 0, 0, 0)); opx = out.load()
    y0, y1 = cfg["garment_y"]
    for y in range(y0, min(y1, FS)):
        for x in range(FS):
            xr = xpx[x, y]
            if xr[3] == 0:
                continue
            br = bpx[x, y]
            d = math.dist(xr[:3], br[:3]) if br[3] else 999
            if d < 45:
                continue
            if near_palette(xr[:3], pal, cfg["reject"]):
                continue
            opx[x, y] = xr
    return keep_largest(out)


def lum(px, x, y):
    r, g, b, a = px[x, y]
    return (r + g + b) / 3 if a else None


def track_offset(canon_base, target_base, cfg):
    cpx = canon_base.load(); tpx = target_base.load()
    x0, x1 = cfg["trk_x"]; y0, y1 = cfg["trk_y"]
    best = None; best_off = (0, 0)
    for dy in range(-22, 23):
        for dx in range(-10, 11):
            tot = 0.0; n = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    cl = lum(cpx, x, y)
                    if cl is None:
                        continue
                    ty, tx = y + dy, x + dx
                    if 0 <= tx < FS and 0 <= ty < FS:
                        tl = lum(tpx, tx, ty)
                        tot += 4000 if tl is None else (cl - tl) ** 2
                        n += 1
            if n:
                s = tot / n
                if best is None or s < best:
                    best = s; best_off = (dx, dy)
    return best_off


def shift(img, dx, dy):
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (dx, dy))
    return out


def gen_item(item, body, base_dir, xfer_dir, out_dir, cfg):
    os.makedirs(out_dir, exist_ok=True)
    for direction in PRIMARY_DIRS:
        cb = load(f"{base_dir}/idle_{direction}_f1.png")
        cx = load(f"{xfer_dir}/idle_{direction}_f1.png")
        canon = extract_canonical(cb, cx, cfg)
        for anim in ANIMS:
            nf = FRAME_COUNTS[anim]
            frames = []
            for fi in range(1, nf + 1):
                tb = load(f"{base_dir}/{anim}_{direction}_f{fi}.png")
                dx, dy = track_offset(cb, tb, cfg)
                frames.append(shift(canon, dx, dy))
            sheet = Image.new("RGBA", (FS * nf, FS), (0, 0, 0, 0))
            for i, f in enumerate(frames):
                sheet.paste(f, (i * FS, 0))
            sheet.save(f"{out_dir}/{anim}_{direction}.png")
        print(f"  {item} {direction}: done")
    # Mirror east-side → west-side for every anim.
    for anim in ANIMS:
        for (src, dst) in MIRROR_PAIRS:
            sp = f"{out_dir}/{anim}_{src}.png"
            if os.path.exists(sp):
                ImageOps.mirror(load(sp)).save(f"{out_dir}/{anim}_{dst}.png")
    print(f"  {item}: mirrored west-side")


def main():
    raw = sys.argv[1:]
    body = "female"
    items = []
    i = 0
    while i < len(raw):
        a = raw[i]
        if a == "--body":
            body = raw[i + 1]; i += 2
        elif a.startswith("--body="):
            body = a.split("=", 1)[1]; i += 1
        else:
            items.append(a); i += 1
    if not items:
        items = list(ITEMS.keys())

    base_dir = f"tools/pixellab-downloads/v2/base-{body}-frames"
    for item in items:
        slot = ITEMS[item]
        cfg = SLOT_CFG[slot]
        xfer_dir = f"tools/pixellab-downloads/v2/transfer-results/{body}/{item}"
        out_dir = f"src/client/public/sprites/equipment/{slot}/{item}/{body}"
        print(f"{item} ({slot}) body={body}")
        gen_item(item, body, base_dir, xfer_dir, out_dir, cfg)
    print("DONE")


if __name__ == "__main__":
    main()
