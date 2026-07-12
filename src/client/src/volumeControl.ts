import Phaser from 'phaser';

// Persistent, scene-independent audio control. Lives in the DOM (not a Phaser
// object) so it survives every scene transition — present from the title intro
// through the lobby and race. Drives Phaser's MASTER sound manager, so it
// scales every sound/music/SFX at once, and remembers the setting per browser.

const LS_VOL = 'cs_volume';
const LS_MUTE = 'cs_muted';

export function installVolumeControl(game: Phaser.Game): void {
  if (document.getElementById('cs-volume')) return; // install once

  const ls = (fn: () => void) => { try { fn(); } catch { /* storage blocked */ } };
  let savedVol = NaN;
  let muted = false;
  ls(() => {
    savedVol = parseFloat(localStorage.getItem(LS_VOL) ?? '');
    muted = localStorage.getItem(LS_MUTE) === '1';
  });
  let vol = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 0.6;

  const applyToGame = () => {
    try {
      game.sound.volume = vol;
      game.sound.mute = muted;
    } catch { /* sound manager not ready yet — reapplied on READY */ }
  };
  // Apply now, once the game is ready, AND once audio unlocks. Web Audio stays
  // LOCKED until the first user gesture (the title "click to enter"); while
  // locked the master-gain node doesn't exist yet, so volume/mute setters are
  // no-ops — re-applying on UNLOCKED makes the saved level actually take hold.
  applyToGame();
  game.events.once(Phaser.Core.Events.READY, applyToGame);
  game.sound.once(Phaser.Sound.Events.UNLOCKED, applyToGame);

  const wrap = document.createElement('div');
  wrap.id = 'cs-volume';
  wrap.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:10001',
    'display:flex', 'align-items:center', 'gap:8px',
    'background:rgba(10,10,24,0.72)', 'border:1px solid #2a2a44',
    'border-radius:20px', 'padding:6px 10px', 'font-family:monospace',
    'user-select:none', '-webkit-user-select:none',
  ].join(';');

  const btn = document.createElement('button');
  btn.title = 'Mute / unmute';
  btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:18px;line-height:1;padding:0;';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.title = 'Volume';
  slider.style.cssText = 'width:84px;accent-color:#ffdd22;cursor:pointer;';

  const icon = () => (muted || vol === 0 ? '🔇' : vol < 0.5 ? '🔈' : '🔊');
  const render = () => {
    btn.textContent = icon();
    slider.value = String(Math.round((muted ? 0 : vol) * 100));
    applyToGame();
    ls(() => {
      localStorage.setItem(LS_VOL, String(vol));
      localStorage.setItem(LS_MUTE, muted ? '1' : '0');
    });
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    muted = !muted;
    if (!muted && vol === 0) vol = 0.6; // unmuting from 0 restores audible level
    render();
  });
  slider.addEventListener('input', (e) => {
    e.stopPropagation();
    vol = Number(slider.value) / 100;
    muted = vol === 0;
    render();
  });

  // Keep the widget's own input from reaching Phaser (so adjusting volume
  // never counts as the "press any key" that skips the intro or starts play).
  for (const ev of ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup'] as const) {
    wrap.addEventListener(ev, (e) => e.stopPropagation());
  }

  wrap.appendChild(btn);
  wrap.appendChild(slider);
  document.body.appendChild(wrap);
  render();
}
