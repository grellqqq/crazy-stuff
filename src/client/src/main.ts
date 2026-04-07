import Phaser from 'phaser';
import { TitleScene } from './TitleScene';
import { IsoScene } from './IsoScene';

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
  scene: [TitleScene, IsoScene],
};

new Phaser.Game(config);
