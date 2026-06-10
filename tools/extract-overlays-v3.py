"""
Equipment overlay extraction v3 — garment colour-keying.

Supersedes the diff-band approach (transfer-outfit-batch.py diff_and_export)
and the palette-reject reproject (reproject-overlays.py) for tees and jeans.
Both failed the same way: they decided what a pixel IS by what it is NOT
(not-background, not-body-palette). When PixelLab redraws the character with
different clothes/identity per frame, or when the garment colour overlaps the
body palette (grey tee vs grey-shaded briefs), those rules keep garbage or
drop the garment entirely.

v3 keys on the garment itself:
  1. Learn the garment palette from transfer idle f1 across the primary
     directions, restricted to a region where the garment is guaranteed
     (central torso for tees, legs for jeans) and to pixels that differ from
     the bare base. Fabric dominates the region, so colours seen fewer than
     MIN_COLOR_COUNT times are noise and dropped.
  2. Extract per frame: keep pixels that (a) differ from the base at the same
     position, (b) sit inside the slot band, (c) match the garment palette.
     Hair / skin / hallucinated tank tops / faces never match denim or tee
     fabric, so bleed dies by construction.

Items:
  worn_tshirt  rigid    one canonical cutout per direction (idle f1),
                        translated by body-silhouette tracking + smoothness
                        clamp. No per-frame shape variance ("blinking").
  blue_jeans   perframe legs move independently, so each frame keeps its own
                        keyed cutout (real motion). Near-empty frames borrow
                        the nearest good frame, shifted by silhouette offset.

Colour variants (tshirt_*, jeans_*) are palette-swapped from these bases by
make-variants.py — run it for both bodies afterwards.

Usage:
  python tools/extract-overlays-v3.py --body female worn_tshirt blue_jeans
  python tools/extract-overlays-v3.py --body male
"""
import os
import sys
import numpy as np
from PIL import Image, ImageOps

FS = 92
ANIMS = ["idle", "walk", "run", "jump"]
FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
PRIMARY_DIRS = ["south", "north", "east", "south-east", "north-east"]
MIRROR_PAIRS = [("east", "west"), ("south-east", "south-west"),
                ("north-east", "north-west")]

BASE_DIR = "tools/pixellab-downloads/v2/base-{body}-frames"
XFER_DIR = "tools/pixellab-downloads/v2/transfer-results/{body}/{item}"
OUT_DIR = "src/client/public/sprites/equipment/{slot}/{item}/{body}"

DIFF_MIN = 45          # colour distance to base pixel that counts as "changed"
KEY_DIST = 38          # colour distance to garment palette that counts as garment
MIN_COLOR_COUNT = 6    # palette colours seen fewer times than this are noise
EMPTY_FRAME_PX = 30    # per-frame minimum; below this borrow a neighbour frame

ITEMS = {
    "worn_tshirt": {
        "slot": "upper_body", "mode": "rigid",
        "band": (24, 64),              # extraction Y band
        "learn": (32, 60, 26, 50),     # x0,x1,y0,y1 garment-guaranteed region
        "min_comp": None,              # keep largest component only
    },
    "blue_jeans": {
        "slot": "lower_body", "mode": "perframe",
        "band": (40, 92),
        "learn": (30, 62, 54, 78),
        "min_comp": 10,                # keep all components >= this size
        "borrow_below": 100,           # frames thinner than this borrow a neighbour
    },
    # Shared item: extract for --body male only (serves both bodies). The base
    # char already wears similar shoes, so frames with a near-zero diff borrow
    # their nearest non-empty neighbour (same behaviour the old pipeline had).
    "beatup_sneakers": {
        "slot": "feet", "mode": "perframe",
        "band": (64, 92),
        "learn": (28, 64, 74, 90),
        "min_comp": 5,
    },
}

# Silhouette tracking search ranges (jump arcs translate the body a lot).
TRK_DY = range(-26, 27)
TRK_DX = range(-12, 13)
TRK_BAND = (26, 58, 26, 66)  # y0,y1,x0,x1 — torso band of the canonical frame
SMOOTH_MAX_STEP = 7          # offsets jumping more than this vs both neighbours are outliers


def load_rgba(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.int16)


def save_rgba(arr, path):
    Image.fromarray(arr.astype(np.uint8), "RGBA").save(path)


def base_frame(body, anim, direction, fi):
    return load_rgba(f"{BASE_DIR.format(body=body)}/{anim}_{direction}_f{fi}.png")


def xfer_frame(body, item, anim, direction, fi):
    p = f"{XFER_DIR.format(body=body, item=item)}/{anim}_{direction}_f{fi}.png"
    return load_rgba(p) if os.path.exists(p) else None


def diff_mask(base, xfer):
    """Pixels where the transfer differs from the bare base (new content)."""
    both = (xfer[..., 3] > 8)
    d = xfer[..., :3].astype(np.int32) - base[..., :3].astype(np.int32)
    dist = np.sqrt((d ** 2).sum(axis=2))
    changed = (dist >= DIFF_MIN) | (base[..., 3] <= 8)
    return both & changed


