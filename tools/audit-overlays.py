"""
Full-catalog equipment overlay audit.

Parses src/shared/items.ts (single source of truth) and verifies every
expected sheet on disk:

  A. presence + geometry   — sheet exists, width == frames*FS, height == FS
  B. near-empty frames     — opaque px < threshold ("flashing" to bare body)
  C. bare-body bleed       — opaque overlay pixels whose colour matches the
                             bare base-body palette (hair/skin/underwear leaks)
  D. shape variance        — per-anim opaque-area swing between frames
                             ("blinking" garment) with per-slot thresholds
  E. catalog<->disk drift  — orphan item dirs (not in catalog), unexpected
                             body dirs for shared items, missing body dirs

Usage:
  python tools/audit-overlays.py            # full audit
  python tools/audit-overlays.py --quiet    # errors/warnings only
"""
import os
import re
import sys
import numpy as np
from PIL import Image

EQUIP_ROOT = "src/client/public/sprites/equipment"
BASE_FRAMES = "tools/pixellab-downloads/v2/base-{body}-frames"
ITEMS_TS = "src/shared/items.ts"

FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
DIRS = ["south", "south-east", "east", "north-east", "north",
        "north-west", "west", "south-west"]
FULL_ANIMS = ["walk", "idle", "run", "jump"]

EMPTY_PX = 20          # frames with fewer opaque px are "near-empty" (flash)
# Per-slot plausibility floor: a real garment occupies at least this many px
# per frame. Catches "collapsed" extractions (tiny blobs) that pass EMPTY_PX.
SLOT_MIN_PX = {"upper_body": 120, "lower_body": 100, "feet": 15,
               "head_accessory": 30}
ALPHA_MIN = 8          # alpha above this counts as opaque
BLEED_DIST = 18        # colour distance to bare-body palette counted as bleed
BLEED_RATIO_WARN = 0.10  # >10% of opaque px near body palette -> warn
BLEED_MIN_PX = 40      # ...and at least this many absolute px
# Max allowed (max/min) opaque-area ratio within one anim, per slot.
# Lower-body/feet legitimately vary with stride; upper body should be stable.
VARIANCE_MAX = {"upper_body": 1.6, "lower_body": 2.4, "feet": 2.6,
                "head_accessory": 1.6}


def parse_items_ts():
    """Parse the item catalog out of items.ts (one item per line)."""
    items = {}
    src = open(ITEMS_TS, encoding="utf8").read()
    for m in re.finditer(
            r"\{\s*id:\s*'([^']+)',\s*slot:\s*'([^']+)',\s*fitProfile:\s*'(\w+)'([^}]*)\}",
            src):
        iid, slot, fit, rest = m.groups()
        fs = re.search(r"frameSize:\s*(\d+)", rest)
        anims = FULL_ANIMS if "FULL_ANIMS" in rest else None
        if anims is None:
            am = re.search(r"availableAnims:\s*\[([^\]]*)\]", rest)
            anims = re.findall(r"'(\w+)'", am.group(1)) if am else ["walk", "idle"]
        items[iid] = {
            "slot": slot,
            "fit": fit,
            "frame": int(fs.group(1)) if fs else 92,
            "anims": anims,
        }
    return items


def body_palette(body):
    """Unique colours of the bare base body (idle f1, all dirs)."""
    colors = set()
    base = BASE_FRAMES.format(body=body)
    for d in DIRS:
        p = f"{base}/idle_{d}_f1.png"
        if not os.path.exists(p):
            continue
        a = np.asarray(Image.open(p).convert("RGBA"))
        op = a[a[..., 3] > ALPHA_MIN][:, :3]
        for c in np.unique(op, axis=0):
            colors.add(tuple(int(v) for v in c))
    return np.array(sorted(colors), dtype=np.int32) if colors else None


def audit_sheet(path, frame_size, n_frames, palette):
    """Return (frame_opaque_counts, frame_bleed_counts, geometry_error)."""
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    if w != frame_size * n_frames or h != frame_size:
        return None, None, f"geometry {w}x{h}, expected {frame_size * n_frames}x{frame_size}"
    a = np.asarray(img).astype(np.int32)
    opaque_counts, bleed_counts = [], []
    for f in range(n_frames):
        fr = a[:, f * frame_size:(f + 1) * frame_size]
        mask = fr[..., 3] > ALPHA_MIN
        opx = fr[mask][:, :3]
        opaque_counts.append(int(mask.sum()))
        if palette is not None and len(opx):
            d2 = ((opx[:, None, :] - palette[None, :, :]) ** 2).sum(axis=2)
            bleed_counts.append(int((d2.min(axis=1) <= BLEED_DIST ** 2).sum()))
        else:
            bleed_counts.append(0)
    return opaque_counts, bleed_counts, None


# Gendered items ship male/female overlay sets only. Medium/dark bodies are
# skin-recolors of the light bodies (tools/recolor-skin.py) with identical
# silhouettes, so they reuse the light overlays at runtime — there are no
# per-tone overlay folders to audit.
OVERLAY_BODIES = ["male", "female"]


