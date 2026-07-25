"""Bake RUN + JUMP overlay frames for face/eye accessories, PER GENDER.

Why: head accessories had no run/jump art, so the engine fell back to the WALK
overlay + a translation offset. On side/diagonal run and on jump the head ROTATES
and moves a lot, which a translation can't follow — the accessory floated off
("double head / visible eyes"). This bakes proper run+jump frames by warping the
walk overlay onto each pose.

Two warp modes:
  • masks (face_accessory): rigid head warp — rotate about the neck by the head's
    tilt + translate. The mask covers the whole face, so the tilt reads correctly.
  • eyewear (eyes_accessory): EYE-ANCHORED translation, NO rotation — thin frames
    fragment when rotated, so keep them level and pinned to the eye.

PER GENDER: the run/jump body POSES differ between male and female, so male-fitted
art doesn't sit right on the female body. We bake each gender from its OWN body
sheets into its own dir. Walk/idle overlays (which fit both genders — already
shipped shared) are copied into the female dir so the gendered loader finds a full
set. After running, set these items to fitProfile 'gendered' + FULL_ANIMS.

Usage: python tools/warp-accessory-run.py
"""
import math
import os
import shutil

import numpy as np
from PIL import Image
from scipy import ndimage

FS = 92
NDIR = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
GENDERS = ["male", "female"]

EYEWEAR = ["sunglasses", "round_glasses", "aviators", "nerd_glasses", "3d_glasses", "eyepatch"]
MASKS = ["hockey_mask", "gas_mask", "plague_doctor", "ghost_mask", "tiki_mask"]
ITEMS = [("eyes_accessory", e) for e in EYEWEAR] + [("face_accessory", m) for m in MASKS]

RUN_N, JUMP_N, WALK_N = 6, 9, 6


def load_frames(path, n):
    a = np.asarray(Image.open(path).convert("RGBA"))
    return [a[:, i * FS:(i + 1) * FS].copy() for i in range(n)]


def head_component(fr):
    """Head silhouette = connected component holding the topmost opaque pixel,
    cut to its top ~24 rows (drops the torso). Robust to limbs UNLESS a limb is the
    single topmost pixel; jump poses keep the head highest so this holds."""
    op = fr[..., 3] > 16
    ys, xs = np.nonzero(op)
    if len(ys) == 0:
        return None, None
    t = int(ys.min())
    tx = int(xs[ys == t][0])
    lbl, _ = ndimage.label(op)
    head = (lbl == lbl[t, tx])
    hy, hx = np.nonzero(head)
    sel = hy < t + 24
    m = np.zeros((FS, FS), bool)
    m[hy[sel], hx[sel]] = True
    return m, t


def head_axis(fr):
    m, t = head_component(fr)
    if m is None:
        return None
    hy, hx = np.nonzero(m)
    crown_rows = hy <= t + 3
    neck_rows = hy >= t + 20
    if crown_rows.sum() < 2 or neck_rows.sum() < 2:
        return None
    crown = np.array([hx[crown_rows].mean(), float(t)])
    neck = np.array([hx[neck_rows].mean(), float(t + 22)])
    ax = crown - neck
    return neck, math.atan2(ax[1], ax[0])


def hair_centroid(fr):
    """Head anchor = centroid of the largest HAIR blob. Hair only ever sits on the
    head, so this ignores raised arms/hands — which the topmost-component detector
    latches onto in mid-air jump poses, flinging the accessory off the head. Falls
    back to the head component when no hair is found (bald/back edge cases)."""
    R, G, B = fr[..., 0].astype(int), fr[..., 1].astype(int), fr[..., 2].astype(int)
    op = fr[..., 3] > 16
    hair = op & (R > B + 8) & (R >= G) & (G >= B) & (R < 165) & (R > 35) & (G < 130)
    lbl, n = ndimage.label(hair)
    if n == 0:
        m, _ = head_component(fr)
        if m is None:
            return None
        ys, xs = np.nonzero(m)
        return np.array([xs.mean(), ys.mean()])
    sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
    big = 1 + int(np.argmax(sizes))
    hy, hx = np.nonzero(lbl == big)
    return np.array([hx.mean(), hy.mean()])


