import './index.css';
import { Game } from './core/Game';

const canvasContainer = document.getElementById('game-canvas-container')!;
const uiRoot = document.getElementById('ui-root')!;

const game = new Game(canvasContainer, uiRoot);
if (import.meta.env.DEV) {
  (window as unknown as { __game: Game }).__game = game;
}
game.init().catch((err) => {
  console.error('Failed to initialize DEADLOCK DISTRICT:', err);
});
