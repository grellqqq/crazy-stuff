"""v4 equipment overlay extraction — ALIGNED-STATE DIFF.

The v3 pipeline extracted garments from "outfit transfer" art drawn on a
DIFFERENTLY-PROPORTIONED figure: every remaining defect class (denim on
swinging hands, bare thighs/shins, floating shirts, per-direction garment
style drift) came from inferring where the wearer's limbs are. v4 removes
the inference: each garment is generated as a PixelLab character STATE of
the SAME base character, animated with the SAME skeleton templates. Frames
are pose-aligned by construction, so:

    overlay = state_frame  WHERE  state_frame differs from base_frame

A limb drawn in front of the garment is identical in both renders → no
diff → no overlay there → the wearer's arm shows through, automatically.

Adding a new item later:
  1. create_character_state(base_id, "wearing <item>...", use_color_palette_from_reference=False)
  2. animate_character(state_id, template) for templates:
     walking, running-6-frames, jumping-1, breathing-idle  (all 8 dirs)
  3. write a urls.json manifest from get_character; python tools/fetch-frames.py <manifest>
  4. add the item below; python tools/extract-overlays-v4.py --body <b> <item>
  5. python tools/make-variants.py --body <b>; audit + preview + live check.

Usage: python tools/extract-overlays-v4.py [--body female|male] [items...]
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
STATE_DIR = "tools/pixellab-downloads/v4/{item}-{body}"
OUT_DIR = "src/client/public/sprites/equipment/{slot}/{item}/{body}"

SPECK_MIN = 4         # connected garment areas smaller than this are render noise

# diff_min = colour distance that counts as "garment changed this pixel".
# PER ITEM: jeans need 22 because shadowed rear limbs converge to near-black
# in both renders (dark denim vs dark skin ~30 apart); but 22 on the tee
# scoops up face/leg render noise (two renders shade the body subtly
# differently) — the validated tee threshold is 40.
ITEMS = {
    "worn_tshirt":     {"slot": "upper_body", "band": (28, 70), "diff_min": 40,
                        "gate": "grey", "fill_holes": True},
    # uniform_shade: source frames come from different generation batches
    # (template renders + transfer repairs) whose denim tone/wash drifts —
    # in motion that reads as per-frame flashing. Recoloring every overlay
    # pixel from ONE denim ramp keyed to the base body's own luminance makes
    # all frames tonally identical (ported from the v3 pipeline).
    "blue_jeans":      {"slot": "lower_body", "band": (42, 92), "diff_min": 22,
                        "uniform_shade": True, "gate": "cold",
                        "fill_holes": True},
    "beatup_sneakers": {"slot": "feet",       "band": (58, 92), "diff_min": 35,
                    "gate": "neutral",
                    # ground anims: feet never rise above row 68 — clamping
                    # kills shin render-noise streaks riding above the shoes
                    "band_ground": (68, 92)},
    # Head accessories: shared (one /male/ set), walk+idle only, 92px frame like
    # the body. The head band isolates the hat (the state keeps hair/face, so the
    # only diff in the top rows is the hat itself, incl. hair it replaces).
    "beanie":          {"slot": "head_accessory", "band": (0, 24), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
}

# canonical denim ramp (dark -> light)
DENIM_RAMP = np.array([
    [24, 26, 38], [33, 37, 56], [40, 46, 70], [47, 56, 86],
    [56, 67, 99], [66, 79, 112], [78, 92, 125], [92, 106, 138],
], dtype=np.int32)


def uniform_shade(overlay, base):
    """Recolor in-body overlay pixels from DENIM_RAMP by base luminance."""
    a = overlay[..., 3] > 8
    inb = a & (base[..., 3] > 8)
    if not inb.any():
        return overlay
    blum = base[..., :3].astype(np.float64).mean(axis=2)
    vals = blum[inb]
    lo, hi = float(vals.min()), float(vals.max())
    span = max(1.0, hi - lo)
    idx = np.clip(((blum - lo) / span * (len(DENIM_RAMP) - 1)).round(), 0,
                  len(DENIM_RAMP) - 1).astype(np.int32)
    out = overlay.copy()
    ys, xs = np.nonzero(inb)
    out[ys, xs, :3] = DENIM_RAMP[idx[ys, xs]]
    return out


def load_rgba(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.int16)


def save_rgba(arr, path):
    Image.fromarray(arr.astype(np.uint8), "RGBA").save(path)


def frame_path(root, anim, direction, fi):
    return f"{root}/{anim}_{direction}_f{fi}.png"


def components_keep(mask, min_size):
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    keep = []
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
                if n >= min_size:
                    keep.append(cur)
    return np.isin(labels, keep)


def color_gate(state, kind):
    """Restrict kept pixels to the item's colour family — transfer-repaired
    frames redraw the whole figure slightly, so plain diff leaks face/arm
    noise; the gate keeps only plausibly-garment pixels (v3 lesson: diff
    locates, colour identifies)."""
    r = state[..., 0].astype(np.int32)
    g = state[..., 1].astype(np.int32)
    b = state[..., 2].astype(np.int32)
    sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    lum = (r + g + b) / 3.0
    if kind == "cold":      # denim: blue-ish/washed/near-black, never SKIN-warm
        return (b >= r - 18) & (b > 30)
    if kind == "grey":      # tee: desaturated mid tones; cap 190 keeps the
        # tee's lightest grey (~180) and excludes the white bra/briefs
        # shadows (195+) that flashed as white squares on chest/butt
        return (sat < 35) & (lum > 55) & (lum < 190)
    if kind == "neutral":   # sneakers: whites/greys/dark soles, never skin
        return (sat < 65) | (lum < 60)
    if kind == "headwear":  # grey/black hats: desaturated at any luminance
        # (keeps the hat + its black outline), rejects the warm skin pixels the
        # state redraws under the head band — the face-ghosting we saw.
        return sat < 40
    return np.ones((FS, FS), dtype=bool)


def extract_frame(base, state, band, diff_min=35, gate=None):
    """Overlay = state pixels that differ from the aligned base render."""
    y0, y1 = band
    sop = state[..., 3] > 8
    bop = base[..., 3] > 8
    d = state[..., :3].astype(np.int32) - base[..., :3].astype(np.int32)
    dist = np.sqrt((d ** 2).sum(axis=2))
    changed = (dist >= diff_min) | (sop & ~bop)
    m = sop & changed
    # transfer batches sometimes return frames with a baked-in WHITE
    # background (no_background flag failure) — the diff keeps that whole
    # sheet. Kill near-white pixels OUTSIDE the body silhouette; white
    # garment pixels (sneakers) sit inside the body and survive.
    st = state[..., :3].astype(np.int32)
    lum = st.mean(axis=2)
    sat = st.max(axis=2) - st.min(axis=2)
    m &= ~((lum > 233) & (sat < 16) & ~bop)
    if gate:
        m &= color_gate(state, gate)
    bandm = np.zeros_like(m)
    bandm[y0:y1, :] = True
    m &= bandm
    m = components_keep(m, SPECK_MIN)
    out = np.zeros_like(state)
    out[m] = state[m]
    out[~m, 3] = 0
    return out


def underwear_mask(base, rows):
    """White bra/briefs pixels of the BASE body in the given row band —
    these must never peek through a worn garment (they read as flashing
    white squares between the tee hem and the jeans waistband)."""
    c = base[..., :3].astype(np.int32)
    lum = c.mean(axis=2)
    sat = c.max(axis=2) - c.min(axis=2)
    m = (base[..., 3] > 8) & (lum > 185) & (sat < 42)
    out = np.zeros((FS, FS), dtype=bool)
    out[rows[0]:rows[1], :] = True
    return m & out


def fill_holes(overlay, base, extra=None):
    """Fill INTERIOR holes of the overlay (transparent pockets fully
    enclosed by garment, sitting on the body) with the nearest garment
    colour. The white squares players saw on chest/butt were the BASE
    body's white bra/briefs showing through per-frame diff holes."""
    a = overlay[..., 3] > 8
    body = base[..., 3] > 8
    # flood the OUTSIDE from the frame border across non-overlay pixels
    outside = np.zeros((FS, FS), dtype=bool)
    stack = [(0, y) for y in range(FS)] + [(FS - 1, y) for y in range(FS)]           + [(x, 0) for x in range(FS)] + [(x, FS - 1) for x in range(FS)]
    free = ~a
    for x, y in stack:
        if free[y, x] and not outside[y, x]:
            st2 = [(y, x)]
            outside[y, x] = True
            while st2:
                cy, cx = st2.pop()
                for ny, nx in ((cy+1,cx),(cy-1,cx),(cy,cx+1),(cy,cx-1)):
                    if 0 <= ny < FS and 0 <= nx < FS and free[ny, nx] and not outside[ny, nx]:
                        outside[ny, nx] = True
                        st2.append((ny, nx))
    holes = free & ~outside & body
    if extra is not None:
        holes |= extra & free
    out = overlay.copy()
    cur = a.copy()
    for _ in range(8):
        todo = holes & ~cur
        if not todo.any():
            break
        ys, xs = np.nonzero(todo)
        for y, x in zip(ys, xs):
            for ny, nx in ((y-1,x),(y,x-1),(y,x+1),(y+1,x)):
                if 0 <= ny < FS and 0 <= nx < FS and cur[ny, nx]:
                    out[y, x] = out[ny, nx]
                    cur[y, x] = True
                    break
    return out