def head_centroid(fr):
    return hair_centroid(fr)


def eye_pos(fr):
    """Eye landmark in the face band, within the head component. Female irises are
    BLUE, male irises dark-BROWN, so try blue then dark. Band starts below the hair
    fringe. None when the eye isn't visible (back/3-4 views) → caller falls back."""
    m, t = head_component(fr)
    if m is None:
        return None
    R, G, B = fr[..., 0].astype(int), fr[..., 1].astype(int), fr[..., 2].astype(int)
    band = np.zeros((FS, FS), bool)
    band[t + 7:t + 18, :] = True
    region = m & band
    blue = (B > R + 8) & (B > 70) & region
    by, bx = np.nonzero(blue)
    if len(by) >= 1:
        return np.array([bx.mean(), by.mean()])
    dark = (R < 90) & (G < 82) & (B < 92) & region
    dy, dx = np.nonzero(dark)
    if len(dy) >= 1:
        return np.array([dx.mean(), dy.mean()])
    return None


def strip_hairskin(fr, item):
    """Remove baked-in HAIR/SKIN pixels from the overlay so only the accessory is
    left. The overlays were extracted with the character's hair/forehead attached;
    on walk that aligns with the body and is invisible, but once we WARP for run/
    jump the extra hair/skin shifts off the body and reads as a SECOND HEAD (masks)
    or a forehead patch stuck to the glasses (eyewear). Warm skin/hair is an
    R>G>B gradient — distinct from grey/white/black masks, glasses frames, lenses,
    and saturated colours. Warm-toned masks (plague leather, tiki wood) would be
    eaten by a full strip, so for those we only clear the hair FRINGE in the top
    band and leave the mask body."""
    R, G, B = fr[..., 0].astype(int), fr[..., 1].astype(int), fr[..., 2].astype(int)
    a = fr[..., 3] > 16
    warm = (R > B + 14) & (R > G + 2) & (G > B + 4) & a
    if item in ("plague_doctor", "tiki_mask"):
        ys, _ = np.nonzero(a)
        if len(ys):
            t = int(ys.min())
            band = np.zeros_like(warm)
            band[t:t + 9, :] = True
            warm = warm & band
    out = fr.copy()
    out[warm] = 0
    return out


def warp(fg, pivot, dtheta, trans):
    """Rotate fg about pivot by dtheta then translate. Inverse-mapped (no holes),
    nearest-neighbour (crisp)."""
    data = fg.astype(float)
    out = np.zeros_like(data)
    c, s = math.cos(-dtheta), math.sin(-dtheta)
    px, py = pivot
    tx, ty = trans
    yy, xx = np.mgrid[0:FS, 0:FS]
    X = xx - px - tx
    Y = yy - py - ty
    sx = c * X - s * Y + px
    sy = s * X + c * Y + py
    sxi = np.round(sx).astype(int)
    syi = np.round(sy).astype(int)
    m = (sxi >= 0) & (sxi < FS) & (syi >= 0) & (syi < FS)
    out[yy[m], xx[m]] = data[syi[m], sxi[m]]
    return out.astype(np.uint8)


