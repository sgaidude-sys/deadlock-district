import './index.css';
import { AssetManager } from './core/AssetManager';
import { Game } from './core/Game';

const canvasContainer = document.getElementById('game-canvas-container')!;
const uiRoot = document.getElementById('ui-root')!;
const sharedAssets = new AssetManager();

let activeGame: Game | null = null;

function bootGame(): void {
  activeGame?.dispose();
  activeGame = new Game(canvasContainer, uiRoot, sharedAssets, bootGame);
  activeGame.init().catch((err) => {
    console.error('Failed to initialize DEADLOCK DISTRICT:', err);
  });
}

bootGame();