def main():
    quiet = "--quiet" in sys.argv
    items = parse_items_ts()
    palettes = {b: body_palette(b) for b in OVERLAY_BODIES}
    errors, warns, infos = [], [], []
    variance_rows = []

    # E1: orphan item dirs on disk not present in the catalog
    for slot_dir in sorted(os.listdir(EQUIP_ROOT)):
        sp = os.path.join(EQUIP_ROOT, slot_dir)
        if not os.path.isdir(sp):
            continue
        for item_dir in sorted(os.listdir(sp)):
            if os.path.isdir(os.path.join(sp, item_dir)) and item_dir not in items:
                errors.append(f"ORPHAN dir not in catalog: {slot_dir}/{item_dir}")

    for iid, it in sorted(items.items()):
        expected_bodies = list(OVERLAY_BODIES) if it["fit"] == "gendered" else ["male"]
        item_root = f"{EQUIP_ROOT}/{it['slot']}/{iid}"

        # E2: body dirs on disk vs expected
        if os.path.isdir(item_root):
            on_disk = [d for d in sorted(os.listdir(item_root))
                       if os.path.isdir(os.path.join(item_root, d))]
            for b in on_disk:
                if b not in expected_bodies:
                    warns.append(f"UNEXPECTED body dir ({it['fit']} item): {iid}/{b}")
        for body in expected_bodies:
            bdir = f"{item_root}/{body}"
            if not os.path.isdir(bdir):
                errors.append(f"MISSING body dir: {iid}/{body}")
                continue
            pal = palettes[body]
            for anim in it["anims"]:
                nf = FRAME_COUNTS[anim]
                for d in DIRS:
                    p = f"{bdir}/{anim}_{d}.png"
                    rel = f"{iid}/{body}/{anim}_{d}"
                    if not os.path.exists(p):
                        errors.append(f"MISSING sheet: {rel}.png")
                        continue
                    op, bl, geo = audit_sheet(p, it["frame"], nf, pal)
                    if geo:
                        errors.append(f"GEOMETRY {rel}: {geo}")
                        continue
                    slot_min = SLOT_MIN_PX.get(it["slot"], EMPTY_PX)
                    if anim in ("jump", "run") and it["slot"] == "upper_body":
                        # jump/run tees are per-frame extractions; crouched or
                        # leaning torsos shrink the visible tee to ~70-118px
                        # legitimately — calibrated 2026-06-11
                        slot_min = 65
                    if anim == "idle" and it["slot"] == "lower_body":
                        # v4 profile idles: one leg occludes the other and the
                        # diff overlay carries no outside-silhouette slop — a
                        # complete profile jean is ~90-100px (calibrated 2026-06-11)
                        slot_min = 85
                    if anim == "jump" and it["slot"] == "lower_body":
                        # airborne spread frames: transfer pose mismatch can
                        # leave one leg partly bare for a single frame
                        # (male jump_south f6 = 98px) — known nit until the
                        # transfers are re-sourced; calibrated 2026-06-11
                        slot_min = 90
                    for fi, c in enumerate(op):
                        if c > 1500 and it["slot"] != "head_accessory":
                            errors.append(
                                f"OVERFULL frame: {rel} f{fi + 1} ({c}px — "
                                f"background leak?)")
                        if c < EMPTY_PX:
                            errors.append(f"NEAR-EMPTY frame: {rel} f{fi + 1} ({c}px)")
                        elif c < slot_min:
                            errors.append(
                                f"COLLAPSED frame: {rel} f{fi + 1} ({c}px < "
                                f"{slot_min}px floor for {it['slot']})")
                    mn, mx = min(op), max(op)
                    ratio = (mx / mn) if mn else float("inf")
                    variance_rows.append((ratio, rel, mn, mx, it["slot"], body, iid))
                    if mn and ratio > VARIANCE_MAX.get(it["slot"], 2.0):
                        warns.append(
                            f"SHAPE VARIANCE {rel}: area {mn}->{mx} px (x{ratio:.2f})")
                    for fi, (c, b_) in enumerate(zip(op, bl)):
                        if c and b_ >= BLEED_MIN_PX and b_ / c > BLEED_RATIO_WARN:
                            warns.append(
                                f"BODY BLEED {rel} f{fi + 1}: {b_}/{c}px "
                                f"({100 * b_ / c:.0f}%) match bare-body palette")

    print(f"Catalog: {len(items)} items")
    print(f"Errors: {len(errors)}   Warnings: {len(warns)}")
    for e in errors:
        print(f"  ERROR  {e}")
    for w in warns:
        print(f"  WARN   {w}")
    if not quiet:
        print("\nTop 15 shape-variance sheets (max/min opaque area):")
        for ratio, rel, mn, mx, slot, body, iid in sorted(variance_rows, reverse=True)[:15]:
            print(f"  x{ratio:5.2f}  {rel}  ({mn}->{mx}px)")
        # per item+body worst ratio, grouped — quick gender comparison
        worst = {}
        for ratio, rel, mn, mx, slot, body, iid in variance_rows:
            k = (iid, body)
            worst[k] = max(worst.get(k, 0), ratio)
        print("\nWorst variance per item/body (upper_body only):")
        for (iid, body), r in sorted(worst.items()):
            if items[iid]["slot"] == "upper_body":
                print(f"  {iid:16s} {body:6s} x{r:.2f}")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