def frame_mask(walk_ov, wbody, tbody, is_eyewear, is_jump):
    """Produce one warped overlay frame: transform walk_ov to match target body pose
    tbody, given the walk body pose wbody.

    Eyewear: eye-anchored translation (no rotation — thin frames fragment).
    Masks on RUN: rigid head warp (rotate to the tilted run head + translate).
    Masks on JUMP: TRANSLATION ONLY. The tucked mid-air poses make the crown->neck
      angle estimate unreliable (the 'neck' sample lands on a shoulder), so rotating
      flings the mask off; a hair-anchored translation keeps it locked to the head."""
    if is_eyewear:
        we, te = eye_pos(wbody), eye_pos(tbody)
        if we is not None and te is not None:
            trans = te - we
        else:
            wc, tc = head_centroid(wbody), head_centroid(tbody)
            if wc is None or tc is None:
                return walk_ov
            trans = tc - wc
        return warp(walk_ov, np.array([0.0, 0.0]), 0.0, trans)
    if is_jump:
        wc, tc = head_centroid(wbody), head_centroid(tbody)
        if wc is None or tc is None:
            return walk_ov
        return warp(walk_ov, np.array([0.0, 0.0]), 0.0, tc - wc)
    # mask on run: rigid head warp
    wa, ta = head_axis(wbody), head_axis(tbody)
    if wa is None or ta is None:
        return walk_ov
    (wn, wang), (tn, tang) = wa, ta
    return warp(walk_ov, wn, tang - wang, tn - wn)


def bake(slot, item, gender):
    is_eyewear = slot == "eyes_accessory"
    root = f"src/client/public/sprites/equipment/{slot}/{item}/{gender}"
    body = f"src/client/public/sprites/characters/{gender}"
    for d in NDIR:
        # Strip baked-in hair/skin from the SOURCE overlay so warping doesn't drag a
        # second head / forehead patch across the body. Walk/idle on disk stay
        # untouched (their hair aligns with the body); only run/jump are cleaned.
        walk_ov = [strip_hairskin(fr, item) for fr in load_frames(f"{root}/walk_{d}.png", WALK_N)]
        wbody = load_frames(f"{body}/walk_{d}.png", WALK_N)
        rbody = load_frames(f"{body}/run_{d}.png", RUN_N)
        jbody = load_frames(f"{body}/jump_{d}.png", JUMP_N)
        # RUN — frame i from walk frame i
        run = [frame_mask(walk_ov[i], wbody[i], rbody[i], is_eyewear, False) for i in range(RUN_N)]
        _save(run, f"{root}/run_{d}.png")
        # JUMP — frame i from walk frame min(i, WALK_N-1) (matches engine frame-lock)
        jump = [frame_mask(walk_ov[min(i, WALK_N - 1)], wbody[min(i, WALK_N - 1)], jbody[i], is_eyewear, True)
                for i in range(JUMP_N)]
        _save(jump, f"{root}/jump_{d}.png")


def _save(frames, path):
    sheet = np.zeros((FS, FS * len(frames), 4), dtype=np.uint8)
    for i, fr in enumerate(frames):
        sheet[:, i * FS:(i + 1) * FS] = fr
    Image.fromarray(sheet, "RGBA").save(path)


def ensure_female_walk_idle(slot, item):
    """The female dir needs walk+idle too (loader is now gendered). They fit both
    genders, so copy the shipped male overlays across if absent."""
    male = f"src/client/public/sprites/equipment/{slot}/{item}/male"
    fem = f"src/client/public/sprites/equipment/{slot}/{item}/female"
    os.makedirs(fem, exist_ok=True)
    for d in NDIR:
        for anim in ("walk", "idle"):
            src = f"{male}/{anim}_{d}.png"
            dst = f"{fem}/{anim}_{d}.png"
            if os.path.exists(src):
                shutil.copyfile(src, dst)


if __name__ == "__main__":
    for slot, item in ITEMS:
        male_root = f"src/client/public/sprites/equipment/{slot}/{item}/male"
        if not os.path.isdir(male_root):
            print(f"  SKIP {slot}/{item} (no male dir)")
            continue
        ensure_female_walk_idle(slot, item)
        for gender in GENDERS:
            bake(slot, item, gender)
        mode = "eye-anchor" if slot == "eyes_accessory" else "head-warp"
        print(f"  {slot}/{item}: baked run+jump for male+female ({mode})")
    print("DONE — set these items to fitProfile 'gendered' + FULL_ANIMS in items.ts")
