import Phaser from 'phaser';
import { TitleScene } from './TitleScene';
import { LobbyScene } from './LobbyScene';
import { IsoScene } from './IsoScene';
import { installVolumeControl } from './volumeControl';
import { installOrientationNudge, installMobileStyles } from './mobile';

// Dev mode: add ?dev to URL to skip login and go straight to race.
// Lobby preview: add ?lobby to boot straight into the lobby (no server/login
// needed) — handy for eyeballing the map/art. Network calls fail silently.
const params = new URLSearchParams(window.location.search);
const isDevMode = params.has('dev');
const isLobbyPreview = params.has('lobby');

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  backgroundColor: '#0a0a18',
  parent: 'game',
  // Crisp pixel art: without this Phaser bilinear-filters every sprite —
  // at the 0.75 character scale all garment/face edges smear into mush,
  // which is why cosmetics looked far worse in-game than in the sheets.
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: isLobbyPreview ? [LobbyScene] : isDevMode ? [IsoScene] : [TitleScene, LobbyScene, IsoScene],
};

const game = new Phaser.Game(config);
// pixelArt:true keeps TEXTURE sampling crisp (no more bilinear mush on
// sprites), but it also sets image-rendering:pixelated on the canvas — and
// the FIT scale to a monitor is almost never an integer factor, so the final
// upscale doubles every Nth pixel: chunky, uneven, jagged. Smooth ONLY the
// final canvas upscale; internal rendering stays crisp.
game.events.once(Phaser.Core.Events.READY, () => {
  game.canvas.style.imageRendering = 'auto';
  // Touch devices: stop the browser hijacking drags/double-tap so the on-screen
  // joystick and buttons get every touch. Harmless on desktop.
  game.canvas.style.touchAction = 'none';
});
// Global audio control — persists across every scene (title → lobby → race).
installVolumeControl(game);
// Mobile: responsive panel sizing + a "rotate to landscape" nudge in portrait.
installMobileStyles();
installOrientationNudge();

// Audio autoplay unlock. Browsers start the WebAudio context SUSPENDED and keep
// Phaser's sound manager `locked` (queuing ALL music/SFX) until a user gesture.
// Phaser listens on document.body, but on some mobile browsers that path doesn't
// fire — the same class of issue that blocked the title tap — leaving the game
// silent. So we drive it from our OWN DOM gesture listener (the reliable touch
// primitive): resume the context, then set `unlocked` so the manager's next
// update() clears the lock, emits UNLOCKED, and flushes the queued sounds.
{
  const AUDIO_EVENTS = ['touchend', 'touchstart', 'pointerup', 'mousedown', 'click', 'keydown'] as const;
  const kickAudio = () => {
    const sm = game.sound as Phaser.Sound.WebAudioSoundManager & { unlocked: boolean };
    const ctx = sm.context as AudioContext | undefined;
    const finish = () => {
      sm.unlocked = true;
      for (const ev of AUDIO_EVENTS) window.removeEventListener(ev, kickAudio);
    };
    if (!ctx || ctx.state === 'running') { finish(); return; }
    ctx.resume().then(finish).catch(() => { /* try again on the next gesture */ });
  };
  for (const ev of AUDIO_EVENTS) window.addEventListener(ev, kickAudio, { passive: true });
}
// Expose for debugging / automated tests
(window as unknown as { __game: Phaser.Game }).__game = game;

// Build stamp (dev only): a page loaded from a live edit shows this the instant it
// boots. If it's missing or shows an old tag after a reload, the tab is stale (it
// kept an old JS bundle) — reload harder. Cuts through "did my change even load?".
export const BUILD_TAG = 'tiki-depth-v31 / 2026-08-01';
if (isDevMode) {
  const b = document.createElement('div');
  b.textContent = `BUILD: ${BUILD_TAG}`;
  Object.assign(b.style, {
    position: 'fixed', right: '8px', bottom: '8px', zIndex: '99999',
    font: '12px monospace', color: '#0f0', background: 'rgba(0,0,0,.75)',
    padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none',
  });
  document.body.appendChild(b);
}