def feet_centroid(base):
    """Centroid of the body's lowest 12 rows (the feet)."""
    m = base[..., 3] > 8
    ys, xs = np.nonzero(m)
    cut = ys.max() - 12
    sel = ys >= cut
    return float(xs[sel].mean()), float(ys[sel].mean())


def body_centroid(base):
    """Centroid of the whole body silhouette (for torso/leg garment borrow)."""
    m = base[..., 3] > 8
    ys, xs = np.nonzero(m)
    return float(xs.mean()), float(ys.mean())


def shift_rgba(arr, dx, dy):
    out = np.zeros_like(arr)
    src_y = slice(max(0, -dy), min(FS, FS - dy))
    src_x = slice(max(0, -dx), min(FS, FS - dx))
    dst_y = slice(max(0, dy), min(FS, FS + dy))
    dst_x = slice(max(0, dx), min(FS, FS + dx))
    out[dst_y, dst_x] = arr[src_y, src_x]
    return out


def gen_item(item, body, cfg, bad=frozenset()):
    base_root = BASE_DIR.format(body=body)
    state_root = STATE_DIR.format(item=item, body=body)
    out_dir = OUT_DIR.format(slot=cfg["slot"], item=item, body=body)
    os.makedirs(out_dir, exist_ok=True)
    print(f"{item} ({cfg['slot']}) body={body}")
    anims = cfg.get("anims", ANIMS)
    missing = 0
    for direction in PRIMARY_DIRS:
        for anim in anims:
            nf = FRAME_COUNTS[anim]
            frames = []
            bases = []
            for fi in range(1, nf + 1):
                bp = frame_path(base_root, anim, direction, fi)
                sp = frame_path(state_root, anim, direction, fi)
                if not (os.path.exists(bp) and os.path.exists(sp)):
                    missing += 1
                    frames.append(None)
                    bases.append(load_rgba(bp) if os.path.exists(bp) else None)
                    continue
                base = load_rgba(bp)
                bases.append(base)
                band = cfg["band"]
                if anim != "jump" and "band_ground" in cfg:
                    band = cfg["band_ground"]
                fr = extract_frame(base, load_rgba(sp), band,
                                   cfg.get("diff_min", 35), cfg.get("gate"))
                if cfg.get("fill_holes"):
                    uw = None
                    if cfg["slot"] == "upper_body":
                        uw = underwear_mask(base, (24, 56))
                    elif cfg["slot"] == "lower_body":
                        uw = underwear_mask(base, (38, 70))
                    fr = fill_holes(fr, base, uw)
                if cfg.get("uniform_shade"):
                    fr = uniform_shade(fr, base)
                # FORCE-BORROW: source frames flagged by check-state-frames
                # (dropped garment / wrong-garment render, e.g. red boots)
                # produce garbage diffs no matter how many pixels they have —
                # zero them so the borrow pass below replaces them.
                if (item, anim, direction, fi) in bad:
                    fr = np.zeros_like(fr)
                frames.append(fr)
            # BORROW: the state renders occasionally drop a small garment on
            # 1-2 airborne frames (sneakers vanish at the jump apex). Borrow
            # the nearest good frame's overlay, shifted by the base feet/
            # body position delta so it lands on the limb.
            floor = 25 if cfg["slot"] == "feet" else 60
            centroid = feet_centroid if cfg["slot"] == "feet" else body_centroid
            good = [i for i, fr in enumerate(frames)
                    if fr is not None and (fr[..., 3] > 8).sum() >= floor]
            if good:
                for i, fr in enumerate(frames):
                    if fr is not None and (fr[..., 3] > 8).sum() >= floor:
                        continue
                    if bases[i] is None:
                        continue
                    j = min(good, key=lambda g: abs(g - i))
                    cx_i, cy_i = centroid(bases[i])
                    cx_j, cy_j = centroid(bases[j])
                    frames[i] = shift_rgba(frames[j],
                                           int(round(cx_i - cx_j)),
                                           int(round(cy_i - cy_j)))
            else:
                # WHOLE-ANIM dropout (every frame of this anim_dir lost the
                # garment in the state render — seen on med/dark jump). Borrow
                # frame 1 of another already-extracted anim of the SAME
                # direction, shifted per-frame by the base-body centroid delta.
                # ANIMS order puts idle/walk/run before jump, so their sheets
                # are on disk by the time jump needs a donor.
                for alt in anims:
                    if alt == anim:
                        continue
                    ap = f"{out_dir}/{alt}_{direction}.png"
                    dbp = frame_path(base_root, alt, direction, 1)
                    if not (os.path.exists(ap) and os.path.exists(dbp)):
                        continue
                    donor = load_rgba(ap)[:, :FS]
                    if (donor[..., 3] > 8).sum() < floor:
                        continue
                    dbase = load_rgba(dbp)
                    cx_j, cy_j = centroid(dbase)
                    for i in range(len(frames)):
                        if bases[i] is None:
                            continue
                        cx_i, cy_i = centroid(bases[i])
                        frames[i] = shift_rgba(donor,
                                               int(round(cx_i - cx_j)),
                                               int(round(cy_i - cy_j)))
                    print(f"    {anim}_{direction}: whole-anim dropout — "
                          f"borrowed {alt} f1")
                    break
            sheet = np.zeros((FS, FS * nf, 4), dtype=np.int16)
            for i, fr in enumerate(frames):
                if fr is not None:
                    sheet[:, i * FS:(i + 1) * FS] = fr
            save_rgba(sheet, f"{out_dir}/{anim}_{direction}.png")
        print(f"  {direction}: done")
    for anim in anims:
        for src, dst in MIRROR_PAIRS:
            sp = f"{out_dir}/{anim}_{src}.png"
            if os.path.exists(sp):
                ImageOps.mirror(Image.open(sp)).save(f"{out_dir}/{anim}_{dst}.png")
    print(f"  mirrored west-side; missing frames: {missing}")


def parse_bad_list(path, body):
    """Parse check-state-frames output into {(item, anim, dir, frame)} for
    this body. Lines look like: 'blue_jeans female-dark run east f3 (62px)'."""
    import re
    bad = set()
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"(\w+) ([a-z-]+) (\w+) ([a-z-]+) f(\d+)", line.strip())
        if m and m.group(2) == body:
            bad.add((m.group(1), m.group(3), m.group(4), int(m.group(5))))
    return bad


def main():
    raw = sys.argv[1:]
    body, items, bad_list = "female", [], None
    i = 0
    while i < len(raw):
        a = raw[i]
        if a == "--body":
            body = raw[i + 1]; i += 2
        elif a.startswith("--body="):
            body = a.split("=", 1)[1]; i += 1
        elif a == "--bad-list":
            bad_list = raw[i + 1]; i += 2
        else:
            items.append(a); i += 1
    if not items:
        items = list(ITEMS.keys())
    bad = parse_bad_list(bad_list, body) if bad_list else frozenset()
    if bad:
        print(f"force-borrowing {len(bad)} flagged source frames")
    for item in items:
        gen_item(item, body, ITEMS[item], bad)
    print("DONE")


if __name__ == "__main__":
    main()
