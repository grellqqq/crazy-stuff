"""Bake mask RUN/JUMP overlays by head-locking the approved WALK mask art.

Why not extract run/jump from the AI generations? Two proven failure modes:
  (a) the masked-character run/jump renders are a separate generation whose
      per-frame head pose drifts vs the base body -> the extracted mask floats
      and jitters ("double head");
  (b) the FEMALE jump is different choreography from the male's (head up to
      13px away on the same frame index), so any male-derived sheet is wrong
      on female by construction.

A mask is a rigid object riding the head. The only trustworthy art is the
user-approved WALK overlay. So per (mask, gender, direction):
  1. canonical mask  = fullest frame of the approved walk overlay sheet
  2. A0 = head anchor (template-matched head_region centroid) of THAT gender's
     walk body frame the canonical mask sits on
  3. for every run/jump frame f: anchor Af of THAT gender's body frame
       -> overlay frame = canonical mask translated by round(Af - A0)
  4. back views (empty face_region) stay EMPTY - same rule that fixed the
     ghost-on-back-of-head bug for walk/idle.

Zero AI involvement, zero baked head/hair (hair-customization safe), and the
placement is verifiable offline frame-by-frame.

Also copies the approved walk/idle sheets into the /female/ folder so the
masks can switch to fitProfile 'gendered' (per-gender run/jump REQUIRES a
female folder; walk/idle art is shared-identical by design).

Usage: python tools/bake-mask-runjump.py
"""
import importlib.util
import os
import shutil

import numpy as np
from PIL import Image, ImageOps

spec = importlib.util.spec_from_file_location("xt", "tools/extract-overlays-v4.py")
xt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xt)

FS = 92
MASKS = ["hockey_mask", "gas_mask", "ghost_mask", "plague_doctor", "tiki_mask"]
GENDERS = ["male", "female"]
NATIVE = ["south", "south-east", "east", "north-east", "north"]
MIRROR = {"west": "east", "north-west": "north-east", "south-west": "south-east"}
TARGET_ANIMS = {"run": 6, "jump": 9}
BODY = "src/client/public/sprites/characters/{g}"
EQ = "src/client/public/sprites/equipment/face_accessory/{item}/{g}"


def sheet_frames(path, n):
    a = np.asarray(Image.open(path).convert("RGBA")).astype(np.int16)
    assert a.shape[1] == FS * n, f"{path}: width {a.shape[1]} != {FS*n}"
    return [a[:, i * FS:(i + 1) * FS] for i in range(n)]


def head_anchor(frame):
    hr = xt.head_region(frame)
    if not hr.any():
        return None
    ys, xs = np.nonzero(hr)
    return np.array([xs.mean(), ys.mean()])


def face_visible(frame):
    return bool(xt.face_region(frame).any())


checks = []  # (label, ok, detail) for the verification report

# ── BACK VIEWS (north sheets — shown when facing W) ─────────────────────────
# A worn mask must show its STRAP from behind, not vanish. The source art is
# unusable here (hockey/gas/ghost drew the mask FACE on the back of the head —
# the old W-flash bug), so:
#   band  — synthesize a strap across the back of the head from each target
#           frame's own head silhouette: pixel-perfect per gender/anim/frame,
#           nothing baked, hair-customization safe.
#   band2 — gas harness: two parallel straps.
#   hood  — plague: extract the REAL hood-back once from the source north
#           render (the only sensible source back), hair-stripped, and
#           head-anchor it per frame.
BACK = {
    "hockey_mask":   {"type": "band",  "color": (46, 46, 50)},
    "ghost_mask":    {"type": "band",  "color": (30, 28, 30)},
    "tiki_mask":     {"type": "band",  "color": (58, 36, 20)},
    "gas_mask":      {"type": "band2", "color": (56, 58, 48)},
    # plague: the hood-back extraction dragged in the source's grey HOODIE and
    # the hair-strip moth-ate the hood (hood is hair-brown) — a clean dark
    # leather strap wins over a dirty hood. (Hood code kept for reference.)
    "plague_doctor": {"type": "band",  "color": (54, 40, 30)},
}
BACK_ANIMS = {"walk": 6, "idle": 4, "run": 6, "jump": 9}


