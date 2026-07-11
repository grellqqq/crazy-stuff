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
    # Tops (gendered, full anims). "noskin" gate keeps any garment colour and
    # rejects the warm arm/face skin the state redraws. Band covers collar→waist.
    # Ships walk/idle only: the diff method can't reliably extract the dynamic
    # run/jump poses (female run gap-flashed the back; jump airborne frames went
    # bare). Engine falls back run/jump -> walk, which frame-locks the clean
    # walk jacket onto the moving body.
    # REDESIGNED 2026-07-06 as a BROWN studded biker jacket, generated as full
    # dressed states (new-bar recipe) — replaces the old black transfer-pipeline
    # leather that vanished on the dark floor. Warm brown reads at gameplay
    # scale; synth backstop tone matches the leather so bent-pose sleeves blend.
    "leather_jacket":  {"slot": "upper_body", "band": (20, 76), "diff_min": 30,
                        "gate": "noskin", "fill_holes": True,
                        "anims": ["idle", "walk", "run", "jump"],
                        "band_run": (14, 76), "band_jump": (6, 78), "align": True,
                        "synth_sleeves": True, "synth_tone": (60, 135),
                        "synth_warm": 20, "clip_head": True, "debleed": True,
                        "ai_lock": False},
    # NEW-BAR DESIGNS (2026-07-05 pivot): generated as full dressed states on
    # the base skeleton templates, so run/jump poses match the base frames
    # 1:1 (same templates) — diff+align extraction, no transfers needed.
    # Varsity: red body + WHITE sleeves — synth tone is bright so the sleeve
    # backstop blends with the AI's white sleeves.
    "varsity_red":     {"slot": "upper_body", "band": (20, 76), "diff_min": 30,
                        "gate": "noskin", "fill_holes": True,
                        "anims": ["idle", "walk", "run", "jump"],
                        "band_run": (14, 76), "band_jump": (6, 78), "align": True,
                        "synth_sleeves": True, "synth_tone": (176, 236),
                        "synth_warm": 1, "clip_head": True, "debleed": True,
                        "ai_lock": False},
    "circuit_jacket":  {"slot": "upper_body", "band": (20, 76), "diff_min": 30,
                        "gate": "noskin", "fill_holes": True,
                        "anims": ["idle", "walk", "run", "jump"],
                        "band_run": (14, 76), "band_jump": (6, 78), "align": True,
                        "synth_sleeves": True, "synth_tone": (16, 64),
                        "synth_warm": 0, "clip_face": True, "ai_lock": False},
    "galaxy_hoodie":   {"slot": "upper_body", "band": (20, 76), "diff_min": 30,
                        "gate": "noskin", "fill_holes": True,
                        "anims": ["idle", "walk", "run", "jump"],
                        "band_run": (14, 76), "band_jump": (6, 78), "align": True,
                        "synth_sleeves": True, "synth_tone": (45, 110),
                        "synth_warm": -4, "clip_face": True, "ai_lock": False},
    "puffer_orange":   {"slot": "upper_body", "band": (20, 76), "diff_min": 30,
                        "gate": "noskin", "fill_holes": True,
                        "anims": ["idle", "walk", "run", "jump"],
                        "band_run": (14, 76), "band_jump": (6, 78), "align": True,
                        "synth_sleeves": True, "synth_tone": (150, 220),
                        "synth_warm": 14, "clip_head": True, "debleed": True,
                        "ai_lock": False},
    # REGENERATED 2026-07-08 as a new-bar item (like circuit/galaxy hoodies):
    # full dressed grey-hoodie template states, per-frame extraction. Replaces
    # the old transfer-pipeline + AI-LOCK recipe whose one-frame design-lock
    # gave a "frozen chest", whose hood-transplant lost the hood on some female
    # directions, and whose hood-zone/neck machinery bled colour onto the neck.
    # Neutral grey base → make-variants.py recolors into the 9-colour family.
    "worn_hoodie":     {"slot": "upper_body", "band": (20, 76), "diff_min": 30,
                        "gate": "noskin", "fill_holes": True,
                        "anims": ["idle", "walk", "run", "jump"],
                        "band_run": (14, 76), "band_jump": (6, 78), "align": True,
                        "synth_sleeves": True, "synth_tone": (70, 160),
                        "synth_warm": 0, "clip_head": True, "ai_lock": False},
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
    "top_hat":         {"slot": "head_accessory", "band": (0, 26), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    "snapback":        {"slot": "head_accessory", "band": (0, 24), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    "baseball_cap":    {"slot": "head_accessory", "band": (0, 24), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    "beret":           {"slot": "head_accessory", "band": (0, 26), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    "bucket_hat":      {"slot": "head_accessory", "band": (0, 24), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    "headband":        {"slot": "head_accessory", "band": (0, 28), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    "vr_headset":      {"slot": "head_accessory", "band": (0, 30), "diff_min": 30,
                        "gate": "headwear", "anims": ["idle", "walk"]},
    # Colored hats — "noskin" gate keeps any hat colour, rejects face skin.
    "bay_leaf_crown":  {"slot": "head_accessory", "band": (0, 26), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
    "beer_can_cap":    {"slot": "head_accessory", "band": (0, 26), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
    "helicopter_cap":  {"slot": "head_accessory", "band": (0, 24), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
    "tiara":           {"slot": "head_accessory", "band": (0, 24), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
    "halo":            {"slot": "head_accessory", "band": (0, 18), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
    "flaming_crown":   {"slot": "head_accessory", "band": (0, 24), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
    "traffic_cone_hat":{"slot": "head_accessory", "band": (0, 28), "diff_min": 28,
                        "gate": "noskin", "anims": ["idle", "walk"]},
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


def _largest_component(mask):
    """Boolean mask of the single largest 4-connected component."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    best_n, best_lbl = 0, 0
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
                    for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1)):
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] \
                                and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            stack.append((ny, nx))
                if n > best_n:
                    best_n, best_lbl = n, cur
    return labels == best_lbl if best_lbl else mask


def debleed_head_legs(fr, base):
    """Remove STRAY recoloured specks on the head/hair and on the legs (the
    'colour bleeding onto head and legs' report) WITHOUT touching the torso,
    arms, hem or hood — those are 'what's good' and must not change.

    Only acts in two zones: above the chin (head/hair) and below the hip
    (legs). There it drops overlay pixels that are NOT part of the main hoodie
    mass (largest connected component). The hood (connected via the shoulders)
    and a hem that dips onto the thigh (connected) are kept; disconnected
    islands on bare skin are dropped. The whole mid-body (chin→hip: torso,
    arms, collar, pocket) is left completely untouched."""
    m = fr[..., 3] > 8
    if not m.any():
        return
    hr = head_region(base)
    hy, _ = np.nonzero(hr)
    if not len(hy):
        return
    top = int(hy.min())
    chin = top + int(round(0.72 * (int(hy.max()) - top)))
    op = base[..., 3] > 8
    ys, _ = np.nonzero(op)
    bt, bb = int(ys.min()), int(ys.max())
    hip = bt + int(round((bb - bt) * 0.74))
    rows = np.arange(FS)[:, None]
    zone = (rows <= chin) | (rows > hip)
    drop = np.zeros((FS, FS), dtype=bool)
    if (m & zone).any():
        # (1) disconnected specks in the head + leg zones
        main = _largest_component(m)
        drop |= m & zone & ~main
    # (2) hem pixels sitting on BARE LEG-SKIN below the hip — a hoodie ends at
    # the hip and must not paint the thighs; this connected bleed is what the
    # component filter can't catch. Skin-gated so it only trims garment off
    # bare leg, never the torso/hem above the hip.
    c = base[..., :3].astype(np.int32)
    legskin = (c[..., 0] - c[..., 2] > 18) & (c.mean(axis=2) > 110)
    drop |= m & legskin & (rows > hip)
    if drop.any():
        fr[drop] = 0


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
    if kind == "greygarment":  # grey hoodie: keep desaturated/neutral pixels at
        # ANY luminance (incl. dark shading + black outline that dominate the thin
        # side profiles). The KEY is separating the hoodie from SKIN: measured,
        # male skin sits at r-b~85 / sat~85, while the grey hoodie — even with the
        # mild warm cast transfer-outfit-v2 bakes onto the male body — sits at
        # r-b~12 / sat~18. The old `r > b + 10` warm rule deleted half the male
        # hoodie as "skin"; real skin needs BOTH high r-b AND high saturation.
        skin = (r - b > 40) & (sat > 48)
        white_underwear = (lum > 200) & (sat < 30)
        return (sat < 78) & ~skin & ~white_underwear
    if kind == "noskin":    # colored hats: keep ANY hat colour, reject only the
        # warm face skin the state redraws under the band. Skin = reddish
        # (r>b), mid-bright, moderately saturated; vivid hats sit outside this.
        skin = (r > b + 8) & (r > 105) & (sat > 12) & (sat < 95) & (lum > 92)
        return ~skin
    return np.ones((FS, FS), dtype=bool)


def head_mask(base, head_h=20, half_w=13):
    """DEPRECATED geometric head blob — anchored at the SILHOUETTE TOP, which on
    arms-above-head poses is the HANDS, so the "head" box lands on the raised
    arms (clearing their sleeves) while the real head goes unprotected. Kept
    only as a fallback for frames where hair detection finds nothing."""
    op = base[..., 3] > 8
    ys, xs = np.nonzero(op)
    if len(ys) == 0:
        return np.zeros((FS, FS), dtype=bool)
    t = int(ys.min())
    crown = op[t:t + 5, :]
    cxs = np.nonzero(crown.any(axis=0))[0]
    cx = int(np.median(cxs)) if len(cxs) else FS // 2
    m = np.zeros((FS, FS), dtype=bool)
    x0, x1 = max(0, cx - half_w), min(FS, cx + half_w + 1)
    m[t:t + head_h, x0:x1] = True
    return m & op


_HEAD_TEMPLATES = None   # built lazily: one verified head patch per body+dir
_HEAD_MATCH_CACHE = {}   # base.tobytes() -> matched head mask


def _donor_head(base):
    """Head mask on an IDLE donor frame, where geometry is trivially safe:
    arms hang at the sides, so every silhouette pixel from the crown down to
    the neck row IS the head (hair + full face incl. chin/mouth + ears).
    A hair bob can drape a few rows below the neck line — absorb hair-coloured
    pixels there, horizontally bounded to the head span."""
    op = base[..., 3] > 8
    ys, _ = np.nonzero(op)
    top = int(ys.min())
    nr = neck_row(op)
    m = np.zeros((FS, FS), dtype=bool)
    m[top:nr, :] = True
    m &= op
    hy, hx = np.nonzero(m)
    x0, x1 = int(hx.min()), int(hx.max())
    r = base[..., 0].astype(np.int32)
    g = base[..., 1].astype(np.int32)
    b = base[..., 2].astype(np.int32)
    lum = (r + g + b) / 3.0
    hairish = op & (r > g) & (g >= b) & (r - b > 12) & (r - b < 100) & \
        (lum > 25) & (lum < 168)
    ext = np.zeros((FS, FS), dtype=bool)
    ext[nr:nr + 6, x0:x1 + 1] = True
    m |= ext & hairish
    return m


def _head_templates():
    """One (mask, rgb) head template per body+direction, cut from the idle_f1
    donor frames. Built once, reused for every frame of every anim."""
    global _HEAD_TEMPLATES
    if _HEAD_TEMPLATES is not None:
        return _HEAD_TEMPLATES
    dirs = ["south", "south-east", "east", "north-east", "north",
            "north-west", "west", "south-west"]
    tpls = []
    for body in ("male", "female"):
        for d in dirs:
            p = os.path.join(BASE_DIR.format(body=body), f"idle_{d}_f1.png")
            if not os.path.exists(p):
                continue
            donor = np.array(Image.open(p).convert("RGBA"))
            m = _donor_head(donor)
            ys, xs = np.nonzero(m)
            y0, y1 = int(ys.min()), int(ys.max()) + 1
            x0, x1 = int(xs.min()), int(xs.max()) + 1
            # FACE = head minus hair. The face-clip must protect skin/eyes/
            # mouth but ALLOW garment on the hair back (a hood legitimately
            # hugs the back of the head; clipping the whole head put the hood
            # sliver on a 1px knife-edge that flashed between frames).
            # Hair test is DELIBERATELY broad here (darkest male hair shade is
            # lum ~25 with blue>green — the narrow flood-window test called it
            # "face", which made the male back-view face template 188px and
            # punched a skin stripe down the spine). Bright skin is excluded
            # by lum<168, shadowed jaw skin by r-b>=100.
            r = donor[..., 0].astype(np.int32)
            g = donor[..., 1].astype(np.int32)
            b = donor[..., 2].astype(np.int32)
            lum = (r + g + b) / 3.0
            hairish = (r >= g) & (r - b > 10) & (r - b < 100) & \
                (lum >= 18) & (lum < 168)
            face = m & ~hairish
            # NECK TRIM: the head mask runs down to the neck row, so "face"
            # included the lower NECK skin — the face-clip then carved the
            # collar out of every garment (bare collarbones / "exposed
            # shoulder" on the female hoodie). A collar is allowed to cover
            # the neck base; only chin/mouth/eyes are untouchable.
            face[neck_row(donor[..., 3] > 8) - 2:, :] = False
            tpls.append({
                "mask": m[y0:y1, x0:x1],
                "face": face[y0:y1, x0:x1],
                "rgb": donor[y0:y1, x0:x1, :3].astype(np.int32),
                "body": body, "dir": d,
            })
    _HEAD_TEMPLATES = tpls
    return tpls


def head_region(base):
    """Head (hair + full face) of the base body via TEMPLATE MATCHING.

    Per-frame colour segmentation (hair-flood + face rows) was unstable: the
    female hair region spilled onto her shoulders/chest (sleeves vanished),
    the male chin/mouth fell outside the face rows on some frames (garment
    painted the face), and the mask size varied frame-to-frame (hood/garment
    flashing). The head templates are cut ONCE from the idle donors — where
    arms-down geometry makes the head unambiguous — and located in each frame
    by exhaustive RGB match. Same mask shape on every frame of a direction =>
    stable garments by construction. Falls back to the geometric crown box
    only if no template matches (should not happen on these bodies)."""
    return _match_head(base)[0].copy()


def face_region(base):
    """FACE-ONLY part of the matched head (skin/eyes/mouth, no hair) — the
    zone the garment overlay must never paint. Garment over the hair BACK is
    allowed (that's just a worn hood)."""
    return _match_head(base)[1].copy()


def head_band_clip(base):
    """Pixels a hood-DOWN pullover must never occupy: the head SHAPE plus a
    small horizontal halo (catch the hood/collar rising directly beside the
    head — the 'colours over the head' glitch), but ONLY down to the chin.

    Capping at the chin is essential: the matched head_region reaches the
    shoulder line (~42% of body height), so clipping its full bounding box
    bared the shoulders/upper chest. Restricting to the head SHAPE (not its
    box) keeps the shoulders, the chin cap keeps the neck + collar, and the
    4px halo removes only what flanks the head at head height."""
    hr = head_region(base)
    hy, _ = np.nonzero(hr)
    if not len(hy):
        return hr
    top = int(hy.min())
    chin = top + int(round(0.72 * (int(hy.max()) - top)))
    dil = hr.copy()
    for k in range(1, 5):                       # dilate the head shape ±4px in x
        dil[:, k:] |= hr[:, :-k]
        dil[:, :-k] |= hr[:, k:]
    dil[chin + 1:, :] = False                   # never below the chin
    return dil


def _match_head(base):
    key = base.tobytes()
    hit = _HEAD_MATCH_CACHE.get(key)
    if hit is not None:
        return hit
    op = base[..., 3] > 8
    if not op.any():
        z = np.zeros((FS, FS), dtype=bool)
        return z, z
    rgb = base[..., :3].astype(np.int32)
    best_score, best_place = 1e18, None
    for tpl in _head_templates():
        tm, trgb = tpl["mask"], tpl["rgb"]
        th, tw = tm.shape
        tn = int(tm.sum())
        # coarse (step 2) then 3x3 refine around the coarse best
        coarse_best, coarse_yx = 1e18, None
        for step, centers in ((2, None), (1, "refine")):
            if centers == "refine":
                if coarse_yx is None:
                    break
                cy, cx = coarse_yx
                ys_r = range(max(0, cy - 2), min(FS - th, cy + 2) + 1)
                xs_r = range(max(0, cx - 2), min(FS - tw, cx + 2) + 1)
            else:
                ys_r = range(0, FS - th + 1, step)
                xs_r = range(0, FS - tw + 1, step)
            for y in ys_r:
                for x in xs_r:
                    wop = op[y:y + th, x:x + tw]
                    valid = tm & wop
                    nv = int(valid.sum())
                    if nv < tn * 0.6:
                        continue
                    diff = np.abs(rgb[y:y + th, x:x + tw] - trgb)[valid].mean()
                    score = diff + (1.0 - nv / tn) * 80.0
                    if score < coarse_best:
                        coarse_best, coarse_yx = score, (y, x)
        if coarse_yx is not None and coarse_best < best_score:
            best_score, best_place = coarse_best, (tpl, coarse_yx)
    if best_place is None or best_score > 60.0:
        out = head_mask(base)
        _HEAD_MATCH_CACHE[key] = (out, out)
        return out, out

    def _place(tm):
        m = np.zeros((FS, FS), dtype=bool)
        th, tw = tm.shape
        m[y:y + th, x:x + tw] = tm
        # 1px dilate within the silhouette: covers anti-aliased edges and the
        # couple of px the animator nudged the head between frames
        d = m.copy()
        d[1:, :] |= m[:-1, :]
        d[:-1, :] |= m[1:, :]
        d[:, 1:] |= m[:, :-1]
        d[:, :-1] |= m[:, 1:]
        return d & op

    tpl, (y, x) = best_place
    result = (_place(tpl["mask"]), _place(tpl["face"]))
    _HEAD_MATCH_CACHE[key] = result
    return result


def neck_row(op):
    """Row of the neck (collar line) — the narrowest CENTRAL band just below the
    head crown. Measuring width only in a central column (cx±10) makes it robust
    to raised arms (jump) that would otherwise widen the upper rows. The search
    window is anchored to the CROWN (crown+8..crown+24, i.e. right below the
    chin) — searching further down (an early version used 45% of body height)
    found the WAIST on spread-eagle jump poses, which started the garment
    mid-chest and left the bra + upper arms exposed."""
    ys, xs = np.nonzero(op)
    top = int(ys.min())
    cx = int(np.median(xs))
    lo = max(0, cx - 10)
    hi = min(FS, cx + 11)
    y0 = top + 8
    y1 = min(FS - 1, top + 24)
    best_y, best_w = y0, 10 ** 9
    for y in range(y0, y1):
        w = int(op[y, lo:hi].sum())
        if w < best_w:
            best_w, best_y = w, y
    return best_y


def _trim_hands(op, garment, base, cuff=6):
    """Bare the HANDS: within the garment mask, drop the pixels at the far end of
    each arm. Uses geodesic (in-silhouette BFS) distance from a torso-core seed —
    the hand is always the farthest-along-the-arm part, in any pose — and removes
    the last `cuff` px of that distance, so the sleeve ends at the wrist."""
    from collections import deque
    ys, xs = np.nonzero(op)
    top, bot = int(ys.min()), int(ys.max())
    h = bot - top
    cx = int(np.median(xs))
    seed = np.zeros((FS, FS), dtype=bool)
    y0, y1 = top + int(h * 0.30), top + int(h * 0.60)
    seed[y0:y1, max(0, cx - 4):min(FS, cx + 5)] = True
    seed &= op
    if not seed.any():
        return garment
    dist = -np.ones((FS, FS), dtype=np.int32)
    dq = deque()
    for yy, xx in zip(*np.nonzero(seed)):
        dist[yy, xx] = 0
        dq.append((yy, xx))
    while dq:
        y, x = dq.popleft()
        d = dist[y, x] + 1
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < FS and 0 <= nx < FS and op[ny, nx] and dist[ny, nx] < 0:
                dist[ny, nx] = d
                dq.append((ny, nx))
    reach = dist >= 0
    g = garment & reach
    if not g.any():
        return garment
    maxd = int(dist[g].max())
    # PER-BRANCH trim: measuring from the single global extremity leaves the
    # SHORTER arm untrimmed on asymmetric poses (one "mitten" hand). Take the
    # far half of the distance field, split it into connected components (one
    # per limb end) and trim each within `cuff` of ITS OWN maximum.
    cand = g & (dist > maxd * 0.5)
    hand = np.zeros((FS, FS), dtype=bool)
    visited = np.zeros((FS, FS), dtype=bool)
    ys0, xs0 = np.nonzero(cand)
    for sy, sx in zip(ys0, xs0):
        if visited[sy, sx]:
            continue
        stack = [(sy, sx)]
        visited[sy, sx] = True
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1)):
                if 0 <= ny < FS and 0 <= nx < FS and cand[ny, nx] \
                        and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        cmax = max(dist[y, x] for y, x in comp)
        if cmax < maxd * 0.66:
            continue  # not a limb end (e.g. a mid-torso ridge)
        for y, x in comp:
            if dist[y, x] > cmax - cuff:
                hand[y, x] = True
    # Never trim WHITE-UNDERWEAR coverage: on tucked poses a geodesic
    # extremity can be the hip/bum — trimming there re-exposed the briefs.
    r = base[..., 0].astype(np.int32)
    g2 = base[..., 1].astype(np.int32)
    b2 = base[..., 2].astype(np.int32)
    lum2 = (r + g2 + b2) / 3.0
    sat2 = np.maximum(np.maximum(r, g2), b2) - np.minimum(np.minimum(r, g2), b2)
    white2 = (lum2 > 176) & (sat2 < 48)
    hand &= ~white2
    return garment & ~hand


def hand_zone(base, deep=False):
    """The per-branch geodesic hand ends of the base body — the zone where the
    FINAL overlay must be transparent so bare hands poke out of the cuffs.
    Trimming only the synth region wasn't enough: the AI layer composites on
    top and re-covers the hands ("mitten hands").
    deep=True (JUMP only): crouch poses compress the body so the hands dip
    below the 0.72 row and escaped the zone (grey-fist mittens on takeoff).
    Kept jump-only because on idle/walk a 0.85 region turns the thigh rows
    into fake 'limb ends' and the trim would bite the low female jacket hem."""
    op = base[..., 3] > 8
    ys, xs = np.nonzero(op)
    if len(ys) == 0:
        return np.zeros((FS, FS), dtype=bool)
    top, bot = int(ys.min()), int(ys.max())
    hem = top + int(round((bot - top) * (0.85 if deep else 0.72)))
    region = np.zeros((FS, FS), dtype=bool)
    region[:hem, :] = True
    pre = op & region & ~head_region(base)
    hz = pre & ~_trim_hands(op, pre, base, cuff=6)
    # Never bare the UNDERWEAR: on idle the hands hang right beside the hip,
    # and a trim component can lap onto the briefs — clearing the final
    # overlay there would let the briefs peek through the garment hem.
    c = base[..., :3].astype(np.int32)
    lum = c.mean(axis=2)
    sat = c.max(axis=2) - c.min(axis=2)
    hz &= ~((lum > 150) & (sat < 45))
    return hz


def torso_arm_region(base, anim):
    """Mask of the base body's torso + arms (NOT head, NOT hands, NOT legs) for
    any pose. A long sleeve IS the arm, so deriving the garment shape from the
    base body's own silhouette guarantees the sleeve tracks the arm in every
    pose — the thing the AI generation/transfer cannot do reliably.
      * head = hair-seeded head_region (tracks the real head in any pose)
      * hem  = 0.72 body height so it covers the hip but not the legs
      * hands are trimmed (geodesic) so bare hands poke out of the cuffs
    The region is NOT bounded by the collar ROW: shoulders and pumping/spread
    arms rise ABOVE the neck line on dynamic poses (run lean, jump apex), and a
    row-bounded region left them bare — the user's "naked arms" / "bra strap
    flash". Everything above the hem except the head blob is garment."""
    op = base[..., 3] > 8
    ys, xs = np.nonzero(op)
    if len(ys) == 0:
        return np.zeros((FS, FS), dtype=bool)
    top, bot = int(ys.min()), int(ys.max())
    h = bot - top
    # jump tucks compress the body: at 0.72 the hem lands mid-back and the
    # lower back peeked out bare — a slightly deeper hem on jump only
    hem = top + int(round(h * (0.80 if anim == "jump" else 0.72)))
    region = np.zeros((FS, FS), dtype=bool)
    region[:hem, :] = True
    head = head_region(base)
    sel = op & region & ~head
    # GUARANTEED UNDERWEAR COVERAGE: the white bra/briefs must never peek out.
    # A fill-based repair can be blocked by a 1px skin gap between the hem and
    # the briefs, so instead the garment region itself absorbs every white
    # underwear pixel (briefs slivers under the hem on bent/airborne poses).
    # Head is excluded so eye-whites are never painted.
    r = base[..., 0].astype(np.int32)
    g = base[..., 1].astype(np.int32)
    b = base[..., 2].astype(np.int32)
    lum = (r + g + b) / 3.0
    sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    uw = op & (lum > 176) & (sat < 48) & ~head
    uw[bot - 4:, :] = False  # never extend onto the feet rows
    sel |= uw
    # NECK/CHEST ABSORPTION (all anims): skin inside the head blob that is
    # NOT face — the lower neck under the chin, plus the chest the template
    # overhangs on tilted jump poses. Absorbing it gives the garment a
    # proper collar instead of a carved-out bare neckline ("naked collar,
    # shoulder exposed"). Hair fails the skin test, so this can only add
    # neck/chest pixels — never paints the hair.
    skin_j = op & (r > b + 20) & (lum > 110)
    sel |= head & ~face_region(base) & skin_j
    sel = _trim_hands(op, sel, base, cuff=6)
    return sel


def synth_sleeves(base, anim, target=(70, 160), warm=6):
    """Synthesize a garment from the base body's torso+arm pixels, luminance-
    preserved and tone-mapped into a target value range so it composites/recolors
    seamlessly with the AI torso layer. This is the deterministic backstop that
    guarantees clothed arms in every direction/pose. `target` = (lo, hi) value
    range (grey for recolored items, dark for leather); `warm` shifts R up / B
    down (negative = cool/blue, positive = warm/brown)."""
    sel = torso_arm_region(base, anim)
    out = np.zeros_like(base)
    if not sel.any():
        return out
    b = base.astype(np.float64)
    lum = (b[..., 0] + b[..., 1] + b[..., 2]) / 3.0
    vals = lum[sel]
    lo, hi = float(vals.min()), float(vals.max())
    span = max(1.0, hi - lo)
    t0, t1 = target
    g = np.clip(t0 + (lum - lo) / span * (t1 - t0), 0, 255)
    ys, xs = np.nonzero(sel)
    gv = g[ys, xs]
    out[ys, xs, 0] = np.clip(gv + warm, 0, 255).astype(np.uint8)
    out[ys, xs, 1] = gv.astype(np.uint8)
    out[ys, xs, 2] = np.clip(gv - warm * 0.5, 0, 255).astype(np.uint8)
    out[ys, xs, 3] = 255
    return out


def align_state_to_base(base, state, band, rng=5):
    """Run/jump state frames are a SEPARATE PixelLab generation from the base
    body, so their per-frame pose drifts a few px — the raw diff then yields
    garbage (bare backs, blobby borrows). Shift the state to best-match the
    base silhouette on the rows OUTSIDE the garment band (head + legs, which
    both share), so the garment lands on the body. Returns the shifted state."""
    y0, y1 = band
    bop = base[..., 3] > 8
    sop = state[..., 3] > 8
    region = np.zeros((FS, FS), dtype=bool)
    region[:y0, :] = True
    region[y1:, :] = True
    bref = bop & region
    if bref.sum() < 20:
        return state
    best, bestdx, bestdy = -1, 0, 0
    for dy in range(-rng, rng + 1):
        for dx in range(-rng, rng + 1):
            shifted = np.roll(np.roll(sop, dy, axis=0), dx, axis=1)
            ov = int((shifted & bref).sum())
            if ov > best:
                best, bestdx, bestdy = ov, dx, dy
    if bestdx == 0 and bestdy == 0:
        return state
    return shift_rgba(state, bestdx, bestdy)


def extract_frame(base, state, band, diff_min=35, gate=None, align=False,
                  no_diff=False, drop_head=False):
    """Overlay = state pixels that differ from the aligned base render.

    no_diff: for TRANSFERRED frames (garment redrawn onto the exact base pose),
    skip the colour-diff requirement entirely and let the colour GATE localise
    the garment. The diff was the wrong tool here — it dropped the grey hoodie
    where it sits over the base body's own grey-ish top (grey-on-grey, low diff)
    and clipped arms raised above the band. The gate already rejects skin/hair/
    underwear, so for a clean transferred state the gate alone is far more
    robust than diff+gate."""
    if align:
        state = align_state_to_base(base, state, band)
    y0, y1 = band
    sop = state[..., 3] > 8
    bop = base[..., 3] > 8
    if no_diff:
        m = sop.copy()
    else:
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
    if drop_head:
        m &= ~head_region(base)
    m = components_keep(m, SPECK_MIN)
    out = np.zeros_like(state)
    out[m] = state[m]
    out[~m, 3] = 0
    return out


def dilate2(mask):
    """2px 4-neighbour dilation."""
    d = mask.copy()
    for _ in range(2):
        n = d.copy()
        n[1:, :] |= d[:-1, :]
        n[:-1, :] |= d[1:, :]
        n[:, 1:] |= d[:, :-1]
        n[:, :-1] |= d[:, 1:]
        d = n
    return d


def hood_zone_mask(base):
    """Where a worn-down hood lives: the hair back of the matched head PLUS
    the upper back just below the hairline (the drooping part of the hood
    sits at shoulder level, not on the hair)."""
    head = head_region(base)
    hz = head & ~face_region(base)
    ys, xs = np.nonzero(head)
    if len(ys):
        hb, x0, x1 = int(ys.max()), int(xs.min()), int(xs.max())
        ext = np.zeros((FS, FS), dtype=bool)
        ext[hb + 1:hb + 10, max(0, x0 - 1):min(FS, x1 + 2)] = True
        hz |= ext & (base[..., 3] > 8)
    return hz


def paste_hood(fr, base, hood_entry):
    """Composite the direction's best hood (chosen once, by outline quality)
    onto this frame, anchored to the matched head position — the hood must
    not fade/pop between anims or frames. No-op when no hood was found."""
    if not hood_entry:
        return fr
    _, hood_rgba, hcx0, hcy0 = hood_entry
    hm_cur = head_region(base)
    hys, hxs = np.nonzero(hm_cur)
    if not len(hys):
        return fr
    hs = shift_rgba(hood_rgba, int(round(hxs.mean() - hcx0)),
                    int(round(hys.mean() - hcy0)))
    hm2 = (hs[..., 3] > 8) & hood_zone_mask(base) & ~face_region(base)
    fr[hm2] = hs[hm2]
    return fr


def finish_overlay(fr, base, anim, cfg):
    """Final per-frame clips shared by the direct path and the AI-lock
    rebuild: HEAD/FACE CLIP, BARE HANDS (clear the geodesic hand ends on the
    FINAL overlay; deep zone on jump crouches), and SEAM HEAL (fill 1-2px
    bare-skin slivers the tilted-head template overhang leaves down the spine
    on lean poses).

    clip_head clears the ENTIRE HEAD BAND — every overlay row at or above the
    bottom of the head, FULL WIDTH. For a hood-DOWN pullover the garment must
    never appear at head height: not on the head (clearing head_region alone
    left it), and not FLANKING the head either — the AI draws the down-hood /
    collar rising up beside the neck to head height, which recolours into a
    wrong-coloured mass 'over the head' (the exact glitch). The collar sits AT
    the neck line (head-bottom row) and the hood drapes onto the shoulders/
    back BELOW it, both preserved. clip_face (weaker) clears only skin/eyes/
    mouth — used by items that legitimately wear a hood UP."""
    if cfg.get("clip_head"):
        fr[head_band_clip(base)] = 0
        fr[face_region(base)] = 0     # also the face below the chin cap (jump)
    elif cfg.get("clip_face"):
        fr[face_region(base)] = 0
    if cfg.get("synth_sleeves"):
        fr[hand_zone(base, deep=(anim == "jump"))] = 0
        ys_b, _ = np.nonzero(base[..., 3] > 8)
        if len(ys_b):
            hem_sh = int(ys_b.min()) + int(
                round((ys_b.max() - ys_b.min()) * 0.72))
            head_clip = head_region(base) if cfg.get("clip_head") \
                else face_region(base)
            protect = head_clip | hand_zone(base, deep=(anim == "jump"))
            c3 = base[..., :3].astype(np.int32)
            skin3 = (c3[..., 0] - c3[..., 2] > 20) & \
                (c3.mean(axis=2) > 110)
            skin3[hem_sh:, :] = False
            for _ in range(2):
                fa3 = fr[..., 3] > 8
                cand = (base[..., 3] > 8) & ~fa3 & skin3 & ~protect
                left3 = np.zeros_like(fa3)
                left3[:, 1:] = fa3[:, :-1]
                right3 = np.zeros_like(fa3)
                right3[:, :-1] = fa3[:, 1:]
                fill3 = cand & left3 & right3
                if not fill3.any():
                    break
                ys3, xs3 = np.nonzero(fill3)
                fr[ys3, xs3] = fr[ys3, xs3 - 1]
            # FINAL re-clip: nothing (seam-heal, hand paste) may leave garment
            # at head height on a hood-down pullover.
            if cfg.get("clip_head"):
                fr[head_band_clip(base)] = 0
    # READABILITY AT GAMEPLAY SCALE (measured in-engine: the character is
    # ~50px on screen on a DARK floor — a near-black garment reads as a
    # formless blob). tone_lift raises the whole garment's value; rim_top
    # adds a light edge on upward-facing garment borders so the silhouette
    # pops. Purely cosmetic post-pass — shapes/clips untouched.
    if cfg.get("tone_lift") or cfg.get("rim_top"):
        fa4 = fr[..., 3] > 8
        if fa4.any():
            rgb4 = fr[..., :3].astype(np.float64)
            lift = float(cfg.get("tone_lift", 1.0))
            if lift != 1.0:
                cap = float(cfg.get("tone_cap", 255))
                rgb4[fa4] = np.clip(rgb4[fa4] * lift + 6.0, 0, cap)
            rim = int(cfg.get("rim_top", 0))
            if rim:
                above_empty = np.zeros_like(fa4)
                above_empty[1:, :] = ~fa4[:-1, :]
                above_empty[0, :] = True
                topedge = fa4 & above_empty
                rgb4[topedge] = np.clip(rgb4[topedge] + rim, 0, 255)
            fr[..., :3] = rgb4.astype(fr.dtype)
    # FINAL: remove stray recoloured specks on the head/hair and legs, leaving
    # the torso/arms/hem/hood untouched (Gabriel: colour bleeding onto head +
    # legs, but "don't ruin what's good" — the motion/shape).
    if cfg.get("clip_head") or cfg.get("debleed"):
        debleed_head_legs(fr, base)
    return fr


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


def chest_is_bare(state):
    """True if the centre-torso box of the STATE frame is mostly bare SKIN —
    i.e. the generation dropped the jacket there (the jumping-1 spread-eagle
    apex). Detecting skin in the source is robust where overlay pixel-counts
    fail (a thin surviving seam keeps the count above any threshold)."""
    box = state[28:48, 40:53, :]
    op = box[..., 3] > 8
    if op.sum() < 30:
        return True  # nothing there at all
    r = box[..., 0].astype(np.int32); g = box[..., 1].astype(np.int32); b = box[..., 2].astype(np.int32)
    lum = (r + g + b) / 3.0
    sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    skin = op & (r > b + 8) & (lum > 90) & (lum < 205)
    white = op & (lum > 178) & (sat < 42)            # bra / briefs showing through
    not_garment = skin | white
    # Aggressive: any meaningful skin/underwear in the centre torso => treat as
    # dropped and borrow a clothed frame. Erring toward over-patching keeps the
    # character always clothed (blobby apex preferred over a bare-chest flash).
    return not_garment.sum() >= 0.42 * op.sum()


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
    # WEST-SIDE handling. The default pipeline extracts the 5 east-side primaries
    # and MIRRORS them to west/north-west/south-west. That is only valid when the
    # BASE's west frames are pixel-mirrors of east — TRUE for run (0.00 mismatch),
    # FALSE for jump (0.24-0.69: the west jump renders are different poses), which
    # made every mirrored jump overlay land on a body doing something else
    # (fragments / "huge sprites" on A/AW/AS in-game). Two per-anim fixes:
    #   own_west_anims:   extract west dirs from their OWN transferred state files
    #                     (real garment detail; used for leather jump)
    #   synth_west_anims: build west dirs synth-only from the base silhouette
    #                     (free, always pose-correct; used for hoodie jump)
    WEST_DIRS = ["west", "north-west", "south-west"]
    own_west = cfg.get("own_west_anims", [])
    synth_west = cfg.get("synth_west_anims", [])
    # per direction: best hood found during idle/walk/run AI-lock, reused by
    # the jump hood transplant (anims run idle→walk→run→jump per direction)
    hood_best = {}
    for direction in PRIMARY_DIRS + WEST_DIRS:
        for anim in anims:
            west_side = direction in WEST_DIRS
            if west_side and anim not in own_west and anim not in synth_west:
                continue  # this anim's west dirs come from the mirror step
            force_synth = west_side and anim in synth_west
            nf = FRAME_COUNTS[anim]
            # Transferred anims (run/jump redrawn onto base poses) are clothed +
            # pose-aligned by construction — bypass the chest-bare borrow and the
            # silhouette align that the garment-dropping generation states needed.
            is_transferred = anim in cfg.get("transferred", [])
            frames = []
            bases = []
            barelist = []  # per-frame: jacket dropped on the chest in the state
            ai_meta = []   # per-frame gated AI layer + quality metrics (AI-lock)
            for fi in range(1, nf + 1):
                bp = frame_path(base_root, anim, direction, fi)
                sp = frame_path(state_root, anim, direction, fi)
                if force_synth:
                    # No state needed — the garment is synthesized entirely from
                    # the base body's own silhouette (correct pose by definition).
                    if not os.path.exists(bp):
                        missing += 1
                        frames.append(None)
                        bases.append(None)
                        barelist.append(True)
                        ai_meta.append(None)
                        continue
                    base = load_rgba(bp)
                    bases.append(base)
                    barelist.append(False)
                    ai_meta.append(None)
                    frames.append(synth_sleeves(base, anim,
                                                cfg.get("synth_tone", (70, 160)),
                                                cfg.get("synth_warm", 6)))
                    continue
                if not (os.path.exists(bp) and os.path.exists(sp)):
                    missing += 1
                    frames.append(None)
                    bases.append(load_rgba(bp) if os.path.exists(bp) else None)
                    barelist.append(True)
                    ai_meta.append(None)
                    continue
                base = load_rgba(bp)
                bases.append(base)
                st_img = load_rgba(sp)
                barelist.append(chest_is_bare(st_img)
                                if cfg["slot"] == "upper_body" and anim == "jump"
                                and not is_transferred
                                else False)
                band = cfg["band"]
                if anim != "jump" and "band_ground" in cfg:
                    band = cfg["band_ground"]
                # Per-anim band override: dynamic run/jump poses translate the
                # torso garment vertically, so a grounded torso band clips it.
                if f"band_{anim}" in cfg:
                    band = cfg[f"band_{anim}"]
                # Transferred frames are gate-localised (no diff). Run arms never
                # rise above the shoulders, so a tight top excludes the head; jump
                # raises arms AND translates the torso vertically, so it needs a
                # high top + the spatial head mask (drop_head) to kill hair specks.
                if is_transferred:
                    band = (24, 72) if anim == "run" else (6, 74)
                diff_min = cfg.get(f"diff_min_{anim}", cfg.get("diff_min", 35))
                fr = extract_frame(base, st_img, band,
                                   diff_min, cfg.get("gate"),
                                   align=cfg.get("align") and anim in ("run", "jump")
                                   and not is_transferred,
                                   no_diff=is_transferred,
                                   drop_head=is_transferred and anim == "jump")
                if cfg.get("fill_holes"):
                    uw = None
                    if cfg["slot"] == "upper_body":
                        # DYNAMIC underwear mask: white bra/briefs anywhere on the
                        # body except the head (eye-whites must never be painted).
                        # The old static row band (24,56) missed the underwear
                        # whenever the pose translated or bent (jump moves the
                        # body vertically; a bent-over run pushes the briefs
                        # below the band) — the bra/briefs then peeked through.
                        # fill_holes only recolours pixels within a few px of the
                        # garment, so far-away whites are untouched anyway.
                        uw = underwear_mask(base, (0, FS)) & ~head_region(base)
                    elif cfg["slot"] == "lower_body":
                        uw = underwear_mask(base, (38, 70))
                    fr = fill_holes(fr, base, uw)
                if cfg.get("uniform_shade"):
                    fr = uniform_shade(fr, base)
                # SYNTH SLEEVES: deterministic backstop for long-sleeve garments.
                # The AI drops/omits sleeves on bent-arm poses (run diagonals, jump
                # apex); a sleeve IS the arm, so we synthesize the whole torso+arm
                # garment from the base body's own silhouette (always aligned) and
                # composite the AI torso/hood ON TOP for detail. Guarantees clothed
                # arms in every direction/pose — no AI lottery.
                if cfg.get("synth_sleeves"):
                    layer = synth_sleeves(base, anim,
                                          cfg.get("synth_tone", (70, 160)),
                                          cfg.get("synth_warm", 6))
                    # synth_only can be global or per-body (a body whose transfer
                    # isn't done yet falls back to the clean synth shape instead of
                    # showing messy un-transferred AI).
                    synth_only = list(cfg.get("synth_only", []))
                    synth_only += cfg.get("synth_only_body", {}).get(body, [])
                    # PER-FRAME QUALITY GATE for transferred frames. The transfer
                    # lottery occasionally fails on extreme airborne poses in two
                    # ways: (a) POSE DRIFT — the state figure no longer matches the
                    # base pose, so garment pixels land at the wrong body position
                    # (floating fragments); (b) OVERSIZED garment ("giant bat
                    # wings" way past the silhouette — the user's "huge sprites").
                    # Both are measurable: (a) fraction of the STATE silhouette
                    # outside the BASE silhouette (pose-preserving transfers sit
                    # ≤0.10; drifted frames 0.2-0.7); (b) AI-layer pixels outside
                    # the base silhouette (normal jacket overhang <150; wings
                    # 300+). A failing frame drops its AI layer and ships the
                    # clean synth shape instead — never garbage. Thresholds are
                    # deliberately loose (0.28/300): mild drift 0.15-0.25 was
                    # user-approved visually; only catastrophic frames (wings at
                    # 0.66, black splay at 0.31) should fall back.
                    if is_transferred and anim not in synth_only:
                        sop_q = st_img[..., 3] > 8
                        bop_q = base[..., 3] > 8
                        mism = float((sop_q & ~bop_q).sum()) / max(1.0, float(sop_q.sum()))
                        fa_q = fr[..., 3] > 8
                        overh = int((fa_q & ~bop_q).sum())
                        if mism > 0.28 or overh > 300:
                            print(f"    quality-drop {anim}_{direction} f{fi}: "
                                  f"pose-mismatch {mism:.2f}, overhang {overh} -> synth")
                            fr = np.zeros_like(fr)
                    if anim in synth_only:
                        # AI states for this anim are unreliable (e.g. leather
                        # run/jump was never cleanly transferred) — use the clean
                        # synth jacket alone instead of layering the messy AI.
                        fr = layer
                        ai_meta.append(None)
                    else:
                        m = fr[..., 3] > 8
                        m_initial = int(m.sum())
                        # COLOUR-PLAUSIBILITY GATE (dark garments): the AI drew
                        # the female leather jacket OPEN over a white top/bra on
                        # some frames and closed on others — the white patch is
                        # baked INTO the overlay (noskin keeps white) and flashes
                        # frame to frame. Any big bright (or skin-warm) cluster
                        # can't be leather: drop it from the AI layer so the
                        # synth leather beneath shows (jacket reads closed on
                        # every frame). Small bright specks (zipper/stud shine)
                        # survive via the cluster-size floor.
                        # DARK-BLOB GATE (light garments): the transfer AI
                        # occasionally paints a large near-black slab across
                        # the grey hoodie's shadow side (run NE f4/f5 showed a
                        # half-black torso flashing mid-cycle). Black OUTLINES
                        # are legit and must stay — they are 1-2px THIN, so an
                        # erode/dilate open separates them from slabs: erosion
                        # kills thin lines, only blob cores survive.
                        if cfg.get("ai_drop_dark_blobs"):
                            fr3 = fr[..., :3].astype(np.int32)
                            ai_lum2 = fr3.mean(axis=2)

                            def _open_blob(sel):
                                er = sel.copy()
                                er[1:, :] &= sel[:-1, :]
                                er[:-1, :] &= sel[1:, :]
                                er[:, 1:] &= sel[:, :-1]
                                er[:, :-1] &= sel[:, 1:]
                                blob = er.copy()
                                blob[1:, :] |= er[:-1, :]
                                blob[:-1, :] |= er[1:, :]
                                blob[:, 1:] |= er[:, :-1]
                                blob[:, :-1] |= er[:, 1:]
                                return blob & sel

                            # same trick kills the WHITE spine stripe (a bright
                            # slab); thin cords/highlights survive the erosion
                            m = m & ~_open_blob(m & (ai_lum2 < 45))
                            m = m & ~_open_blob(m & (ai_lum2 > 172))
                        if cfg.get("ai_dark_max_lum"):
                            fr3 = fr[..., :3].astype(np.int32)
                            ai_lum = fr3.mean(axis=2)
                            ai_warm = fr3[..., 0] - fr3[..., 2]
                            ai_sat = fr3.max(axis=2) - fr3.min(axis=2)
                            implaus = m & ((ai_lum > cfg["ai_dark_max_lum"]) |
                                           ((ai_warm > 35) & (ai_sat > 45)))
                            implaus = components_keep(implaus, 6)
                            m = m & ~implaus
                        # Stash the gated AI layer + quality metrics for the
                        # post-loop AI-LOCK donor selection (px dropped by the
                        # plausibility/blob gates = open-jacket / slab frames).
                        ai_keep = np.zeros_like(fr)
                        ai_keep[m] = fr[m]
                        hood_zone = m & hood_zone_mask(base)
                        hood_px = int(hood_zone.sum())
                        # hood QUALITY is contrast, not size: a drawn hood has
                        # a dark outline; a flat grey patch does not
                        hood_dark = int((hood_zone &
                                         (fr[..., :3].astype(np.int32)
                                          .mean(axis=2) < 70)).sum())
                        # outline darkness DOMINATES: a drawn hood has a dark
                        # rim; a big flat grey patch must never outrank it
                        ai_meta.append({"ai": ai_keep, "px": int(m.sum()),
                                        "hood": hood_px,
                                        "hood_q": 12 * hood_dark + hood_px,
                                        "dropped": m_initial - int(m.sum())})
                        layer[m] = fr[m]
                        fr = layer
                if not cfg.get("synth_sleeves"):
                    ai_meta.append(None)
                # HOOD TRANSPLANT (jump): the AI-lock can't run on jump (poses
                # differ too much to reuse a whole AI layer), and drop_head
                # strips the state's own hood with its baked head. Paste the
                # direction's best hood (found during idle/walk/run of this
                # direction) anchored to each jump frame's head position.
                if cfg.get("synth_sleeves") and anim == "jump":
                    paste_hood(fr, base, hood_best.get(direction))
                fr = finish_overlay(fr, base, anim, cfg)
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
            # Jump apex (spread-eagle) frames reliably drop the torso garment in
            # generation, leaving ~100-200px of noise that clears the normal 60
            # floor but reads as bare. A high jump floor forces those frames to
            # borrow a clothed neighbour (shifted to the apex body position) so
            # the character never flashes bare mid-air.
            centroid = feet_centroid if cfg["slot"] == "feet" else body_centroid
            # AI-LOCK (idle/walk/run): the AI redraws the garment DESIGN per
            # frame — hood present on one frame and gone on the next, jacket
            # open on one frame and closed on the next — which reads in-game
            # as glitchy flashing no matter how clean each frame is on its
            # own. The garment's DETAIL layer is therefore chosen ONCE per
            # anim+direction (the best-scoring frame: fullest, hooded,
            # least gate-dropped garbage) and reused on every frame, shifted
            # to follow the body; the SYNTH layer stays per-frame so sleeves
            # keep tracking the limbs. Jump is excluded (poses differ too
            # much to reuse one AI layer) — it gets the hood transplant
            # in-loop instead.
            # GENERIC IDLE FRAME-LOCK (non-top garments: tee/jeans/sneakers).
            # Their engine-side idle used to PIN one frame while the body
            # bobs — visibly "static clothes on a moving character" (worse
            # now that rendering is crisp). Idle is a 1-2px breathing bob, so
            # ship frame 1's overlay translated by the body-centroid delta:
            # stable garment that FOLLOWS the body. items.ts then sets
            # idleAnimates on these items so the engine frame-locks to the
            # body instead of pinning.
            if anim == "idle" \
                    and (not cfg.get("synth_sleeves")
                         or not cfg.get("ai_lock", True)) \
                    and frames and frames[0] is not None \
                    and (frames[0][..., 3] > 8).sum() >= 25:
                cx0, cy0 = centroid(bases[0])
                for i in range(1, len(frames)):
                    if bases[i] is None:
                        continue
                    cx_i, cy_i = centroid(bases[i])
                    frames[i] = finish_overlay(
                        shift_rgba(frames[0],
                                   int(round(cx_i - cx0)),
                                   int(round(cy_i - cy0))),
                        bases[i], anim, cfg)
            # ai_lock=False (new-bar items): the generation is design-stable
            # per frame, so per-frame extraction wins — the lock's donor
            # pasting misplaces sleeves on leaning run poses ("glitched") and
            # replicates any weak-detail donor everywhere ("backwards" walk).
            if anim in ("idle", "walk", "run") and cfg.get("synth_sleeves") \
                    and cfg.get("ai_lock", True) \
                    and any(a for a in ai_meta if a):
                cands = [i for i, a in enumerate(ai_meta)
                         if a and a["px"] >= 60 and bases[i] is not None]
                if cands:
                    def _ai_score(a):
                        return a["px"] + 3 * a["hood"] - 4 * a["dropped"]
                    di = max(cands, key=lambda i: _ai_score(ai_meta[i]))
                    d_ai = ai_meta[di]["ai"]
                    dcx, dcy = body_centroid(bases[di])
                    # remember this direction's BEST hood (quality = dark
                    # outline px, not size — a flat grey patch isn't a hood).
                    # It is pasted onto EVERY anim below so the hood doesn't
                    # fade/pop when the player switches idle→walk→run→jump.
                    # Candidate = the hoodiest frame of THIS anim, not just
                    # the AI-lock donor.
                    # pure front views have no visible hood — capturing there
                    # would grab chest detail and paste a mixed design
                    hi = max(cands, key=lambda i: ai_meta[i]["hood_q"])
                    if direction not in ("south", "south-west") and \
                            ai_meta[hi]["hood_q"] > hood_best.get(direction, (0,))[0]:
                        h_ai = ai_meta[hi]["ai"]
                        hm_d = hood_zone_mask(bases[hi])
                        hood_rgba = np.zeros_like(h_ai)
                        selh = (h_ai[..., 3] > 8) & hm_d
                        hood_rgba[selh] = h_ai[selh]
                        hys, hxs = np.nonzero(head_region(bases[hi]))
                        hood_best[direction] = (ai_meta[hi]["hood_q"],
                                                hood_rgba,
                                                float(hxs.mean()),
                                                float(hys.mean()))
                    for i in range(len(frames)):
                        if bases[i] is None or ai_meta[i] is None:
                            continue
                        b_i = bases[i]
                        cx_i, cy_i = body_centroid(b_i)
                        ai_i = shift_rgba(d_ai, int(round(cx_i - dcx)),
                                          int(round(cy_i - dcy)))
                        # the pasted AI must stay on the garment: inside the
                        # (dilated) synth region or on the hair back (hood)
                        allowed = dilate2(torso_arm_region(b_i, anim)) | \
                            (head_region(b_i) & ~face_region(b_i))
                        am = (ai_i[..., 3] > 8) & allowed
                        layer_i = synth_sleeves(
                            b_i, anim, cfg.get("synth_tone", (70, 160)),
                            cfg.get("synth_warm", 6))
                        layer_i[am] = ai_i[am]
                        paste_hood(layer_i, b_i, hood_best.get(direction))
                        frames[i] = finish_overlay(layer_i, b_i, anim, cfg)
            # Upper-body jump: the generation drops the jacket on the chest for
            # the spread-eagle apex even though total px stay high (shoulders/
            # noise). Detect a BARE CHEST directly (empty centre-torso box) and
            # treat those frames as needing a clothed donor — count alone can't
            # tell a bare-chest apex from a clothed frame here.
            floor = 25 if cfg["slot"] == "feet" else 60
            if cfg["slot"] == "upper_body" and anim == "jump" and not is_transferred:
                # A jump frame is good iff the STATE kept the jacket on the chest
                # (barelist[i] False). Bare-chest apex frames borrow a clothed
                # neighbour — robust where overlay pixel-counts fail (a thin
                # surviving seam keeps the count up).
                def _ok(i, fr):
                    return fr is not None and not barelist[i]
            else:
                def _ok(i, fr):
                    return fr is not None and (fr[..., 3] > 8).sum() >= floor
            good = [i for i, fr in enumerate(frames) if _ok(i, fr)]
            if good:
                for i, fr in enumerate(frames):
                    if _ok(i, fr):
                        continue
                    if bases[i] is None:
                        continue
                    j = min(good, key=lambda g: abs(g - i))
                    cx_i, cy_i = centroid(bases[i])
                    cx_j, cy_j = centroid(bases[j])
                    shifted = shift_rgba(frames[j],
                                         int(round(cx_i - cx_j)),
                                         int(round(cy_i - cy_j)))
                    # Synth items: keep THIS frame's own synth underneath —
                    # the donor's sleeves sit at the donor's arm positions,
                    # so a plain overlay swap left this pose's arms bare.
                    # The donor detail is clipped to this frame's garment
                    # region so it can't float outside the body.
                    if cfg.get("synth_sleeves"):
                        layer_b = synth_sleeves(
                            bases[i], anim, cfg.get("synth_tone", (70, 160)),
                            cfg.get("synth_warm", 6))
                        allowed_b = dilate2(torso_arm_region(bases[i], anim)) | \
                            hood_zone_mask(bases[i])
                        mb = (shifted[..., 3] > 8) & allowed_b
                        layer_b[mb] = shifted[mb]
                        shifted = layer_b
                    # RE-CLIP after the shift: the borrowed overlay lands at a
                    # new body position, so the donor frame's face/hand clips
                    # no longer apply — without this, borrowed jump frames
                    # painted the garment across the FACE.
                    frames[i] = finish_overlay(shifted, bases[i], anim, cfg)
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
                        frames[i] = finish_overlay(
                            shift_rgba(donor,
                                       int(round(cx_i - cx_j)),
                                       int(round(cy_i - cy_j))),
                            bases[i], anim, cfg)
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
        if anim in own_west or anim in synth_west:
            continue  # west sheets were extracted/synthesized directly above
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
    # PURIST=1: strip every synthetic/corrective layer (synth sleeves, tone
    # lift, rim light, dark-blob gates) and ship the AI garment as drawn —
    # one COHESIVE pixel source. The stitched-together guarantees are
    # pixel-correct but read as AI mush at wardrobe zoom; the accepted
    # tee/jeans were pure single-source extractions.
    if os.environ.get("PURIST"):
        for _cfg in ITEMS.values():
            for k in ("synth_sleeves", "tone_lift", "rim_top", "tone_cap",
                      "ai_drop_dark_blobs", "ai_dark_max_lum"):
                _cfg.pop(k, None)
        print("PURIST mode: single-source extraction, no synthetic layers")
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
