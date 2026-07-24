"""Strip the MALE character's baked-in HAIR from the mask overlays.

The masked-character generations reshaped the male's hair around each mask
(fringe over the hockey dome, hair cap above the plague hood, side-hair behind
the tiki totem). Those pixels differ from the bare base render, so the diff
kept them — invisible on the MALE wearer (they sit on top of his identical
hair), but on the FEMALE they overwrite her hairstyle with his: the "male head
on female" bug.

Colour alone can't separate them (the plague hood and tiki wood are themselves
hair-brown). The safe discriminator is PROVENANCE — his baked hair is a
near-copy of the male BASE body's own hair pixels, displaced a couple of px by
the mask. Strip an overlay pixel iff ALL of:
  1. it lies inside the male base's HAIR region for that frame (dilated) —
     where his hair could possibly be;
  2. a male-base pixel within a 3px neighbourhood matches its colour
     (dist <= 22) — it is literally his (shifted) hair pixel;
  3. it is broadly hair-family (warm, not bright) — belt-and-suspenders so
     white/grey mask material over the fringe rows can never qualify.
Mask material (white/grey/olive/dark leather/red wood) fails 2 or 3; his hair
passes all three. The wearer's OWN hair — rendered by the body sprite
underneath — shows through where pixels are removed, for either gender.

Run on the MALE walk+idle sheets (the canonical art), then re-run
tools/bake-mask-runjump.py to refresh the female copies and rebake run/jump
from the cleaned canonicals.

Usage: python tools/strip-baked-hair.py
"""
import importlib.util

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("xt", "tools/extract-overlays-v4.py")
xt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xt)

FS = 92
MASKS = ["hockey_mask", "gas_mask", "ghost_mask", "plague_doctor", "tiki_mask"]
DIRS = ["south", "south-east", "east", "north-east", "north",
        "north-west", "west", "south-west"]
ANIMS = {"walk": 6, "idle": 4}
BODY = "src/client/public/sprites/characters/male"
EQ = "src/client/public/sprites/equipment/face_accessory/{item}/male"

NEIGH = 3        # provenance search radius (px) — his hair moved at most ~3px
CDIST = 22       # colour distance that counts as "same pixel, shifted"

# Per-mask colour-domain rules for the RESHADED hair the provenance test can't
# match (the masked render redraws his hair with new shading on 3/4-back views).
# These masks have NO warm-brown in their own palette, so brown = his hair:
#   brown_any: white/grey/black masks (hockey, ghost) — any warm brown is hair
#   brown_warm: gas (olive straps have R~G; his hair has R>G markedly)
#   brown_mid: tiki (vivid red wood is R-G>38; his hair is 8..38)
#   None: plague — its hood IS hair-brown leather and legitimately covers the
#         head; provenance+component passes above are all it gets.
# blackmass: drop near-black clusters >= min_px that sit further than 1px from
# BRIGHT mask material (their own outline hugs material; his silhouette floats).
RULES = {
    "hockey_mask":   {"brown": "any",  "blackmass": 20},
    "ghost_mask":    {"brown": "any",  "blackmass": 20},
    "gas_mask":      {"brown": "warm", "blackmass": None, "crumb": 6},  # black straps are legit
    "tiki_mask":     {"brown": "mid",  "blackmass": 18, "crumb": 5},
    "plague_doctor": {"brown": None,   "blackmass": None},
}


def load(p):
    return np.asarray(Image.open(p).convert("RGBA")).astype(np.int16)


def dilate(m, k):
    d = m.copy()
    for _ in range(k):
        n = d.copy()
        n[1:, :] |= d[:-1, :]; n[:-1, :] |= d[1:, :]
        n[:, 1:] |= d[:, :-1]; n[:, :-1] |= d[:, 1:]
        d = n
    return d


