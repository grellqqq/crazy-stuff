import Phaser from 'phaser';
import { TitleScene } from './TitleScene';
import { LobbyScene } from './LobbyScene';
import { IsoScene } from './IsoScene';

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
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: isLobbyPreview ? [LobbyScene] : isDevMode ? [IsoScene] : [TitleScene, LobbyScene, IsoScene],
};

const game = new Phaser.Game(config);
// Expose for debugging / automated tests
(window as unknown as { __game: Phaser.Game }).__game = game;