def synth_band(body_frame, color, second=False):
    """Strap band(s) across the back of the head, cut from the head silhouette."""
    out = np.zeros((FS, FS, 4), dtype=np.int16)
    hr = xt.head_region(body_frame)
    if not hr.any():
        return out
    ys, _ = np.nonzero(hr)
    top, bot = int(ys.min()), int(ys.max())
    H = max(1, bot - top)
    spans = [(0.42, 0.56)] if not second else [(0.30, 0.42), (0.54, 0.64)]
    hi = tuple(min(255, c + 14) for c in color)
    for r0, r1 in spans:
        y0 = top + int(round(r0 * H))
        y1 = max(y0 + 2, top + int(round(r1 * H)))
        first_row = True
        for y in range(y0, min(y1, FS)):
            xs = np.nonzero(hr[y])[0]
            if len(xs) < 3:
                continue
            col = hi if first_row else color
            out[y, xs.min():xs.max() + 1, :3] = col
            out[y, xs.min():xs.max() + 1, 3] = 255
            first_row = False
    return out


def plague_hood_back():
    """Canonical hood-back: source north render's head region, minus his hair
    (provenance strip vs the bare base), largest component. Returns (rgba,
    anchor) or (None, None)."""
    st = np.asarray(Image.open(
        "tools/pixellab-downloads/v4/plague_doctor-male/idle_north_f1.png"
    ).convert("RGBA")).astype(np.int16)
    bs = np.asarray(Image.open(
        "tools/pixellab-downloads/v2/base-male-frames/idle_north_f1.png"
    ).convert("RGBA")).astype(np.int16)
    hr = xt.head_region(bs)
    dil = hr.copy()
    for _ in range(2):
        d = dil.copy()
        d[1:, :] |= dil[:-1, :]; d[:-1, :] |= dil[1:, :]
        d[:, 1:] |= dil[:, :-1]; d[:, :-1] |= dil[:, 1:]
        dil = d
    sel = dil & (st[..., 3] > 16)
    diff = np.sqrt(((st[..., :3] - bs[..., :3]).astype(np.float64) ** 2).sum(-1))
    sel &= (diff > 16) | ~(bs[..., 3] > 16)
    # provenance strip: drop pixels matching his base hair within 3px
    bop = bs[..., 3] > 16
    matched = np.zeros((FS, FS), dtype=bool)
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            sb = np.roll(np.roll(bs[..., :3].astype(np.float64), dy, 0), dx, 1)
            sa = np.roll(np.roll(bop, dy, 0), dx, 1)
            d = np.sqrt(((st[..., :3].astype(np.float64) - sb) ** 2).sum(-1))
            matched |= sa & (d <= 22)
    R, G, B = st[..., 0], st[..., 1], st[..., 2]
    hairish = (R >= B) & ((R + G + B) / 3.0 < 165)
    sel &= ~(matched & hairish)
    sel = xt._largest_component(sel)
    if not sel.any():
        return None, None
    ov = np.zeros((FS, FS, 4), dtype=np.int16)
    ov[sel] = st[sel]
    ys, xs = np.nonzero(xt.head_region(bs))
    return ov, np.array([xs.mean(), ys.mean()])

