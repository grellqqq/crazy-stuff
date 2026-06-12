# Equipment Sprite Pipeline (v4 — aligned character states)

How equipment overlays are produced, and **how to add a new item**.

## Why v4

v1–v3 extracted garments from "outfit transfer" art drawn on a
differently-proportioned figure, then tried to infer where the wearer's
limbs were. Every recurring defect (denim painted on swinging hands, bare
thighs, floating shirts, garment style changing per direction) was that
inference failing. v4 removes the inference entirely:

1. Each garment is a PixelLab **character state** of the SAME base
   character (`create_character_state`) — same identity, proportions, and
   skeleton.
2. The state is animated with the SAME **animation templates** as the base
   (`walking`, `running-6-frames`, `jumping-1`, `breathing-idle`), so every
   frame is pose-aligned with the base frame.
3. The overlay is simply: state pixels that differ from the base pixels
   (`tools/extract-overlays-v4.py`). A limb drawn in front of the garment
   is identical in both renders → no diff → the limb shows through.
   Occlusion is correct **by construction**.

## Base characters (PixelLab)

| body key       | character id                          |
|----------------|---------------------------------------|
| female (light) | 7fa3c16e-0f75-4979-9f1d-a2cb3ae7b3d3 |
| male (light)   | 79797272-fe42-4b9c-9b90-d34526ca575a |
| female-medium  | 5eb45c77-3e2b-4ded-bc7d-04ec0ff2ae06 |
| male-medium    | 65270697-fe68-4af7-b2f8-b11a33195556 |
| female-dark    | 523f0064-9334-4dd1-8464-559a36dcd9c9 |
| male-dark      | f2ede1d6-f5fa-4c69-a08b-796dbc719b89 |

NOTE: the six bodies are DISTINCT characters (different hair, builds, eye
colors), not recolors — so garment states must be created per body that
should wear the item. Phase 1 covers the light bodies; medium/dark states
follow the identical recipe.

## Adding a new item

1. **Create states** (one per body that can wear it):
   `create_character_state(base_id, "wearing <item description> (only that
   item — keep underwear, everything else unchanged)")`
   Keep the edit single-item so the diff isolates the garment.
2. **Animate** each state with the 4 game templates, 5 primary directions
   (west-side is mirrored): `walking`, `running-6-frames`, `jumping-1`,
   `breathing-idle` × `["south","east","north","south-east","north-east"]`.
   Cost: 20 generations per state. Account job-slot cap is 10 concurrent —
   drip-feed.
3. **Download**: `python tools/fetch-character-frames.py <state_or_base_id>
   --map "<State_Folder_Prefix>=tools/pixellab-downloads/v4/<item>-<body>"`
   (the zip contains the whole character group).
4. **Extract**: add the item to `ITEMS` in `tools/extract-overlays-v4.py`
   (slot + extraction band), then
   `python tools/extract-overlays-v4.py --body <body> <item>`.
5. **Variants** (recolors): wire into `tools/make-variants.py` if the item
   has color variants, then run it for each body.
6. **Catalog**: add entries to `src/shared/items.ts` (fitProfile
   'gendered'; per-skin-tone profiles arrive with the medium/dark phase).
7. **Verify** (all three, no skipping):
   `python tools/audit-overlays.py` (0 errors),
   `python tools/preview-composite.py` + look at the rows yourself,
   live in-game (`npm run dev` + `npm run server`,
   `http://localhost:8080/?dev&char=<body>`).

## Templates / frame counts (game contract)

| template          | game anim | frames |
|-------------------|-----------|--------|
| walking           | walk      | 6      |
| running-6-frames  | run       | 6      |
| jumping-1         | jump      | 9      |
| breathing-idle    | idle      | 4      |

Frame size 92×92; sheets are horizontal strips; west/south-west/north-west
are mirrored from the east-side sheets at extraction time (the runtime also
only ever renders east-side textures with flipX).