def strip_frame(ov, base, rule):
    a = ov[..., 3] > 16
    if not a.any():
        return ov, 0
    hr = xt.head_region(base)
    fr = xt.face_region(base)
    hair = hr & ~fr
    hair_zone = dilate(hair, 2)
    # NAPE EXTENSION: his side-hair sweeps below the head template on profile
    # views (the black jagged remnants behind the neck) — include a band under
    # the hair, horizontally bounded to the hair span.
    hy, hx = np.nonzero(hair)
    if len(hy):
        nape = np.zeros((FS, FS), dtype=bool)
        nape[hy.max():min(FS, hy.max() + 9),
             max(0, hx.min() - 1):min(FS, hx.max() + 2)] = True
        hair_zone |= nape
    R, G, B = ov[..., 0], ov[..., 1], ov[..., 2]
    lum = (R + G + B) / 3.0
    hair_family = (R >= B) & (lum < 165)
    # provenance: does a base pixel within NEIGH px match this colour?
    bop = base[..., 3] > 16
    brgb = base[..., :3].astype(np.float64)
    orgb = ov[..., :3].astype(np.float64)
    matched = np.zeros((FS, FS), dtype=bool)
    for dy in range(-NEIGH, NEIGH + 1):
        for dx in range(-NEIGH, NEIGH + 1):
            sb = np.roll(np.roll(brgb, dy, axis=0), dx, axis=1)
            sa = np.roll(np.roll(bop, dy, axis=0), dx, axis=1)
            d = np.sqrt(((orgb - sb) ** 2).sum(-1))
            matched |= sa & (d <= CDIST)
    drop = a & hair_zone & hair_family & matched
    # COMPONENT PASS: a surviving blob that lives in the hair/nape zone and is
    # mostly provenance-matched dark pixels is a chunk of his displaced hair
    # (e.g. the near-black side-hair silhouette) — drop it whole. Mask bodies
    # (totem/hood/dome) contain plenty of non-matched material pixels and keep
    # their majority, so they never qualify.
    keep = a & ~drop
    h, w = keep.shape
    seen = np.zeros((h, w), dtype=bool)
    for sy, sx in zip(*np.nonzero(keep & hair_zone)):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1)):
                if 0 <= ny < h and 0 <= nx < w and keep[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        inzone = np.mean([hair_zone[y, x] for y, x in comp])
        prov = np.mean([(hair_family[y, x] and matched[y, x]) for y, x in comp])
        hf = np.mean([hair_family[y, x] for y, x in comp])
        # the masked render outlines his hair in PURE BLACK, which has no
        # counterpart in the bare base (provenance can't match it) — a blob
        # that is nearly all near-black hair-silhouette is his hair outline
        nearblack = np.mean([lum[y, x] < 32 for y, x in comp])
        if len(comp) <= 4 and inzone > 0.99:
            for y, x in comp:                      # crumbs
                drop[y, x] = True
        elif inzone > 0.85 and (prov > 0.55
                                or (hf > 0.9 and (prov > 0.5 or nearblack > 0.45))):
            for y, x in comp:                      # his displaced hair chunk/outline
                drop[y, x] = True
    # DETACHED BLACK SILHOUETTE: his hair's pure-black outline can be CONNECTED
    # to the mask's own outline (hockey east), so the component vote sees one
    # blob including the white dome and spares it. Discriminate by DISTANCE TO
    # MATERIAL instead: real mask outline hugs mask material within a couple px;
    # his hair silhouette floats alone in the hair zone. Material = anything
    # that is neither provenance-matched hair nor near-black.
    keep2 = a & ~drop
    material = keep2 & ~(hair_family & matched) & ~(lum < 32)
    near_mat = dilate(material, 3)
    blackzone = keep2 & hair_zone & (lum < 32) & ~near_mat
    if blackzone.any():
        seen2 = np.zeros_like(blackzone)
        for sy, sx in zip(*np.nonzero(blackzone)):
            if seen2[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen2[sy, sx] = True
            comp = []
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1),
                               (y+1, x+1), (y+1, x-1), (y-1, x+1), (y-1, x-1)):
                    if 0 <= ny < FS and 0 <= nx < FS and blackzone[ny, nx] \
                            and not seen2[ny, nx]:
                        seen2[ny, nx] = True
                        stack.append((ny, nx))
            if len(comp) >= 35:                    # big floating black mass = his hair
                for y, x in comp:
                    drop[y, x] = True

    # PER-MASK COLOUR DOMAIN: reshaded hair the provenance test cannot match.
    if rule.get("brown"):
        Rf, Gf, Bf = ov[..., 0], ov[..., 1], ov[..., 2]
        lumf = (Rf + Gf + Bf) / 3.0
        if rule["brown"] == "any":
            br = (Rf > Bf + 12) & (Rf > Gf + 3) & (lumf > 26) & (lumf < 160)
        elif rule["brown"] == "warm":
            br = (Rf > Gf + 8) & (Rf > Bf + 15) & (lumf > 26) & (lumf < 150)
        else:  # mid: warm brown but NOT the vivid red wood
            br = (Rf > Bf + 12) & (Rf - Gf > 8) & (Rf - Gf < 38) & (lumf > 26) & (lumf < 150)
            # ...and never wood SHADING that hugs the vivid red mask body —
            # real tiki shading sits within 2px of red; his hair floats away
            red = a & (Rf - Gf > 38) & (Rf > 90)
            br &= ~dilate(red, 2)
        drop |= a & hair_zone & br
    # BLACKMASS: floating near-black silhouette vs outline hugging bright material
    if rule.get("blackmass"):
        keep3 = a & ~drop
        bright = keep3 & ((ov[..., 0] + ov[..., 1] + ov[..., 2]) / 3.0 >= 90)
        nm = dilate(bright, 1)
        bz = keep3 & hair_zone & (lum < 32) & ~nm
        if bz.any():
            seenb = np.zeros_like(bz)
            for sy, sx in zip(*np.nonzero(bz)):
                if seenb[sy, sx]:
                    continue
                stack = [(sy, sx)]; seenb[sy, sx] = True; comp = []
                while stack:
                    y, x = stack.pop(); comp.append((y, x))
                    for ny, nx in ((y+1,x),(y-1,x),(y,x+1),(y,x-1),(y+1,x+1),(y+1,x-1),(y-1,x+1),(y-1,x-1)):
                        if 0 <= ny < FS and 0 <= nx < FS and bz[ny, nx] and not seenb[ny, nx]:
                            seenb[ny, nx] = True; stack.append((ny, nx))
                if len(comp) >= rule["blackmass"]:
                    for y, x in comp:
                        drop[y, x] = True
    # FINAL DESPECKLE: the colour-domain strips leave 1-4px crumbs of former
    # hair anti-aliasing sprinkled over the hair zone (tiki red flecks) — drop
    # tiny leftover components there. Threshold per mask so small legit details
    # (tiki horn nubs) survive.
    cr = rule.get("crumb", 0)
    if cr:
        keep4 = a & ~drop
        seen4 = np.zeros_like(keep4)
        for sy, sx in zip(*np.nonzero(keep4 & hair_zone)):
            if seen4[sy, sx]:
                continue
            stack = [(sy, sx)]; seen4[sy, sx] = True; comp = []
            while stack:
                y, x = stack.pop(); comp.append((y, x))
                for ny, nx in ((y+1, x), (y-1, x), (y, x+1), (y, x-1)):
                    if 0 <= ny < FS and 0 <= nx < FS and keep4[ny, nx] and not seen4[ny, nx]:
                        seen4[ny, nx] = True; stack.append((ny, nx))
            if len(comp) <= cr and np.mean([hair_zone[y, x] for y, x in comp]) > 0.95:
                for y, x in comp:
                    drop[y, x] = True
    out = ov.copy()
    out[drop] = 0
    return out, int(drop.sum())


total = {}
for item in MASKS:
    root = EQ.format(item=item)
    n = 0
    for anim, nf in ANIMS.items():
        for d in DIRS:
            p = f"{root}/{anim}_{d}.png"
            bp = f"{BODY}/{anim}_{d}.png"
            try:
                sheet = load(p)
                body = load(bp)
            except FileNotFoundError:
                continue
            for i in range(nf):
                fr_o = sheet[:, i * FS:(i + 1) * FS]
                fr_b = body[:, i * FS:(i + 1) * FS]
                cleaned, k = strip_frame(fr_o, fr_b, RULES[item])
                sheet[:, i * FS:(i + 1) * FS] = cleaned
                n += k
            xt.save_rgba(sheet, p)
    total[item] = n
    print(f"  {item}: stripped {n} baked-hair px")
print("DONE — male hair removed from mask canonicals; now re-run bake-mask-runjump.py")
