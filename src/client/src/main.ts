import Phaser from 'phaser';
import { TitleScene } from './TitleScene';
import { LobbyScene } from './LobbyScene';
import { IsoScene } from './IsoScene';
import { installVolumeControl } from './volumeControl';

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
});
// Global audio control — persists across every scene (title → lobby → race).
installVolumeControl(game);
// Expose for debugging / automated tests
(window as unknown as { __game: Phaser.Game }).__game = game;
