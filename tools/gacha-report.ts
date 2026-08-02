/* One-off: print gacha pool composition + effective odds, current vs hair-released. */
import { ITEMS, ItemDef, Rarity } from '../src/shared/items';
import { buildPool, computeOdds, GACHA_CONFIG } from '../src/shared/gacha';
import { STORE_PRICES } from '../src/shared/store';

const TIERS: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'crazy'];
const pct = (n: number) => (n * 100).toFixed(2) + '%';

function report(label: string, items: Record<string, ItemDef>) {
  const pool = buildPool(items);
  const odds = computeOdds(pool, 'common');
  console.log(`\n===== ${label} =====`);
  console.log('tier        weight   odds     #items  per-item   storeCoins');
  for (const t of TIERS) {
    const n = pool[t].length;
    const o = odds[t] ?? 0;
    const per = n ? pct(o / n) : '—';
    console.log(
      `${t.padEnd(11)} ${String(GACHA_CONFIG.tierWeights[t]).padStart(5)}   ${pct(o).padStart(6)}   ${String(n).padStart(4)}   ${per.padStart(8)}   ${String(STORE_PRICES[t]).padStart(6)}`,
    );
  }
  const total = TIERS.reduce((s, t) => s + pool[t].length, 0);
  console.log(`total gacha-pool items: ${total}`);
  return pool;
}

// Current
report('CURRENT (hair NOT released)', ITEMS);

// Hypothetical: flip wave-1 hair to released
const withHair: Record<string, ItemDef> = {};
const WAVE1 = ['hair_short', 'hair_ponytail', 'hair_long', 'hair_afro', 'hair_dreads'];
for (const [id, it] of Object.entries(ITEMS)) {
  const isWave1Hair = WAVE1.some((p) => id.startsWith(p + '_'));
  withHair[id] = isWave1Hair ? { ...it, released: true } : it;
}
const pool = report('IF WAVE-1 HAIR RELEASED (+25 items)', withHair);

// Show the hair items entering, by tier
console.log('\n--- wave-1 hair added, by tier ---');
for (const t of TIERS) {
  const hairs = pool[t].filter((i) => WAVE1.some((p) => i.id.startsWith(p + '_')));
  if (hairs.length) console.log(`${t}: ${hairs.map((i) => i.id).join(', ')}`);
}
