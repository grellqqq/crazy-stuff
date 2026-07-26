# 12 — Hair Customization

> Status: **APPROVED IN FULL (Gabriel, 2026-07-26)** · Owner: game-designer · System: #12 Avatar/Customization · Production: wave 1 IN PROGRESS
> Catalog: 44 `hair` items (item-catalog.md §hair) · Related: [08 item/inventory](08-item-inventory.md), [11 avatar renderer](11-avatar-renderer.md), [24 gacha](24-gacha-system.md)

## 1. Overview

Hair becomes the game's first *identity* cosmetic slot: 8 shapes × 5 colors plus 4
special-effect styles, acquired through the gacha/store like any other item and
equipped in the existing `hair` slot (already reserved in LAYER_ORDER between the
body and every face/head accessory). A hair item is a full paint-over overlay: it
completely covers the base body's baked-on hair with the new style, so it works on
every body, under every mask/hat, in all 8 directions and all 4 animations. No
base-body art is modified. Players who equip nothing keep today's default look.

## 2. Player Fantasy

"That's *me* in the race." Hair is the strongest identity signal a 50px avatar has
— silhouette reads at distance where clothing details don't. The fantasy ladder:
- **Common** (basics in natural colors): "I picked my look."
- **Uncommon** (dyed colors, expressive cuts — afro, long, mohawk): "I stand out in
  the lobby crowd."
- **Rare** (dreads, undercut): "I have style you don't."
- **Epic/Legendary** (flaming, neon glow, galaxy): "My hair is an EVENT." The
  concert crowd turns when a galaxy-haired player walks past.
- **Crazy** (propeller): pure comedy flex.
Hair also completes the mask fantasy from the last arc: a full-face mask over
long red hair reads unmistakably as *your* character — the androgyny complaint
dies for good.

## 3. Detailed Rules

**R1 — Paint-over model (D1).** A hair item is a transparent overlay whose opaque
pixels FULLY COVER the base body's baked hair region in every frame (hair template
region + 1px dilation). Shapes smaller than the baked hair are not representable in
wave 1 (see R4). The base body is never edited; unequipping restores the default look.

**R2 — Item = shape × color.** Each catalog entry is one shape in one color
(`hair_long_red`), gacha-able per its rarity. No free color picker — color scarcity
IS the economy (dyed colors sit in higher tiers). Duplicate-pull → coin conversion
per gacha GDD §6 (unchanged).

**R3 — Slot behavior.** `hair` is a standard equipment slot: one equipped max,
swap = re-equip, renders above `skin`, below `mouth/eyes/face_accessory` and
`head_accessory`. Hats sit ON TOP of hair (clipping rules → §5 Edge Cases). Masks
already render above hair by construction (shipped architecture).

**R4 — Two production waves (D2).**
- **Wave 1 (25 items):** `short, ponytail, long, afro, dreads` × 5 colors — all
  five shapes fully cover the head (no scalp shows), so ONE overlay set per gender
  works across all 3 skin tones (fitProfile `gendered`, same as garments).
- **Wave 2 (15 + 4):** `buzzcut, mohawk, undercut` expose SCALP — scalp pixels
  must match the body's skin tone, requiring per-body overlay folders (6 bodies —
  new fitProfile `per-body`) or tone-recolored variants; plus the 4 animated/
  special styles (flaming/neon/galaxy/propeller), which need effect-frame support.
  Wave 2 ships only after wave 1's model is proven live.

**R5 — Generation & extraction (D3).** All shapes are generated ONCE in a PROXY
color chosen for clean extraction (high-contrast against skin + the baked brown
hair, e.g. the established blue-dye ramp), on the base characters with the same
skeleton templates as the body (walk/idle native). Run/jump sheets are NOT
AI-extracted: they are head-lock BAKED per gender from the approved walk art
(bake-mask-runjump machinery — female poses differ up to 13px). The proxy is then
palette-recolored into the 5 catalog colors (make-variants pipeline, proven on
hoodies/jeans). Back views keep hair (hair IS visible from behind — unlike masks,
no back-clearing; the walk_north extraction ships real art).

