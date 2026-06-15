/**
 * Synthesized gacha sound effects (WebAudio, zero assets). A short tick as the
 * reel cells pass, and a reveal stinger that grows richer/brighter with rarity.
 * The AudioContext is created lazily on the first pull click (a user gesture),
 * so autoplay policies are satisfied.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** A short click as a reel cell passes the marker. */
export function gachaTick(): void {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'square';
  o.frequency.value = 1150;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.06);
}

/** Reveal stinger. rank 0 (common) … 5 (crazy): more notes, brighter, longer. */
export function gachaReveal(rank: number): void {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const base = 330; // E4
  const steps = [0, 4, 7, 12, 16, 19]; // major arpeggio
  const noteCount = Math.max(2, Math.min(6, 2 + rank));
  const noteDur = 0.13;
  for (let i = 0; i < noteCount; i++) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = rank >= 3 ? 'triangle' : 'sine';
    o.frequency.value = base * Math.pow(2, steps[i] / 12);
    const start = t + i * (noteDur * 0.55);
    const vol = 0.07 + rank * 0.015;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + noteDur);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + noteDur + 0.02);
  }
  // Bright upward shimmer for epic+ (rank 3+).
  if (rank >= 3) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1200, t);
    o.frequency.exponentialRampToValueAtTime(2800, t + 0.45);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.6);
  }
}