for item in MASKS:
    male_dir = EQ.format(item=item, g="male")
    female_dir = EQ.format(item=item, g="female")
    os.makedirs(female_dir, exist_ok=True)
    # female walk/idle = the approved shared sheets, copied verbatim
    for anim in ("walk", "idle"):
        for d in NATIVE + list(MIRROR):
            src = f"{male_dir}/{anim}_{d}.png"
            if os.path.exists(src):
                shutil.copyfile(src, f"{female_dir}/{anim}_{d}.png")

    for g in GENDERS:
        out_dir = EQ.format(item=item, g=g)
        for d in NATIVE:
            # canonical mask: fullest frame of the APPROVED walk overlay
            wov = sheet_frames(f"{male_dir}/walk_{d}.png", 6)
            counts = [(f[..., 3] > 8).sum() for f in wov]
            ci = int(np.argmax(counts))
            canon = wov[ci]
            canon_px = int(counts[ci])
            wbody = sheet_frames(BODY.format(g=g) + f"/walk_{d}.png", 6)
            a0 = head_anchor(wbody[ci])

            for anim, nf in TARGET_ANIMS.items():
                body = sheet_frames(BODY.format(g=g) + f"/{anim}_{d}.png", nf)
                out = np.zeros((FS, FS * nf, 4), dtype=np.int16)
                prev = None
                for i in range(nf):
                    lbl = f"{item} {g} {anim}_{d} f{i+1}"
                    if canon_px == 0 or a0 is None or not face_visible(body[i]):
                        checks.append((lbl, True, "back-view: empty"))
                        continue
                    af = head_anchor(body[i])
                    if af is None:
                        checks.append((lbl, False, "no head anchor"))
                        continue
                    if prev is not None and np.abs(af - prev).max() > 8:
                        checks.append((lbl, True,
                                       f"WARN anchor jump {np.abs(af-prev).max():.0f}px"))
                    prev = af
                    dx, dy = int(round(af[0] - a0[0])), int(round(af[1] - a0[1]))
                    fr = xt.shift_rgba(canon, dx, dy)
                    out[:, i * FS:(i + 1) * FS] = fr
                    # self-check: translation must not clip the mask at borders
                    kept = int((fr[..., 3] > 8).sum())
                    ok = kept >= 0.95 * canon_px
                    checks.append((lbl, ok, f"px {kept}/{canon_px} shift({dx},{dy})"))
                xt.save_rgba(out, f"{out_dir}/{anim}_{d}.png")
        # BACK VIEWS: overwrite every north sheet (walk/idle/run/jump) with the
        # strap band / hood-back so the mask doesn't vanish when facing W.
        bk = BACK[item]
        hood, hood_a0 = (plague_hood_back() if bk["type"] == "hood" else (None, None))
        for anim, nf in BACK_ANIMS.items():
            body = sheet_frames(BODY.format(g=g) + f"/{anim}_north.png", nf)
            out = np.zeros((FS, FS * nf, 4), dtype=np.int16)
            for i in range(nf):
                lbl = f"{item} {g} {anim}_north f{i+1} (back)"
                if bk["type"] in ("band", "band2"):
                    fr = synth_band(body[i], bk["color"], second=(bk["type"] == "band2"))
                else:
                    fr = np.zeros((FS, FS, 4), dtype=np.int16)
                    if hood is not None:
                        af = head_anchor(body[i])
                        if af is not None:
                            fr = xt.shift_rgba(hood, int(round(af[0] - hood_a0[0])),
                                               int(round(af[1] - hood_a0[1])))
                out[:, i * FS:(i + 1) * FS] = fr
                checks.append((lbl, (fr[..., 3] > 8).sum() > 0, "back content"))
            xt.save_rgba(out, f"{out_dir}/{anim}_north.png")
        # west-side files: engine displays east-side textures flipped, these
        # files exist only so the loader finds them - mirror is fine
        for anim in TARGET_ANIMS:
            for dst, src in MIRROR.items():
                ImageOps.mirror(Image.open(f"{out_dir}/{anim}_{src}.png")) \
                    .save(f"{out_dir}/{anim}_{dst}.png")
    print(f"baked {item}")

bad = [c for c in checks if not c[1]]
warn = [c for c in checks if c[1] and "WARN" in c[2]]
print(f"\nframes baked/checked: {len(checks)}  FAIL: {len(bad)}  warnings: {len(warn)}")
for lbl, _, det in bad:
    print(f"  FAIL {lbl}: {det}")
for lbl, _, det in warn:
    print(f"  {det}: {lbl}")
