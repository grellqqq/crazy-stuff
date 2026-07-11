"""Exhaustive per-frame audit of the top overlays, judged on the FINAL
COMPOSITE (base body + overlay) — the same pixels the player sees.

Detectors per (item, body, anim, dir, frame), east-side dirs only (the engine
renders west-facing keys as flipped east sheets — west files never ship):
  WHITE  visible white underwear / white-patch px in the garment zone
         (excludes the segmented head, so eye-whites don't count)
  HAIR   garment px painted onto the segmented HAIR (wrong-direction heads,
         hood ghosting)
  SKIN   visible skin px above the hem outside head + the LEGIT bare zones
         (hand_zone + a small neck/AA tolerance) — a naked arm/shoulder is
         skin that has no business being visible
  EMPTY  near-empty overlay frame
  FLICKER (idle only) frame-to-frame garment IoU within a direction — idle
         poses barely move, so a garment feature appearing/disappearing
         between frames (hood flash, collar pop) tanks the IoU

Every flagged frame is also rendered into tools/preview-output/audit_flags.png
for eyeballing. Exit code 1 if any frame is flagged.

Usage: python tools/audit-tops.py [--items worn_hoodie,leather_jacket]
"""
import importlib.util
import os
import sys

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("x4", "tools/extract-overlays-v4.py")
x4 = importlib.util.module_from_spec(spec)
sys.modules["x4"] = x4
spec.loader.exec_module(x4)

FS = 92
DIRS = ["south", "south-east", "east", "north-east", "north"]
ANIMS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
ITEMS = ["worn_hoodie", "leather_jacket"]
if "--items" in sys.argv:
    ITEMS = sys.argv[sys.argv.index("--items") + 1].split(",")

WHITE_MAX = 8      # visible white px allowed in the garment zone
HAIR_MAX = 12      # garment px allowed on the hair (AA edges at the collar)
SKIN_TOL = 40      # neck sliver + wrist/AA gaps beyond head+hand_zone
# Idle garment SHAPE overlap between consecutive frames, AFTER aligning by
# the body's own centroid shift (a 1px breathing bob on a 15px-wide profile
# garment already drops raw IoU to ~0.72 — that is position, not flicker).
# 0.82: per-frame synth tracks the breathing silhouette (legit 0.84-0.88,
# verified visually as identical garments); real design pops (hood appearing,
# jacket opening) measured 0.56-0.78.
IDLE_IOU_MIN = 0.82

flags = []
flag_imgs = []