## 4. Formulas

**F1 — Coverage gate (the wave-1 correctness contract).** For every frame of
every sheet (gender g, direction d, anim a, frame f):

```
BakedHair(g,d,a,f) = head_region(base) ∧ ¬face_region(base)      // template-matched
uncovered          = BakedHair ∧ ¬dilate1(opaque(overlay))
PASS  ⇔  |uncovered| = 0
```

Zero tolerance: one stray baked-brown pixel poking through a blue mohawk reads as
a bug at any zoom. The gate runs in the bake tool over all sheets (~2 genders ×
5 shapes × 8 dirs × (6+4+6+9) frames = 2,000 checks) and hard-fails the build.

**F2 — Run/jump placement (head-lock bake, unchanged from masks).**
`overlay_a(f) = translate(canonical_walk, round(anchor_g(a,f) − anchor_g(walk,ci)))`
where `anchor` = centroid of the template-matched head region of THAT gender's
body frame, `ci` = fullest walk frame. AI never draws run/jump.

**F3 — Recolor mapping (proxy → 5 palettes).** Overlay pixels are ranked by
luminance and mapped rank-preserving onto a 6-step target ramp per color; outline
pixels (lum < 32) are preserved untouched. Ramp constraints: *blonde* caps at
lum 210 (no white-out against the pale skin), *black* keeps ≥ 3 visibly distinct
steps ending no darker than lum 26 (silhouette must not collapse into the
outline). Ramps are data (`tools/hair-ramps.json`), tuned once on `long`, applied
to all shapes.

**F4 — Pool impact at release.** Per-item pull odds stay
`tierWeight / Σweights / n_tier`. Wave 1 adds: +10 common (short, ponytail × 5),
+10 uncommon (long, afro × 5), +5 rare (dreads × 5). Projected per-item odds
after release: common 1.32% (was 1.79), uncommon 1.25% (was 2.14), rare 0.65%
(was 0.83). Dilution of existing items is accepted — hair is exactly what a
bigger pool is for. (Exact table regenerated at release PR.)

## 5. Edge Cases

- **E1 Hat over hair:** hats render above hair and simply sit on it. A brim over
  an afro will overlap pixels — this is the accepted industry look at 92px, NOT
  a blocker. If a specific hat+hair combo reads broken in QA it gets a targeted
  fix later (per-hat flatten mask, wave 2+); we do not pre-engineer it.
- **E2 Ponytail vs future back items (capes/backpacks):** back slot renders
  BEHIND the body, hair in front — a ponytail draws over the body which draws
  over the cape. Correct by layer order; revisit only when the back slot ships.
- **E3 Jump crouch frames:** the head anchor moves up to ~26px between jump
  frames (measured in the mask arc). The bake translates per frame; the F1 gate
  runs on every jump frame including crouch/apex.
- **E4 Back views:** unlike masks, hair IS the back of the head — north sheets
  ship real extracted art and must pass F1 there too (the baked hair is 100%
  visible from behind; any gap shows).
- **E5 Under masks:** masks carry zero hair and render above `hair` — shipped
  architecture; a full-face mask over any wave-1 style must show the style's
  silhouette (fringe sides/top, ponytail behind) with no color bleed. One QA
  grid: 5 masks × 3 hairs.
- **E6 Default/unequip:** no hair item equipped = the body's baked look
  (grandfathered). Unequip is allowed anytime (unlike the future skin slot).
- **E7 Idle:** hair sheets ship clean 4-frame idles and set `idleAnimates` so
  hair bobs with the breathing body (hat-family behavior).
- **E8 Remote players:** nothing new — hair loads through the generic equipment
  keys (`equip_<item>_<gender>_*`) with the same lazy-load path as garments.
- **E9 Duplicates:** standard dupe→coins conversion (gacha GDD §6).

## 6. Dependencies

