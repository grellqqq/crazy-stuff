# Item Catalog — v1 Content Spec

> **Status**: DRAFT v3 for review (2026-06-18, Gabriel + Claude Code)
> **Type**: Content/data spec — the named-item backing for Gacha (#24) and
> Item/Inventory (#08). Not a mechanics GDD; rules live in those docs.
> This file is the *list*: slot · rarity · id · displayName · fit · variants.
> **Implements Pillar**: "Items feel meaningful because they are rare." Fills
> the empty rarity tiers (so gacha pity pays out) and the empty flashy slots.

## 1. Design intent

### The problem this fixes
Today's catalog is **26 items, 25 Common + 1 Rare** (`wizard_hat`), in only the
`upper_body` / `lower_body` / `feet` / `head_accessory` slots. Gacha odds
collapse to Common 76.9% / Rare 23.1% — Uncommon/Epic/Legendary/Crazy are
*empty*, pity has nothing to pay out, and **8 of the 12 equipment slots are
unused** (hair, eyes, mouth, face, back, air_space, hand_1h, skin).

### The 12 slots already exist (verified in code 2026-06-18)
No new slots or renderer code are needed. `EQUIPMENT_SLOTS` (`mongo.ts:174`),
`LAYER_ORDER` (`IsoScene.ts:108`), and `SLOT_META` (`IsoScene.ts:2063`) define
all 12; the renderer loops them generically and draws any item whose sprite
textures exist (`IsoScene.ts:1410`). Adding catalog entries + art lights a slot
up automatically.

| # | Slot | Renders | This catalog fills? |
|---|---|---|---|
| 1 | `skin` | base body | no (skin-migration owns it, #08 §3.3) |
| 2 | `hair` | above body, below hats | **yes** |
| 3 | `head_accessory` | top | **yes** |
| 4 | `eyes_accessory` | over eyes | **yes** |
| 5 | `mouth_accessory` | over mouth | **yes** |
| 6 | `face_accessory` | full face (excl. 4+5) | **yes** |
| 7 | `upper_body` | torso | **yes** |
| 8 | `lower_body` | legs | **yes** |
| 9 | `feet` | feet | **yes** |
| 10 | `back` | **behind** body | **yes** |
| 11 | `hand_1h` | held | not v1 (deferred) |
| 12 | `air_space` | on top, never occluded — the "aura" slot | **yes** |

### The theme ladder (all four chosen aesthetics, mapped up the tiers)
| Tier | Flavor | Reads as |
|---|---|---|
| **Common** | Grounded basics | tees, jeans, sneakers, basic hair |
| **Uncommon** | Streetwear flex | hoodies, varsity, dyed hair, skirts |
| **Rare** | Cool / fantasy entry | puffers, capes, glowing sneakers, wizard hat |
| **Epic** | Sci-fi / fantasy | jetpacks, rune cloaks, neon hair, spark auras |
| **Legendary** | Big flashy flex | dragon wings, galaxy hair, golden glow |
| **Crazy** | Absurd meme chase | shark onesie, duck floatie, toilet-ring aura |

## 2. Scale & distribution

**~244 items** (26 existing kept + 218 new). The jump from the ~100 target is
**color variants Gabriel requested** (palette-swaps, the cheapest art) plus the
face-region slots (eyes/mouth/face) added in v3. Counts per slot × rarity:

| Slot | Com | Unc | Rare | Epic | Leg | Crazy | Total |
|---|--:|--:|--:|--:|--:|--:|--:|
| `upper_body` | 21 | 17 | 13 | 2 | 1 | 2 | 56 |
| `lower_body` | 7 | 20 | 3 | 1 | 1 | 0 | 32 |
| `feet` | 9 | 3 | 3 | 2 | 1 | 1 | 19 |
| `head_accessory` | 3 | 3 | 5 | 3 | 1 | 1 | 16 |
| `hair` | 15 | 15 | 10 | 2 | 1 | 1 | 44 |
| `back` | 0 | 5 | 10 | 3 | 2 | 2 | 22 |
| `air_space` | 0 | 1 | 2 | 3 | 3 | 3 | 12 |
| `eyes_accessory` | 2 | 5 | 4 | 2 | 1 | 1 | 15 |
| `mouth_accessory` | 4 | 3 | 4 | 1 | 1 | 1 | 14 |
| `face_accessory` | 1 | 2 | 6 | 3 | 1 | 1 | 14 |
| **Total** | **62** | **74** | **60** | **22** | **13** | **13** | **244** |

**Odds are unaffected by counts** — gacha rolls tier-first (weights
50/30/15/4/0.9/0.1, F1), then uniform-within-tier, so disclosed odds stay at the
design targets. Per-*item* odds dilute with tier size (e.g. a specific Uncommon
≈ 30%/71 ≈ 0.42%; a specific Crazy ≈ 0.1%/13 ≈ 0.008%). Clears the paid-pull
depth gate (gacha Q#7: ≥10 U / ≥5 R / ≥2 E) many times over.

> **Knob to confirm:** `hair` is the biggest single bucket (44) because
> Common→Rare styles each get 5 colors. Easy to trim to 4 or 3 colors if 44
> feels heavy. Flag it and I'll adjust.

### Named color sets (variant suffixes)
- **TEE10** = black, blue, brown, green, pink, purple, red, stripes, white, yellow
- **TRACK8** = black, blue, green, grey, red, pink, white, yellow
- **HAIR5** = brown, black, blonde, red, blue
- **CAPE4** = red, blue, black, purple
- **PACK4** = red, blue, black, green
- **SKIRT3** = red, blue, black · **FLANNEL3** = red, blue, green · **CARGO3** = green, brown, black
- **VARSITY4** = blue, red, yellow, green · **SHELL2** = green, brown

## 3. The catalog

`fit`: **G** gendered (male+female overlay; medium/dark are recolors) · **S**
shared (one set fits all). `frame`: px when >92. Existing items **bold**.

### 3.1 `upper_body` (56) — fit: G
| Rarity | id / pattern | displayName | variants | n |
|---|---|---|---|--:|
| Common | **tshirt_\*** | T-shirt | existing 11 (worn/black/blue/brown/green/pink/purple/red/stripes/white/yellow) | 11 |
| Common | longsleeve_{c} | Long-sleeve Tee | TEE10 | 10 |
| Uncommon | hoodie_{c} | Hoodie | TEE10 | 10 |
| Uncommon | flannel_{c} | Flannel Shirt | FLANNEL3 | 3 |
| Uncommon | varsity_{c} | Varsity Jacket | VARSITY4 | 4 |
| Rare | puffer_{c} | Puffer Jacket | TEE10 | 10 |
| Rare | lab_coat | Scientist Coat | — | 1 |
| Rare | leather_jacket | Leather Jacket | — | 1 |
| Rare | pinned_denim_vest | Pinned Denim Vest | — | 1 |
| Epic | rune_cloak | Rune Cloak (132) | — | 1 |
| Epic | circuit_jacket | Neon Circuit Jacket | — | 1 |
| Legendary | galaxy_hoodie | Galaxy Hoodie | — | 1 |
| Crazy | shark_onesie | Shark Onesie (132) | ★ Gabriel pick | 1 |
| Crazy | trex_costume_top | Inflatable T-Rex Top (132) | — | 1 |

### 3.2 `lower_body` (32) — fit: G
| Rarity | id / pattern | displayName | variants | n |
|---|---|---|---|--:|
| Common | **jeans_\*** / blue_jeans | Jeans | existing 7 (blue/black/brown/green/grey/khaki/red) | 7 |
| Uncommon | track_pants_{c} | Track Pants | TRACK8 | 8 |
| Uncommon | cargo_pants_{c} | Cargo Pants | CARGO3 (green/brown/black) | 3 |
| Uncommon | skirt_{c} | Skirt | SKIRT3 | 3 |
| Uncommon | kilt | Kilt | — | 1 |
| Uncommon | short_skirt | Short Skirt | — | 1 |
| Uncommon | cyclist_pants | Cyclist Pants | — | 1 |
| Uncommon | capri_pants | Capri Pants | — | 1 |
| Uncommon | shorts_80s | 80s Shorts | — | 1 |
| Uncommon | baggy_pants | Baggy Pants | — | 1 |
| Rare | disco_pants | Disco Pants | — | 1 |
| Rare | leather_pants | Leather Pants | — | 1 |
| Rare | chained_ripped_jeans | Chained Ripped Jeans | — | 1 |
| Epic | hologram_leggings | Hologram Leggings | — | 1 |
| Legendary | magma_pants | Magma Pants | — | 1 |

### 3.3 `feet` (19) — fit: G
| Rarity | id / pattern | displayName | variants | n |
|---|---|---|---|--:|
| Common | **sneakers_\*** / beatup_sneakers | Sneakers | existing 7 colors | 7 |
| Common | flip_flops | Flip-flops | — | 1 |
| Common | sandals | Sandals | — | 1 |
| Uncommon | slides | Slides | — | 1 |
| Uncommon | heels | Heels | — | 1 |
| Uncommon | oxford_shoes | Oxford Shoes | — | 1 |
| Rare | platform_heels | Platform Heels | — | 1 |
| Rare | glowing_sneakers | Glowing Sneakers | — | 1 |
| Rare | cowboy_boots | Cowboy Boots | — | 1 |
| Epic | futuristic_sneakers | Futuristic Sneakers | sci-fi | 1 |
| Epic | rocket_boots | Rocket Boots | thruster | 1 |
| Legendary | winged_sandals | Winged Sandals | — | 1 |
| Crazy | giant_clown_shoes | Giant Clown Shoes (132) | — | 1 |

### 3.4 `head_accessory` (16) — fit: S · frame 132
| Rarity | id | displayName | notes | n |
|---|---|---|---|--:|
| Common | beanie | Beanie | | 1 |
| Common | baseball_cap | Baseball Cap | | 1 |
| Common | headband | Headband | | 1 |
| Uncommon | bucket_hat | Bucket Hat | | 1 |
| Uncommon | snapback | Snapback | | 1 |
| Uncommon | beret | Beret | | 1 |
| Rare | **wizard_hat** | Wizard Hat | existing | 1 |
| Rare | top_hat | Top Hat | | 1 |
| Rare | bay_leaf_crown | Bay Leaf Crown | laurel | 1 |
| Rare | beer_can_cap | Beer-can Cap | hat w/ cans + straws | 1 |
| Rare | helicopter_cap | Helicopter Cap | propeller beanie | 1 |
| Epic | tiara | Tiara | jeweled | 1 |
| Epic | halo | Halo | glowing ring | 1 |
| Epic | vr_headset | VR Headset | sci-fi | 1 |
| Legendary | flaming_crown | Flaming Crown | fire | 1 |
| Crazy | traffic_cone_hat | Traffic Cone Hat | absurd signature | 1 |

### 3.5 `hair` (44) — fit: S · frame 132 · Common→Rare get color variants
| Rarity | id / pattern | displayName | variants | n |
|---|---|---|---|--:|
| Common | hair_short_{c} | Short Hair | HAIR5 | 5 |
| Common | hair_ponytail_{c} | Ponytail | HAIR5 | 5 |
| Common | hair_buzzcut_{c} | Buzzcut | HAIR5 | 5 |
| Uncommon | hair_mohawk_{c} | Mohawk | HAIR5 | 5 |
| Uncommon | hair_long_{c} | Long Hair | HAIR5 | 5 |
| Uncommon | hair_afro_{c} | Afro | HAIR5 | 5 |
| Rare | hair_dreads_{c} | Dreads | HAIR5 | 5 |
| Rare | hair_undercut_{c} | Undercut | HAIR5 | 5 |
| Epic | hair_flaming | Flaming Hair | fire effect | 1 |
| Epic | hair_neon_glow | Neon Glow Hair | sci-fi | 1 |
| Legendary | hair_galaxy | Galaxy Hair | starfield | 1 |
| Crazy | hair_propeller | Propeller Hair | absurd | 1 |

### 3.6 `back` (22) — fit: S · frame 132–152 · renders BEHIND body
| Rarity | id / pattern | displayName | variants | n |
|---|---|---|---|--:|
| Uncommon | backpack_{c} | Backpack | PACK4 | 4 |
| Uncommon | scuba_tank | Scuba Cylinder | — | 1 |
| Rare | cape_{c} | Cape | CAPE4 | 4 |
| Rare | turtle_shell_{c} | Turtle Shell | SHELL2 | 2 |
| Rare | sheathed_sword | Sheathed Sword | sword-in-scabbard | 1 |
| Rare | berimbau | Berimbau (152) | capoeira instrument | 1 |
| Rare | butterfly_wings | Butterfly Wings | | 1 |
| Rare | hoverboard_back | Strapped Hoverboard | | 1 |
| Epic | jetpack | Jetpack | idle flame | 1 |
| Epic | feathered_wings | Feathered Wings (152) | | 1 |
| Epic | samurai_banner | Samurai Banner (152) | | 1 |
| Legendary | dragon_wings | Dragon Wings (152) | | 1 |
| Legendary | mecha_thrusters | Mecha Thrusters (152) | | 1 |
| Crazy | duck_floatie | Rubber Duck Floatie (152) | | 1 |
| Crazy | snail_shell | Giant Snail Shell (152) | | 1 |

### 3.7 `air_space` (12) — fit: S · the "aura" slot · renders on top
Authored as a looping glowing-ring/effect spritesheet (overlay path; a richer
particle system is optional later polish — see §4).
| Rarity | id | displayName | notes | n |
|---|---|---|---|--:|
| Uncommon | aura_dust_sparkle | Dust Sparkles | subtle | 1 |
| Rare | aura_fireflies | Fireflies | | 1 |
| Rare | aura_autumn_leaves | Autumn Leaves | | 1 |
| Epic | aura_electric | Electric Sparks | sci-fi | 1 |
| Epic | aura_flame | Flame Aura | | 1 |
| Epic | aura_frost | Frost Mist | | 1 |
| Legendary | aura_rainbow_trail | Rainbow Trail | | 1 |
| Legendary | aura_golden_glow | Golden Glow | wealth | 1 |
| Legendary | aura_storm_cloud | Storm Cloud | overhead | 1 |
| Crazy | aura_toilet_ring | Floating Toilet Ring | absurd signature | 1 |
| Crazy | aura_money_rain | Money Rain | | 1 |
| Crazy | aura_duck_swarm | Rubber Duck Swarm | orbiting ducks | 1 |

### 3.8 `eyes_accessory` (15) — fit: S · sits within the face (frame 92)
Stacks with `mouth_accessory`; cleared by equipping a `face_accessory` (§8).
| Rarity | id | displayName | notes | n |
|---|---|---|---|--:|
| Common | round_glasses | Round Glasses | | 1 |
| Common | nerd_glasses | Nerd Glasses | thick frames | 1 |
| Uncommon | sunglasses | Sunglasses | | 1 |
| Uncommon | aviators | Aviators | | 1 |
| Uncommon | eyepatch | Eyepatch | | 1 |
| Uncommon | 3d_glasses | 3D Glasses | red/cyan novelty | 1 |
| Uncommon | star_glasses | Star Glasses | star-shaped | 1 |
| Rare | monocle | Monocle | | 1 |
| Rare | heart_glasses | Heart Glasses | | 1 |
| Rare | ski_goggles | Ski Goggles | | 1 |
| Rare | round_shades | Round Shades | small round black (Morpheus) | 1 |
| Epic | cyber_visor | Cyber Visor | sci-fi, glowing | 1 |
| Epic | glowing_eyes | Glowing Eyes | effect | 1 |
| Legendary | laser_eyes | Laser Eyes | beams | 1 |
| Crazy | googly_eyes | Googly Eyes | giant spring eyes | 1 |

### 3.9 `mouth_accessory` (14) — fit: S · sits within the face (frame 92)
Stacks with `eyes_accessory`; cleared by equipping a `face_accessory` (§8).
| Rarity | id | displayName | notes | n |
|---|---|---|---|--:|
| Common | bubblegum | Bubblegum | | 1 |
| Common | pacifier | Pacifier | | 1 |
| Common | lollipop | Lollipop | | 1 |
| Common | surgical_mask | Surgical Mask | covid-style mask | 1 |
| Uncommon | mustache | Mustache | | 1 |
| Uncommon | cigar | Cigar | | 1 |
| Uncommon | hay_straw | Hay Straw | hillbilly | 1 |
| Rare | pipe | Pipe | | 1 |
| Rare | vampire_fangs | Vampire Fangs | | 1 |
| Rare | gold_grill | Gold Grill | flex | 1 |
| Rare | lettuce_cigarette | Lettuce Cigarette | euphemistic; see §5 | 1 |
| Epic | cyber_breather | Cyber Breather | sci-fi half-mask | 1 |
| Legendary | dragon_breath | Dragon Breath | fire from mouth | 1 |
| Crazy | giant_tongue | Giant Tongue | absurd | 1 |

### 3.10 `face_accessory` (14) — fit: S · full face · frame 132 where it extends
**Mutually exclusive** with eyes + mouth — equipping auto-unequips both (§8;
`FACE_CONFLICTS`, already enforced server-side).
| Rarity | id | displayName | notes | n |
|---|---|---|---|--:|
| Common | domino_mask | Domino Mask | superhero | 1 |
| Uncommon | ski_mask | Ski Mask | | 1 |
| Uncommon | bandana_face | Bandana | over nose+mouth | 1 |
| Rare | clown_paint | Clown Paint | painted face | 1 |
| Rare | hockey_mask | Hockey Mask | | 1 |
| Rare | plague_doctor | Plague Doctor Mask | | 1 |
| Rare | gas_mask | Gas Mask | | 1 |
| Rare | ghost_mask | Screaming Ghost Mask | Scream-style (generic name) | 1 |
| Rare | tiki_mask | Tiki Mask | Polynesian/Hawaiian tribal | 1 |
| Epic | robot_visor | Robot Visor | sci-fi | 1 |
| Epic | oni_mask | Oni Mask (132) | horned demon | 1 |
| Epic | geisha_mask | Geisha Mask | | 1 |
| Legendary | golden_mask | Golden Phantom Mask | | 1 |
| Crazy | disco_ball_head | Disco Ball Head (132) | absurd | 1 |

## 4. Implementation implications (mostly art, minimal code)

Verified 2026-06-18 — the earlier "new slot render support" concern was wrong:

1. **No new slots, no renderer changes.** All 12 slots exist in `EQUIPMENT_SLOTS`
   and `LAYER_ORDER`; the equip loop is slot-agnostic. Items render once their
   `equip_{id}_{body}_{dir}` textures are present. `back` already renders behind
   the body, `air_space` on top (`IsoScene.ts:108`).
2. **`air_space` (aura)** draws as a flat directional overlay sprite like a hat —
   so an aura ships as a looping effect spritesheet, no special path. A true
   particle emitter is an *optional* future enhancement, not a blocker.
3. **Larger frames** — wings/banners/big back items at 152, hats/hair at 132.
   `wizard_hat` already proves the 132 path; `frameSize` scales at render
   (`IsoScene.ts:1425`).
4. **`fit`** — clothing (upper/lower/feet) is `gendered`; head/hair/back/aura are
   `shared`. Matches the existing pipeline; no new fit logic.
5. **`sources`** — all gacha-eligible by default. Starter kit stays
   `worn_tshirt`+`blue_jeans`+`beatup_sneakers`; no backfill (gacha AC #9b).
6. **Inventory UI** already enumerates all slots via `SLOT_META` /
   `ITEM_SLOT_META`, so new-slot items appear in the equip grid automatically.
7. **Release gate (`released: boolean`).** All 214 new items ship as
   `released: false` so the **live gacha pool excludes them** until their art
   exists — otherwise players would pull invisible items (missing textures =
   nothing renders). `inGachaPool` is extended to require `released !== false`.
   The 26 existing items omit the field (→ released, pullable, pool unchanged).
   As each batch's art lands, flip `released: true` to light up that content.
   The full-pool odds in §2 are the **post-art** target, reached incrementally.

## 5. Art production (gated on PixelLab reset)

218 new sprite sets, **blocked until the monthly PixelLab reset** (5009/5000,
exhausted). Cost shape:
- **Color variants are palette-swaps** (recolor pipeline) — the bulk of the
  count, the cheapest art. TEE10/TRACK8/HAIR5/etc. are one base + recolors.
- **Gendered clothing** (upper/lower/feet) needs male+female base sets ×
  walk/idle/run/jump; medium/dark are recolors.
- **Shared overlays** (head/hair/back) = one set each, walk/idle minimum;
  flames/wings/thrusters want run/jump so motion reads in a race.
- **Auras** (12) = effect spritesheets; cheaper authoring, no fit needed.

**Stage by tier across resets:** Uncommon/Rare breadth first (varied free pulls
+ clears the paid-pull depth gate), then Epic, then Legendary/Crazy as the
marketing chase pieces.

> **Content note — `lettuce_cigarette` (Rare mouth):** renamed from "grass
> cigarette" to "lettuce cigarette" — now reads as a harmless gag (people do
> roll lettuce/herbal cigarettes) with no explicit drug reference, which should
> clear store age-rating concerns. Kept on the gacha legal review checklist as
> a courtesy, but no longer a flag.

## 6. Gabriel's must-haves (open insertion points)
Reserved for signature/meme/Belgian-in-joke picks "to add later." Natural
homes: **Crazy** back/air_space/head, **Legendary** anything. Adding items
never breaks gacha (engine only cares that a tier is non-empty). Already slotted
from this batch: shark_onesie (Crazy), traffic_cone_hat, beer_can_cap,
helicopter_cap, duck_floatie, aura_toilet_ring.

## 7. Acceptance criteria
1. `shared/items.ts` holds all 244 ids (26 released + 218 `released: false`);
   the catalog parses and the server builds without error.
2. **Today:** `buildPool` over released-only = the existing 26 (odds unchanged,
   76.9/23.1). **Post-art (per batch):** flipping `released: true` makes the
   corresponding tiers non-empty; at full release `computeOdds` → 50/30/15/4/
   0.9/0.1 (±0.01).
3. Every clothing item resolves a valid `equipmentBodyKey`; every shared item →
   `male`. No id collisions; the 26 existing items are byte-unchanged.
4. New-slot items (`hair`/`back`/`air_space`) pass inventory equip validation
   and appear in the equip grid.
5. (Post-art) hair above head, back behind body, aura on top — verified **in
   motion** with 2 clients (motion-QA rule).

## 8. Face-region conflict rule + deferred slots

**Eyes / mouth / face are now drafted in §3.8–3.10.** The conflict logic they
rely on is **already coded** — equipping a `face_accessory` auto-unequips any
`eyes_accessory` + `mouth_accessory`; equipping eyes or mouth auto-unequips
face. Eyes and mouth are independent and stack. Source: `FACE_CONFLICTS`
(`mongo.ts:190`) + equip transaction (`mongo.ts:441`); GDD #08 §3.6, #11 §3.6;
AC-INV-020…024.

**Deferred slots (no items in this catalog, by Gabriel's call):**

| Slot | Status | Notes |
|---|---|---|
| `hand_1h` | slot 11, render loop ready | wand, phone, flower, sign, weapon prop — **"keep for later."** Needs a held-item anchor/anim pass before it reads well in motion. |
| `skin` | slot 1, migration **[PLANNED]** #08 §3.3 | base-body migration owns it; rare gacha skins come after that lands. |
</content>