for item in ITEMS:
    for body in ["male", "female"]:
        broot = f"tools/pixellab-downloads/v2/base-{body}-frames"
        oroot = f"src/client/public/sprites/equipment/upper_body/{item}/{body}"
        if not os.path.isdir(oroot):
            print(f"  (skip {item}/{body} — no sheets yet)")
            continue
        for anim, nf in ANIMS.items():
            for d in DIRS:
                osh = np.asarray(Image.open(f"{oroot}/{anim}_{d}.png").convert("RGBA"))
                prev_oop = None
                for f in range(nf):
                    base = np.asarray(Image.open(
                        f"{broot}/{anim}_{d}_f{f+1}.png").convert("RGBA")).astype(np.int16)
                    ov = osh[:, f*FS:(f+1)*FS]
                    oop = ov[..., 3] > 8
                    n = int(oop.sum())
                    reasons = []
                    if n < 120:
                        reasons.append(f"EMPTY({n})")
                    comp = base.copy()
                    comp[oop] = ov[oop]
                    head = x4.head_region(base)
                    # Guard the guard: a mis-segmented head silently blinds the
                    # WHITE/SKIN detectors (they exclude "head" pixels). A real
                    # head at this scale is 150-500 px.
                    hsz = int(head.sum())
                    if not (120 <= hsz <= 520):
                        reasons.append(f"HEADSZ({hsz})")
                    bop = base[..., 3] > 8
                    ys, xs = np.nonzero(bop)
                    top, bot = int(ys.min()), int(ys.max())
                    hem = top + int(round((bot - top) * 0.72))
                    r = comp[..., 0].astype(np.int32)
                    g = comp[..., 1].astype(np.int32)
                    b = comp[..., 2].astype(np.int32)
                    lum = (r + g + b) / 3.0
                    sat = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
                    zone = np.zeros((FS, FS), bool)
                    zone[max(0, top):hem + 2] = True
                    # exclude bright SKIN highlights (bare hands) — the base
                    # beneath is warm there; real underwear is neutral white
                    br = base[..., 0].astype(np.int32)
                    bb2 = base[..., 2].astype(np.int32)
                    skin_hl = (br - bb2) > 22
                    # visible-white check is capped at the BRIEFS TOP like the
                    # skin check: a waist-length top is not responsible for
                    # briefs visibility (pants cover that in real outfits) —
                    # only CHEST whites (the bra) are the top's problem.
                    uw_ys0, _ = np.nonzero(x4.underwear_mask(
                        base.astype(np.uint8), (0, FS)))
                    wzone = zone.copy()
                    if len(uw_ys0):
                        wzone[int(uw_ys0.min()) + 1:, :] = False
                    white = bop & wzone & ~head & (lum > 182) & (sat < 42) & ~oop & ~skin_hl
                    # NOTE: we only flag base-body white showing THROUGH the
                    # overlay (~oop) — actual bra/briefs. White INSIDE the
                    # overlay is legit garment detail (the brown jacket's
                    # silver studs/zipper, a white letter/stripe, etc.). The
                    # old black-leather "baked-in bra" rule that also counted
                    # inside-overlay white was removed when that item was
                    # redesigned as a closed brown jacket with silver hardware.
                    # only clusters ≥6 px matter (1-3px zipper/stud sparkle is art)
                    white = x4.components_keep(white, 6)
                    wn = int(white.sum())
                    if wn > WHITE_MAX:
                        reasons.append(f"WHITE({wn})")
                    # FACE detector: garment must never paint skin/eyes/mouth.
                    # Garment on the hair BACK is a worn hood — legitimate.
                    facepaint = x4.face_region(base) & oop
                    hn = int(facepaint.sum())
                    if hn > HAIR_MAX:
                        reasons.append(f"FACE({hn})")
                    # HEADCOVER: a hood-DOWN pullover must have NO garment at
                    # head height — not on the head AND not FLANKING it (the AI
                    # draws the down-hood/collar rising beside the neck, which
                    # recolours into "colours over the head"). Check the whole
                    # head band (rows at/above the head bottom, full width) on
                    # the base worn_hoodie AND every shipped hoodie_* recolor.
                    # Skip jump: the crouch tucks the head to collar height so
                    # the band test false-positives on legit torso garment.
                    if (item == "worn_hoodie" or item.startswith("hoodie_")) \
                            and anim != "jump":
                        headcover = int((oop & x4.head_band_clip(base)).sum())
                        if headcover > HAIR_MAX:
                            reasons.append(f"HEADCOVER({headcover})")
                    # HOODLESS: a hoodie's back views must show the hood (px on
                    # the hair back). Only meaningful for HOOD-UP-capable items;
                    # a clip_head hood-DOWN pullover deliberately carries no
                    # head garment (its hood nub sits BELOW the head, at the
                    # neck-base), so this test does not apply to it.
                    if item == "worn_hoodie" and d in ("north", "north-east") \
                            and not x4.ITEMS.get(item, {}).get("clip_head"):
                        hood_n = int((oop & head & ~x4.face_region(base)).sum())
                        if hood_n < 15:
                            reasons.append(f"HOODLESS({hood_n})")
                    # LEGIT bare zones: head + the geodesic hand ends. Any other
                    # visible skin above the hem is an undressed body part.
                    # Rows below the BRIEFS TOP are legs: on crouch poses the
                    # thighs fold up above the 0.72 hem row and false-flagged
                    # (legs are supposed to be bare).
                    hz = x4.hand_zone(base.astype(np.uint8),
                                      deep=(anim == "jump"))
                    uw_ys, _ = np.nonzero(x4.underwear_mask(
                        base.astype(np.uint8), (0, FS)))
                    skin_zone = zone.copy()
                    if len(uw_ys):
                        skin_zone[int(uw_ys.min()) + 2:, :] = False
                    skin_vis = bop & ~oop & ~head & ~hz & skin_zone & \
                        (r > b + 8) & (lum > 148) & (sat > 20)
                    skin_vis = x4.components_keep(skin_vis, 6)
                    sn = int(skin_vis.sum())
                    if sn > SKIN_TOL:
                        reasons.append(f"SKIN({sn})")
                    # IDLE FLICKER: consecutive idle frames are near-identical
                    # poses — the garment SHAPE must be too. Align the previous
                    # frame's garment by the body's centroid delta first so the
                    # breathing bob doesn't read as flicker.
                    if anim == "idle" and prev_oop is not None:
                        pcx, pcy = x4.body_centroid(prev_base)
                        ccx, ccy = x4.body_centroid(base)
                        dx0 = int(round(ccx - pcx))
                        dy0 = int(round(ccy - pcy))
                        tmp = np.zeros((FS, FS, 4), np.int16)
                        tmp[..., 3] = prev_oop * 255
                        # flicker = shape change NO ±1px translation explains
                        # (centroid rounding can disagree by 1px frame pair to
                        # frame pair, which is position noise, not flicker)
                        iou = 0.0
                        for ddx in (-1, 0, 1):
                            for ddy in (-1, 0, 1):
                                aligned = x4.shift_rgba(
                                    tmp, dx0 + ddx, dy0 + ddy)[..., 3] > 8
                                inter = int((oop & aligned).sum())
                                union = int((oop | aligned).sum())
                                iou = max(iou, inter / union if union else 1.0)
                        if iou < IDLE_IOU_MIN:
                            reasons.append(f"FLICKER({iou:.2f})")
                    prev_oop = oop
                    prev_base = base
                    if reasons:
                        flags.append(f"{item} {body} {anim}_{d} f{f+1}: {' '.join(reasons)}")
                        flag_imgs.append((comp.astype(np.uint8),
                                          f"{item[:9]} {body[:1]} {anim[:4]}_{d[:2]} f{f+1}"))

print(f"AUDIT: {len(flags)} flagged frames")
for fl in flags:
    print(" ", fl)

if flag_imgs:
    cell = 120
    cols = 8
    rows = (len(flag_imgs) + cols - 1) // cols
    sheet = Image.new("RGBA", (cell * cols, cell * rows), (110, 130, 110, 255))
    from PIL import ImageDraw
    dr = ImageDraw.Draw(sheet)
    for i, (arr, label) in enumerate(flag_imgs):
        im = Image.fromarray(arr).resize((cell, cell), Image.NEAREST)
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(im, (x, y))
        dr.text((x + 2, y + 2), label, fill=(255, 255, 0, 255))
    sheet.save("tools/preview-output/audit_flags.png")
    print("flagged frames rendered to tools/preview-output/audit_flags.png")

sys.exit(1 if flags else 0)
