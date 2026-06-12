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
from collections import deque

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
RAMP_BODY_DIST = 35    # palette colours closer than this to the body palette are
                       # contamination (transfer figure's skin/tank caught in the
                       # learn box) and must not enter the shading ramp
MIN_COLOR_COUNT = 6    # palette colours seen fewer times than this are noise
EMPTY_FRAME_PX = 30    # per-frame minimum; below this borrow a neighbour frame

ITEMS = {
    "worn_tshirt": {
        "slot": "upper_body", "mode": "rigid",
        "band": (24, 64),              # extraction Y band
        "learn": (32, 60, 26, 50),     # x0,x1,y0,y1 garment-guaranteed region
        "min_comp": None,              # keep largest component only
        "grey_only": True,             # tee is grey: strip saturated noise (hair/jeans)
        # The torso PITCHES FORWARD during jump and LEANS during run — a
        # translated upright canonical can never fit a rotated body (jump:
        # "slab on the hips"; run: "shirt floating static in the air"). The
        # transfers draw the tee pose-correct per frame, so extract those
        # per-frame; idle/walk torsos stay upright = rigid canonical.
        "perframe_anims": ("jump", "run"),
        "borrow_below": 110,           # jump frames missing the tee borrow a neighbour
    },
    "blue_jeans": {
        "slot": "lower_body", "mode": "perframe",
        "band": (40, 92),
        "learn": (30, 62, 54, 78),
        "min_comp": 10,                # keep all components >= this size
        "borrow_below": 100,           # frames thinner than this borrow a neighbour
        "conform": True,               # re-tailor to the wearer's silhouette
    },
    # Shared item: extract for --body male only (serves both bodies). The base
    # char already wears similar shoes, so frames with a near-zero diff borrow
    # their nearest non-empty neighbour (same behaviour the old pipeline had).
    "beatup_sneakers": {
        "slot": "feet", "mode": "perframe",
        "band": (64, 92),
        "learn": (28, 64, 74, 90),
        "min_comp": 5,
        # NO conform: sneaker overlays are tiny diffs vs the base shoes, and
        # mid-stride the transfer foot sits 2-3px off the base foot — clipping
        # to the silhouette eats legitimate shoe pixels down to near-nothing.
        # Colour keying alone already removes foreign-garment garbage here.
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
    if cfg.get("grey_only"):
        # The garment is grey: any saturated pixel that slipped past the
        # colour key is contamination — the transfer figure's dark hair
        # (≈ tee shadow tones, sat warm) diffing against the wearer's
        # lighter hair, or jeans-waist fragments (blue). Both ended up
        # baked into the tee canonical and rode on the head in-game.
        r = xfer[..., 0].astype(np.int32)
        g = xfer[..., 1].astype(np.int32)
        b = xfer[..., 2].astype(np.int32)
        sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
        lum = (r + g + b) / 3.0
        # near-white excluded too: the transfer's white tank/cuffs are
        # desaturated and slipped past the saturation test alone
        m &= (sat < 25) & (lum <= 232)
    band = np.zeros_like(m)
    band[y0:y1, :] = True
    m &= band
    m = components(m, min_size=cfg["min_comp"],
                   largest_only=cfg["min_comp"] is None)
    out = np.zeros_like(xfer)
    out[m] = xfer[m]
    out[~m, 3] = 0
    return out


def clip_simple(frame, base, dilate_n=1):
    """Clip a garment frame to the wearer's silhouette (no trouser logic —
    used for per-frame upper-body garments)."""
    body = base[..., 3] > 8
    bd = body.copy()
    for _ in range(dilate_n):
        bd = dilate1(bd)
    out = frame.copy()
    out[~((out[..., 3] > 8) & bd)] = 0
    return out


def body_centroid(arr):
    m = arr[..., 3] > 8
    ys, xs = np.nonzero(m)
    return float(xs.mean()), float(ys.mean())


def dilate1(m):
    d = m.copy()
    d[1:, :] |= m[:-1, :]
    d[:-1, :] |= m[1:, :]
    d[:, 1:] |= m[:, :-1]
    d[:, :-1] |= m[:, 1:]
    return d


def body_palette_of(body):
    """Unique colours of the bare base body (idle f1, primary dirs)."""
    colors = set()
    for d in PRIMARY_DIRS:
        a = base_frame(body, "idle", d, 1)
        op = a[a[..., 3] > 8][:, :3]
        for c in np.unique(op, axis=0):
            colors.add(tuple(int(v) for v in c))
    return np.array(sorted(colors), dtype=np.int32)


def skin_over_garment(xfer, body_pal=None, dist=28):
    """Pixels where the TRANSFER drew SKIN (its arms/hands — the garment
    must stay out of these: the wearer's arm renders there, in front of the
    pants). Warm-tone test, NOT body-palette distance: the body palette
    contains the briefs' whites and outline darks, so palette matching used
    to swallow the transfer's white tank and veto fill across the whole
    waistband while MISSING nothing useful — skin is what arms are made of."""
    if xfer is None:
        return np.zeros((FS, FS), dtype=bool)
    r = xfer[..., 0].astype(np.int32)
    g = xfer[..., 1].astype(np.int32)
    b = xfer[..., 2].astype(np.int32)
    lum = (r + g + b) / 3.0
    return ((xfer[..., 3] > 8) & (lum > 55) & (lum < 235)
            & (r > g) & (g > b) & ((r - b) > 25))


def base_skin_strict(base):
    """Wearer's skin pixels (arms/legs/face) with outlines, briefs/bra and
    hair excluded — a per-pixel test only; connectivity over this mask is
    NOT reliable (limbs merge through the shoulder/torso)."""
    r = base[..., 0].astype(np.int32)
    g = base[..., 1].astype(np.int32)
    b = base[..., 2].astype(np.int32)
    lum = (r + g + b) / 3.0
    return ((base[..., 3] > 8) & (r > g) & (g >= b)
            & ((r - b) >= 50) & (lum >= 85) & (lum <= 215))


def arm_occlusion(xfer, body_pal, y_top, y_bot, base=None):
    """Where the wearer's arm plausibly crosses IN FRONT of the garment, so
    garment pixels must be stripped and never re-painted there (denim on the
    hand was the in-game "arms flashing" / denim-mitten bug). Proxy: the
    transfer figure's SKIN (warm-tone match), drawn in the same pose within
    a couple of px of the wearer's limbs, filtered by COMPONENT: only skin
    patches connected ABOVE the waist row qualify — an arm enters the
    trouser zone from the shoulders. Isolated skin blobs floating below the
    waist are the transfer's own mis-proportioned anatomy in spots the
    wearer's garment must cover (they once vetoed half a thigh on run
    north-east). Dilated once to absorb the small pose offset."""
    occl = skin_over_garment(xfer, body_pal)
    if not occl.any():
        return occl
    # COMPONENT FILTER: only skin patches connected above the waist row
    # qualify as arms. This is load-bearing for thighs: dropping it lets the
    # transfer's bare hanging arm (which overlaps the wearer's THIGH on
    # run-east f1-f3) veto the whole leg (tried 2026-06-11 — legs went
    # bare). The cost: a tank-covered shoulder can orphan the transfer's
    # arm skin and a fist chunk survives — accepted nit; a chunk on a fist
    # beats a bare leg.
    h, w = occl.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    keep = []
    for sy in range(h):
        for sx in range(w):
            if occl[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                stack = [(sy, sx)]
                labels[sy, sx] = cur
                ymin = sy
                while stack:
                    y, x = stack.pop()
                    ymin = min(ymin, y)
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                        if 0 <= ny < h and 0 <= nx < w and occl[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                if ymin < y_top:
                    keep.append(cur)
    occl = np.isin(labels, keep)
    # SNAP each arm component onto the WEARER's skin: the transfer figure's
    # proportions put its hand a few px from hers, so stripping at its
    # position alone left her hand denim-covered (the walk-east "blue
    # forearm"). Local ±4 search maximising overlap with the wearer's
    # strict-skin pixels; union of original + snapped keeps both protected.
    if base is not None:
        skin = base_skin_strict(base)
        snapped = np.zeros_like(occl)
        for cid in keep:
            comp = labels == cid
            if int(comp.sum()) < 6:
                continue
            ys, xs = np.nonzero(comp)
            best, best_off = -1, (0, 0)
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    ny = ys + dy
                    nx = xs + dx
                    ok = (ny >= 0) & (ny < FS) & (nx >= 0) & (nx < FS)
                    ov = int(skin[ny[ok], nx[ok]].sum())
                    if ov > best:
                        best, best_off = ov, (dy, dx)
            dy, dx = best_off
            ny = ys + dy
            nx = xs + dx
            ok = (ny >= 0) & (ny < FS) & (nx >= 0) & (nx < FS)
            snapped[ny[ok], nx[ok]] = True
        # widen the snapped arm by the wearer's own adjacent skin: covers
        # the fist pixels the ±4 alignment still misses
        snapped = dilate1(dilate1(snapped)) & base_skin_strict(base)
        occl |= snapped
    return dilate1(occl)


def legs_mask_of(body, y_top, y_hem):
    """Body pixels below the waistline that belong to the LEGS.

    Restricted to rows below y_top (the garment's waist), the hips+legs form
    a connected component that reaches the hem/feet zone; a swinging hand or
    forearm dipping below the waistline connects to the body only via the
    shoulder — above y_top, outside this region — so it shows up as an island
    that never reaches the feet. Works for any limb angle, unlike per-column
    support tests."""
    sub = np.zeros_like(body)
    sub[y_top:, :] = body[y_top:, :]
    h, w = sub.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    reach = {}
    for sy in range(y_top, h):
        for sx in range(w):
            if sub[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                stack = [(sy, sx)]
                labels[sy, sx] = cur
                ymax = sy
                while stack:
                    y, x = stack.pop()
                    ymax = max(ymax, y)
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                        if 0 <= ny < h and 0 <= nx < w and sub[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                reach[cur] = ymax
    keep = {k for k, ym in reach.items() if ym >= y_hem - 4}
    return np.isin(labels, list(keep))


def arm_strict_mask(base, y_top):
    """Wearer's arm pixels inside the trouser zone, from the BASE body:
    strict-skin components that REACH ABOVE the waist row. With the strict
    test (briefs/bra, outlines and hair excluded) an arm chains face→neck→
    shoulder→fist as one component starting near the head, while each leg
    is its own component starting below the waistband — the 1px outline
    between an overlapping fist and thigh keeps them apart. (The earlier
    attempt at this used a loose skin test and the briefs' warm shadow
    bridged everything into one blob.)"""
    skin = base_skin_strict(base)
    h, w = skin.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    keep = []
    for sy in range(h):
        for sx in range(w):
            if skin[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                stack = [(sy, sx)]
                labels[sy, sx] = cur
                ymin = sy
                while stack:
                    y, x = stack.pop()
                    ymin = min(ymin, y)
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                        if 0 <= ny < h and 0 <= nx < w and skin[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                if ymin < y_top - 2:
                    keep.append(cur)
    return np.isin(labels, keep)


def fist_blobs(base, y_top, y_bot):
    """Small outline-enclosed skin blobs in the hip band of the WEARER —
    pumping fists/forearms crossing the trouser zone. Pixel-art outlines
    enclose the hand, so in the strict-skin mask a fist is its own small
    component; legs are large components or sit below the hip band. These
    must never carry garment pixels (the run-east fist kept catching denim
    chunks the transfer-skin snap missed)."""
    skin = base_skin_strict(base)
    band_end = y_top + int(round(0.6 * (y_bot - y_top)))
    h, w = skin.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    keep = []
    for sy in range(h):
        for sx in range(w):
            if skin[sy, sx] and labels[sy, sx] == 0:
                cur += 1
                stack = [(sy, sx)]
                labels[sy, sx] = cur
                ymin, ymax, n = sy, sy, 0
                while stack:
                    y, x = stack.pop()
                    n += 1
                    ymin = min(ymin, y)
                    ymax = max(ymax, y)
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                        if 0 <= ny < h and 0 <= nx < w and skin[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                # fist: small, lives in the hip band, doesn't reach shin rows
                if n <= 60 and ymin >= y_top - 8 and ymax <= band_end:
                    keep.append(cur)
    return np.isin(labels, keep)


def conform_to_body(frame, base, palette=None, xfer=None, body_pal=None,
                    dilate_n=1, max_gap=3):
    """Re-tailor a per-frame garment to the wearer's silhouette.

    Transfers are drawn on PixelLab's idea of the character, whose proportions
    can differ from the real base body (the female jeans transfers used a
    wider-bodied figure). Four steps:
      1. CLIP garment pixels to the body silhouette dilated by `dilate_n`
         (clothing may overhang ~1-2px, anything further floats in the air).
      2. CLOSE small interior gaps (<= max_gap, horizontal + vertical) so
         clipping never leaves bare-skin slivers inside the trouser legs.
      3. GROW denim downward along connected body pixels (waist to hem) to
         re-dress a far leg the transfer barely overlapped in profile poses.
      4. RE-ADD the original garment's 1px edge ring so hems keep their drawn
         curve instead of a flat mask cut."""
    body = base[..., 3] > 8
    bodyd = body.copy()
    for _ in range(dilate_n):
        bodyd = dilate1(bodyd)
    orig = frame.copy()
    out = frame.copy()
    keep = (out[..., 3] > 8) & bodyd
    out[~keep] = 0

    # The wearer's arm crossing the trouser zone must never carry garment
    # pixels: denim there covers the arm — the in-game "arms flashing" /
    # denim-mitten bug. Strip anything extraction kept there (the transfer's
    # hip denim lands on the wearer's swinging hand) and veto fill/dressing.
    ys0 = np.nonzero(keep.any(axis=1))[0]
    if len(ys0):
        occl = arm_occlusion(xfer, body_pal, int(ys0.min()), int(ys0.max()), base)
        occl |= dilate1(fist_blobs(base, int(ys0.min()), int(ys0.max())))
        # NOTE: do NOT add whole-arm strict-skin components here — on frames
        # where a pumping fist touches the raised knee the skin merges and
        # the entire front leg gets classified as arm (tried 2026-06-11,
        # stripped a leg bare). Orphan-chunk removal below handles what the
        # snap misses.
        out[occl] = 0
    else:
        occl = np.zeros((FS, FS), dtype=bool)

    for _ in range(2):  # two passes let h/v closings compound
        a = out[..., 3] > 8
        # horizontal closing
        for y in range(FS):
            xs = np.nonzero(a[y])[0]
            for i in range(len(xs) - 1):
                x1, x2 = xs[i], xs[i + 1]
                if 1 < x2 - x1 <= max_gap + 1:
                    for x in range(x1 + 1, x2):
                        if body[y, x] and not a[y, x] and not occl[y, x]:
                            out[y, x] = out[y, x1]
        a = out[..., 3] > 8
        # vertical closing
        for x in range(FS):
            ys = np.nonzero(a[:, x])[0]
            for i in range(len(ys) - 1):
                y1, y2 = ys[i], ys[i + 1]
                if 1 < y2 - y1 <= max_gap + 1:
                    for y in range(y1 + 1, y2):
                        if body[y, x] and not a[y, x] and not occl[y, x]:
                            out[y, x] = out[y1, x]

    # Downward leg growth: in profile poses the transfer figure's far leg can
    # barely overlap the wearer's, so clipping strips a whole thigh that the
    # bounded closing cannot rebuild. Pants hang downward — grow denim row by
    # row into body pixels that sit directly under (±1 column) existing denim,
    # from the garment's top row to its hem row. Growth flows only through
    # connected body pixels, so it cannot jump the gap between the legs or
    # reach a swinging fist (arms connect upward, outside the garment band).
    a = out[..., 3] > 8
    ys_any = np.nonzero(a.any(axis=1))[0]
    if len(ys_any):
        y_top, y_hem = int(ys_any.min()), int(ys_any.max())
        legs = legs_mask_of(body, y_top, y_hem)
        # Strip garment pixels sitting on a NON-leg body part (a hand/forearm
        # swinging through the trouser zone) — the transfer may have drawn
        # denim there because ITS hand was elsewhere. Without this the hand
        # flashes blue on the frames it crosses the hip.
        hand_px = a & body & ~legs
        out[hand_px] = 0
        a = out[..., 3] > 8

        # GEODESIC DRESSING. Row-by-row growth cones cannot follow a lifted
        # shin that runs near-horizontal (run kick-back, jump tuck) and they
        # need a hem seed below the gap — frames where the transfer missed a
        # limb entirely stayed bare and flickered in-game. Jeans are
        # full-length: every leg pixel except the foot/ankle should wear
        # denim. So measure geodesic distance from the waist band THROUGH
        # connected leg pixels (follows a limb at any angle, can never cross
        # the transparent gap between legs) and dress everything closer than
        # (limb extent - foot_geo). The most distal pixels of each limb are
        # the foot, which stays bare. Colour comes from the BFS parent so
        # tones flow down the limb; uniform shading repaints in-body pixels
        # afterwards anyway.
        foot_geo = 10
        INF = 1 << 20
        dist = np.full((FS, FS), INF, dtype=np.int32)
        parent = {}
        q = deque()
        for y in range(y_top, min(y_top + 4, y_hem + 1)):
            for x in np.nonzero(legs[y])[0]:
                dist[y, x] = 0
                q.append((y, x))
        while q:
            y, x = q.popleft()
            for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                if 0 <= ny < FS and 0 <= nx < FS and legs[ny, nx] and dist[ny, nx] == INF:
                    dist[ny, nx] = dist[y, x] + 1
                    parent[(ny, nx)] = (y, x)
                    q.append((ny, nx))
        reach = dist[legs & (dist < INF)]
        if len(reach):
            hem_dist = max(0, int(reach.max()) - foot_geo)
            target = legs & (dist < INF) & (dist <= hem_dist) & ~a & ~occl
            # dress in BFS order so every new pixel can copy a parent colour
            order = sorted(zip(*np.nonzero(target)), key=lambda p: dist[p[0], p[1]])
            for (y, x) in order:
                if a[y, x]:
                    continue
                src = None
                # nearest already-dressed neighbour, else BFS parent chain
                for sy, sx in ((y-1,x),(y,x-1),(y,x+1),(y+1,x)):
                    if 0 <= sy < FS and 0 <= sx < FS and a[sy, sx]:
                        src = (sy, sx)
                        break
                if src is None:
                    p = parent.get((y, x))
                    while p is not None and not a[p]:
                        p = parent.get(p)
                    src = p
                if src is not None:
                    out[y, x] = out[src]
                    a[y, x] = True

    # Edge re-add: restore original garment pixels that touch the kept set
    # (one ring), so clipped hems/outlines keep their drawn curve instead of
    # a flat mask cut. Constrained INSIDE the body — any outside allowance
    # re-grows the wider transfer figure's hip flaps, which flicker in-game.
    ring = dilate1(a) & (orig[..., 3] > 8) & ~a & body & ~occl
    if len(ys_any):
        ring &= ~(body & ~legs)
    out[ring] = orig[ring]

    # Kept pixels OUTSIDE the body silhouette escape the ramp recolour below;
    # if they are body/skin-coloured they are transfer remnants (its tan shoe
    # or hand caught by the contaminated keying palette), not garment — drop
    # them. Genuine denim outline colours sit far from the body palette.
    if body_pal is not None:
        a = out[..., 3] > 8
        outside = a & ~body
        if outside.any():
            px = out[..., :3][outside].reshape(-1, 1, 3).astype(np.int64)
            d2 = ((px - body_pal[None, :, :]) ** 2).sum(axis=2).min(axis=1)
            ys, xs = np.nonzero(outside)
            bad = d2 <= RAMP_BODY_DIST ** 2
            out[ys[bad], xs[bad]] = 0

    # Orphan-chunk removal: a small garment island in the hip band sitting
    # on the wearer's skin and DISCONNECTED from the main garment mass is a
    # denim chunk on a pumping fist/forearm that the occlusion snap missed
    # (read in-game as a navy "satchel" on the arm). Real leg denim is
    # always connected to the waist mass after the geodesic dressing.
    a = out[..., 3] > 8
    if a.any() and len(ys_any):
        skin = base_skin_strict(base)
        hip_end = y_top + int(round(0.6 * (y_hem - y_top)))
        labels = np.zeros((FS, FS), dtype=np.int32)
        cur = 0
        sizes = {}
        for sy in range(FS):
            for sx in range(FS):
                if a[sy, sx] and labels[sy, sx] == 0:
                    cur += 1
                    stack = [(sy, sx)]
                    labels[sy, sx] = cur
                    n = 0
                    while stack:
                        y, x = stack.pop()
                        n += 1
                        for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1)):
                            if 0 <= ny < FS and 0 <= nx < FS and a[ny, nx] and labels[ny, nx] == 0:
                                labels[ny, nx] = cur
                                stack.append((ny, nx))
                    sizes[cur] = n
        if sizes:
            main = max(sizes, key=sizes.get)
            for cid, n in sizes.items():
                if cid == main or n > 50:
                    continue
                m = labels == cid
                ys_c = np.nonzero(m.any(axis=1))[0]
                on_skin = float((m & skin).sum()) / n
                if ys_c.max() <= hip_end and on_skin >= 0.4:
                    out[m] = 0

    # Uniform shading: recolour every in-body garment pixel from a luminance
    # ramp of the garment palette driven by the BASE BODY's own shading at
    # that pixel. Extracted and grown pixels then share one consistent tone
    # map (no two-tone patches), and shading is identical frame to frame
    # because the base art is consistent. Ring pixels outside the body keep
    # their original drawn colour (no body luminance exists there).
    if palette is not None:
        a = out[..., 3] > 8
        inb = a & body
        if inb.any():
            # The learn box catches stray transfer-figure skin/clothing (its
            # hands hang at hip height), so the raw palette's bright end is
            # skin-toned — ramping body luminance through it painted brightly
            # lit thighs brown ("bare leg" flicker). Keep only colours far
            # from the body palette; keying still uses the full palette.
            ramp_src = palette
            if body_pal is not None and len(palette):
                d2 = ((palette[:, None, :].astype(np.int64)
                       - body_pal[None, :, :]) ** 2).sum(axis=2).min(axis=1)
                clean = palette[d2 > RAMP_BODY_DIST ** 2]
                if len(clean) >= 4:
                    ramp_src = clean
            ramp = ramp_src[np.argsort(ramp_src.astype(np.float64).mean(axis=1))]
            blum = base[..., :3].astype(np.float64).mean(axis=2)
            vals = blum[inb]
            lo, hi = float(vals.min()), float(vals.max())
            span = max(1.0, hi - lo)
            idx = np.clip(((blum - lo) / span * (len(ramp) - 1)).round(), 0,
                          len(ramp) - 1).astype(np.int32)
            ys, xs = np.nonzero(inb)
            out[ys, xs, :3] = ramp[idx[ys, xs]]
    return out


def head_centroid(arr):
    """Centroid of the body's head region (top 28% of the body bbox). The
    head is the only part of the figure that never deforms — legs fold and
    arms swing, dragging the whole-body centroid around. A tee hangs from
    the shoulders, a fixed distance below the head, so tracking the head
    places it correctly even on deep jump crouches where the whole-body
    centroid mis-tracked by 8+ px and the tee landed on the hips."""
    m = arr[..., 3] > 8
    ys, xs = np.nonzero(m)
    top, bot = ys.min(), ys.max()
    cut = top + max(6, int(round(0.28 * (bot - top + 1))))
    sel = ys <= cut
    return float(xs[sel].mean()), float(ys[sel].mean())


def silhouette_offset(canon_base, target_base):
    """(dx, dy) aligning the canonical body onto the target body.

    Head-centroid estimate (rigid garments hang from the shoulders; see
    head_centroid), then a small local refinement. A global band search is
    NOT used — skin-on-skin luminance matching happily aligns the torso onto
    legs or head."""
    cx0, cy0 = head_centroid(canon_base)
    cx1, cy1 = head_centroid(target_base)
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


def anim_offsets(body, anim, direction, canon_base, bases, canon_tag="idle_f1"):
    """Smoothed silhouette offsets — cached per (body, anim, dir, canonical
    source frame). Rigid items may pick a non-idle canonical (see gen_item),
    and offsets are deltas FROM that source's base pose."""
    k = (body, anim, direction, canon_tag)
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
    body_pal = body_palette_of(body) if cfg.get("conform") else None
    print(f"{item} ({cfg['slot']}) body={body}: palette {len(palette)} colours")
    out_dir = OUT_DIR.format(slot=cfg["slot"], item=item, body=body)
    os.makedirs(out_dir, exist_ok=True)

    # The transfers do not draw the same garment in every direction (female
    # east idle came back as a LONG-SLEEVE top with a hip-length hem; male
    # east a cropped one) — a canonical cut from a bad source poisons every
    # animation of that direction, and the avatar changes shirts as it
    # turns. Most candidates across all directions ARE the proper fitted
    # tee, so select per direction by CONSENSUS: the candidate whose pixel
    # count and row extent sit closest to the medians of the whole pool.
    canon_pick = {}
    if cfg["mode"] == "rigid":
        # IDLE frames only: a walk/run-sourced cutout carries that pose's
        # lean baked into its shape and slumps forward on upright frames.
        # Garment-style drift between directions (the east transfers drew a
        # long-sleeve) is less wrong than a pose-broken shirt; consensus
        # row-trimming below still removes its hair blob and crops the hem.
        CANDS = [("idle", 1), ("idle", 2), ("idle", 3), ("idle", 4)]
        pool = {}
        for direction in PRIMARY_DIRS:
            cands = []
            for c_anim, c_fi in CANDS:
                cb = base_frame(body, c_anim, direction, c_fi)
                cx = xfer_frame(body, item, c_anim, direction, c_fi)
                if cx is None:
                    continue
                cut = extract(cb, cx, palette, cfg)
                m = cut[..., 3] > 8
                n = int(m.sum())
                if n < 60:
                    continue
                ys = np.nonzero(m.any(axis=1))[0]
                cands.append({"cut": cut, "base": cb, "n": n,
                              "ymin": int(ys.min()), "ymax": int(ys.max()),
                              "tag": f"{c_anim}_f{c_fi}"})
            pool[direction] = cands
        all_c = [c for cs in pool.values() for c in cs]
        med_n = float(np.median([c["n"] for c in all_c]))
        med_y0 = float(np.median([c["ymin"] for c in all_c]))
        med_y1 = float(np.median([c["ymax"] for c in all_c]))
        for direction in PRIMARY_DIRS:
            best = min(pool[direction], key=lambda c: (
                abs(c["n"] - med_n) / max(1.0, med_n)
                + abs(c["ymin"] - med_y0) / 12.0
                + abs(c["ymax"] - med_y1) / 12.0))
            # Row-trim to the consensus garment band: kills the transfer
            # figure's hair blob riding above the collar and crops a hip-
            # length hem back to tee proportions.
            r0 = max(0, int(round(med_y0)) - 1)
            r1 = min(FS, int(round(med_y1)) + 3)
            best["cut"][:r0, :] = 0
            best["cut"][r1:, :] = 0
            canon_pick[direction] = best
            print(f"  {direction}: canonical from {best['tag']} "
                  f"(n={best['n']} rows {best['ymin']}-{best['ymax']}; "
                  f"medians n={med_n:.0f} rows {med_y0:.0f}-{med_y1:.0f})")

    for direction in PRIMARY_DIRS:
        canon_base = base_frame(body, "idle", direction, 1)
        canon = None
        canon_tag = "idle_f1"
        if cfg["mode"] == "rigid":
            pick = canon_pick[direction]
            canon = pick["cut"]
            canon_base = pick["base"]
            canon_tag = pick["tag"]
            if (canon[..., 3] > 8).sum() < 80:
                print(f"  WARNING {direction}: canonical cutout only "
                      f"{(canon[..., 3] > 8).sum()}px — check transfer/palette")
        for anim in ANIMS:
            nf = FRAME_COUNTS[anim]
            bases = [base_frame(body, anim, direction, fi) for fi in range(1, nf + 1)]
            offs = anim_offsets(body, anim, direction, canon_base, bases, canon_tag)
            frames = []
            use_rigid = (cfg["mode"] == "rigid"
                         and anim not in cfg.get("perframe_anims", ()))
            if use_rigid:
                frames = [shift_rgba(canon, dx, dy) for (dx, dy) in offs]
            else:
                raw = []
                xfers = []
                for fi in range(1, nf + 1):
                    x = xfer_frame(body, item, anim, direction, fi)
                    xfers.append(x)
                    fr = None if x is None else extract(bases[fi - 1], x, palette, cfg)
                    if fr is not None and cfg.get("conform"):
                        # conform BEFORE the borrow decision: a frame left too
                        # thin by re-tailoring should borrow a neighbour
                        fr = conform_to_body(fr, bases[fi - 1], palette, x, body_pal)
                    elif fr is not None and cfg["mode"] == "rigid":
                        # per-frame anim of a rigid upper-body item: clip to
                        # the wearer's silhouette, no trouser machinery
                        fr = clip_simple(fr, bases[fi - 1])
                    raw.append(fr)
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
                        borrowed = shift_rgba(raw[j], ddx, ddy)
                        if cfg.get("conform"):
                            # re-fit the borrowed pose to THIS frame's body;
                            # occlusion-gate against THIS frame's transfer
                            conf = conform_to_body(borrowed, bases[i],
                                                   palette, xfers[i], body_pal)
                            if (conf[..., 3] > 8).sum() < floor:
                                # wild airborne tucks: conform re-shrinks the
                                # borrow below the floor — a plain body clip
                                # of the neighbour pose keeps the legs dressed
                                alt = clip_simple(borrowed, bases[i])
                                if (alt[..., 3] > 8).sum() > (conf[..., 3] > 8).sum():
                                    conf = alt
                            borrowed = conf
                        elif cfg["mode"] == "rigid":
                            borrowed = clip_simple(borrowed, bases[i])
                        frames.append(borrowed)
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