def learn_garment_palette(body, item, cfg):
    """Dominant colours of the garment, sampled where it must exist."""
    x0, x1, y0, y1 = cfg["learn"]
    samples = []
    for d in PRIMARY_DIRS:
        b = base_frame(body, "idle", d, 1)
        x = xfer_frame(body, item, "idle", d, 1)
        if x is None:
            continue
        m = diff_mask(b, x)
        region = np.zeros_like(m)
        region[y0:y1, x0:x1] = True
        samples.append(x[m & region][:, :3])
    if not samples:
        raise SystemExit(f"no transfer idle frames for {item} {body}")
    px = np.concatenate(samples).astype(np.int32)
    # Transfers are dithered: hundreds of near-identical shades, each rare.
    # Cluster into 16-wide buckets and keep the mean of populated buckets.
    keys = (px[:, 0] // 16) * 4096 + (px[:, 1] // 16) * 64 + (px[:, 2] // 16)
    uniq, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
    pal = [px[inv == i].mean(axis=0) for i in range(len(uniq))
           if counts[i] >= MIN_COLOR_COUNT]
    if not pal:
        order = np.argsort(-counts)[:8]
        pal = [px[inv == i].mean(axis=0) for i in order]
    return np.array(pal, dtype=np.int32)


def key_mask(xfer, palette):
    """Pixels whose colour matches the garment palette."""
    px = xfer[..., :3].reshape(-1, 1, 3).astype(np.int32)
    d2 = ((px - palette[None, :, :]) ** 2).sum(axis=2).min(axis=1)
    return (d2 <= KEY_DIST ** 2).reshape(xfer.shape[:2])


def components(mask, min_size=None, largest_only=False):
    """Connected components (4-neighbour); filter by size or keep largest."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    sizes = {}
    cur = 0
    for sy in range(h):
        for sx in range(w):
            if mask[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                stack = [(sy, sx)]
                labels[sy, sx] = cur
                n = 0
                while stack:
                    y, x = stack.pop()
                    n += 1
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                sizes[cur] = n
    if not sizes:
        return mask & False
    if largest_only:
        keep = {max(sizes, key=sizes.get)}
    else:
        keep = {k for k, v in sizes.items() if v >= (min_size or 1)}
    return np.isin(labels, list(keep))


def extract(base, xfer, palette, cfg):
    """Keyed garment cutout for one frame."""
    y0, y1 = cfg["band"]
    m = diff_mask(base, xfer) & key_mask(xfer, palette)
    band = np.zeros_like(m)
    band[y0:y1, :] = True
    m &= band
    m = components(m, min_size=cfg["min_comp"],
                   largest_only=cfg["min_comp"] is None)
    out = np.zeros_like(xfer)
    out[m] = xfer[m]
    out[~m, 3] = 0
    return out


def body_centroid(arr):
    m = arr[..., 3] > 8
    ys, xs = np.nonzero(m)
    return float(xs.mean()), float(ys.mean())


def silhouette_offset(canon_base, target_base):
    """(dx, dy) aligning the canonical body onto the target body.

    The body's pixel count is roughly constant across frames, so the whole-
    silhouette centroid tracks pure translation (jump arcs, crouches) almost
    exactly; pose deformation only nudges it 1-2px. A global band search is
    NOT used — skin-on-skin luminance matching happily aligns the torso onto
    legs or head. Instead: centroid estimate, then a small local refinement."""
    cx0, cy0 = body_centroid(canon_base)
    cx1, cy1 = body_centroid(target_base)
    dx0, dy0 = round(cx1 - cx0), round(cy1 - cy0)

    y0, y1, x0, x1 = TRK_BAND
    ca = canon_base[y0:y1, x0:x1, 3] > 8
    cl = canon_base[y0:y1, x0:x1, :3].mean(axis=2)
    ta_full = target_base[..., 3] > 8
    tl_full = target_base[..., :3].mean(axis=2)
    best, best_off = None, (dx0, dy0)
    for dy in range(dy0 - 3, dy0 + 4):
        ty0, ty1 = y0 + dy, y1 + dy
        if ty0 < 0 or ty1 > FS:
            continue
        for dx in range(dx0 - 3, dx0 + 4):
            tx0, tx1 = x0 + dx, x1 + dx
            if tx0 < 0 or tx1 > FS:
                continue
            ta = ta_full[ty0:ty1, tx0:tx1]
            tl = tl_full[ty0:ty1, tx0:tx1]
            overlap = ca & ta
            mismatch = (ca ^ ta).sum() / ca.size
            lum = ((cl - tl)[overlap] ** 2).mean() if overlap.sum() else 4000.0
            # Anchor pull: the XOR/luminance surface is weak on profile
            # crouches and will otherwise drift to the window corner.
            anchor = 30.0 * ((dx - dx0) ** 2 + (dy - dy0) ** 2)
            score = lum + 3000.0 * mismatch + anchor
            if best is None or score < best:
                best, best_off = score, (dx, dy)
    return best_off


_off_cache = {}


def anim_offsets(body, anim, direction, canon_base, bases):
    """Smoothed silhouette offsets — cached per (body, anim, dir), item-independent."""
    k = (body, anim, direction)
    if k not in _off_cache:
        _off_cache[k] = smooth_offsets(
            [silhouette_offset(canon_base, tb) for tb in bases])
    return _off_cache[k]


def smooth_offsets(offs):
    """Replace single-frame tracking blunders with neighbour interpolation.

    Interior frames: an offset far from BOTH neighbours while the neighbours
    agree is a blunder — interpolate it. Endpoints: real animations (jump
    wind-up f1, landing f9) legitimately differ from their neighbour by the
    full inter-frame motion, so endpoints are only snapped for teleport-sized
    jumps, not ordinary motion."""
    out = list(offs)
    TELEPORT = 12

    def dist(a, b):
        return abs(a[0] - b[0]) + abs(a[1] - b[1])

    for i in range(len(out)):
        prev = out[i - 1] if i > 0 else None
        nxt = out[i + 1] if i < len(out) - 1 else None
        if prev and nxt and dist(out[i], prev) > SMOOTH_MAX_STEP \
                and dist(out[i], nxt) > SMOOTH_MAX_STEP \
                and dist(prev, nxt) <= SMOOTH_MAX_STEP:
            out[i] = ((prev[0] + nxt[0]) // 2, (prev[1] + nxt[1]) // 2)
        elif prev and not nxt and dist(out[i], prev) > TELEPORT:
            out[i] = prev
        elif nxt and not prev and dist(out[i], nxt) > TELEPORT:
            out[i] = nxt
    return out


def shift_rgba(arr, dx, dy):
    out = np.zeros_like(arr)
    src_y = slice(max(0, -dy), min(FS, FS - dy))
    src_x = slice(max(0, -dx), min(FS, FS - dx))
    dst_y = slice(max(0, dy), min(FS, FS + dy))
    dst_x = slice(max(0, dx), min(FS, FS + dx))
    out[dst_y, dst_x] = arr[src_y, src_x]
    return out


def gen_item(item, body, cfg):
    palette = learn_garment_palette(body, item, cfg)
    print(f"{item} ({cfg['slot']}) body={body}: palette {len(palette)} colours")
    out_dir = OUT_DIR.format(slot=cfg["slot"], item=item, body=body)
    os.makedirs(out_dir, exist_ok=True)

    for direction in PRIMARY_DIRS:
        canon_base = base_frame(body, "idle", direction, 1)
        canon = None
        if cfg["mode"] == "rigid":
            cx = xfer_frame(body, item, "idle", direction, 1)
            canon = extract(canon_base, cx, palette, cfg)
            if (canon[..., 3] > 8).sum() < 80:
                print(f"  WARNING {direction}: canonical cutout only "
                      f"{(canon[..., 3] > 8).sum()}px — check transfer/palette")
        for anim in ANIMS:
            nf = FRAME_COUNTS[anim]
            bases = [base_frame(body, anim, direction, fi) for fi in range(1, nf + 1)]
            offs = anim_offsets(body, anim, direction, canon_base, bases)
            frames = []
            if cfg["mode"] == "rigid":
                frames = [shift_rgba(canon, dx, dy) for (dx, dy) in offs]
            else:
                raw = []
                for fi in range(1, nf + 1):
                    x = xfer_frame(body, item, anim, direction, fi)
                    raw.append(None if x is None else extract(bases[fi - 1], x, palette, cfg))
                # borrow nearest good frame for missing/near-empty ones
                floor = cfg.get("borrow_below", EMPTY_FRAME_PX)
                good = [i for i, fr in enumerate(raw)
                        if fr is not None and (fr[..., 3] > 8).sum() >= floor]
                if not good:
                    print(f"  WARNING {anim}_{direction}: no usable frames")
                    good = [i for i, fr in enumerate(raw) if fr is not None] or [0]
                for i, fr in enumerate(raw):
                    if fr is not None and (fr[..., 3] > 8).sum() >= floor:
                        frames.append(fr)
                    else:
                        j = min(good, key=lambda g: abs(g - i))
                        ddx = offs[i][0] - offs[j][0]
                        ddy = offs[i][1] - offs[j][1]
                        frames.append(shift_rgba(raw[j], ddx, ddy))
            sheet = np.zeros((FS, FS * nf, 4), dtype=np.int16)
            for i, fr in enumerate(frames):
                sheet[:, i * FS:(i + 1) * FS] = fr
            save_rgba(sheet, f"{out_dir}/{anim}_{direction}.png")
        print(f"  {direction}: done")

    for anim in ANIMS:
        for src, dst in MIRROR_PAIRS:
            sp = f"{out_dir}/{anim}_{src}.png"
            if os.path.exists(sp):
                ImageOps.mirror(Image.open(sp)).save(f"{out_dir}/{anim}_{dst}.png")
    print(f"  {item}: mirrored west-side")


def main():
    raw = sys.argv[1:]
    body, items = "female", []
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
    for item in items:
        if item == "beatup_sneakers" and body != "male":
            print(f"{item}: skipped (shared item, male sprites serve all bodies)")
            continue
        gen_item(item, body, ITEMS[item])
    print("DONE")


if __name__ == "__main__":
    main()