| Dependency | State | Work needed |
|---|---|---|
| `hair` in LAYER_ORDER (above skin, below face/head accessories) | ✅ shipped | none |
| Generic equipment load/anim/frame-lock path (IsoScene) | ✅ shipped | none — hair is a standard 92px gendered item |
| Catalog entries (44, `released:false`) | ✅ shipped | flip 25 to `released:true` at wave-1 ship; set `availableAnims: FULL`, `idleAnimates` |
| `equipmentBodyKey` | ✅ gendered OK for wave 1 | wave 2 scalp shapes need a `per-body` fitProfile (6 folders) — NOT built now |
| PixelLab generation | account has capacity | 2 genders × 5 shapes: states + walk/idle animations (5 native dirs); proxy color only |
| Extraction | extract-overlays-v4 | new hair config: head band, proxy-color gate, NO front_only (back views keep art), fill_holes |
| Run/jump | bake-mask-runjump machinery | generalize to `bake-hair-runjump.py` (no back-clearing; F1 gate built in) |
| Recolor | make-variants pipeline | HAIR5 ramps in `tools/hair-ramps.json` (F3) |
| Dev QA | dev-wardrobe.js | add a hair-cycling key (H) + purge support |
| Server / gacha / store | ✅ slot-agnostic | none — items enter the pool via `released:true` (inGachaPool) |

*(No server code changes anticipated: inventory/equip/gacha are catalog-driven.)*

## 7. Tuning Knobs

| Knob | Default | Where | Notes |
|---|---|---|---|
| Color ramps (5 × 6-step) | tuned on `long` | `tools/hair-ramps.json` | retune → re-run recolor only, no regeneration |
| Blonde luminance cap | 210 | ramps file | prevents white-out vs pale skin |
| Black ramp floor / steps | lum ≥ 26 / ≥ 3 steps | ramps file | keeps silhouette readable |
| Coverage-gate tolerance | 0 px (hard) | bake tool | may relax to ≤ 2 edge px ONLY with Gabriel sign-off |
| Extraction band per shape | head band; `long`/`dreads` extend to shoulder rows | extractor config | tall/long styles need a deeper band — per-shape value |
| Per-item rarity | catalog values | items.ts / admin `gacha_config` | retierable without regen (face-item precedent) |
| Idle behavior | `idleAnimates: true` | items.ts | static-pin fallback if a shape's idle sheet misbehaves |
| Proxy generation color | blue-dye ramp | pipeline constant | changing it invalidates extraction gates — don't, mid-wave |

## 8. Acceptance Criteria

Verification follows the mask-arc standard: automated gates → composite grids →
in-engine motion pass → Gabriel sign-off. All must pass before `released: true`.

- **AC1** F1 coverage gate passes **100% of frames** (both genders × 8 dirs ×
  4 anims × 5 shapes) — automated, hard-fail.
- **AC2** All 25 items render in-engine on both genders, all 8 facings, all
  4 movements, zero console errors (dev-wardrobe hair-cycle pass).
- **AC3** Mask stack grid (5 masks × 3 hairs × S/E/NE, both genders): hair
  silhouette reads around every mask, no color bleed, no z-order glitches.
- **AC4** Hat spot grid (3 hats × 3 hairs): E1 "hat sits on hair" look approved
  by Gabriel — this is the taste gate.
- **AC5** Back views (W/N) show the full style with zero baked-brown
  bleed-through on all 5 shapes.
- **AC6** Recolor contact sheet (5 shapes × 5 colors) approved by Gabriel —
  blonde readable, black not a blob, outlines intact.
- **AC7** Motion QA **in motion, not stills**: idle bobs with the body; run/jump
  hair tracks the head with no drift/double-hair, verified animated in-engine.
- **AC8** Equip/swap/unequip round-trips persist through relog; unequip restores
  the baked default look.
- **AC9** Gacha: all 25 enter the pool at correct rarities; post-release odds
  table regenerated and recorded; duplicates convert to coins.
- **AC10** No regressions: full unit + integration suites green; masks/eyewear
  spot grid unchanged.
