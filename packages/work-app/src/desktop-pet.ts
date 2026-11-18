import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectPetTask, type PetTask } from './pet-state.js';
import { PetTaskNotices, petLookAt } from './pet-notices.js';
import { normalizePetCharacter, type PetCharacterId } from './pet-characters.js';

export class DesktopPet {
  private window: BrowserWindow | null = null;
  private tasks: PetTask[] = [];
  private notices = new PetTaskNotices();
  private character: PetCharacterId = 'byte';
  constructor() {
    ipcMain.handle('pet:character', (event) => (event.sender === this.window?.webContents ? this.character : null));
    ipcMain.handle('pet:notice', (event) => {
      if (event.sender !== this.window?.webContents) return null;
      return this.notices.next();
    });
    ipcMain.handle('pet:cursor', (event) => {
      if (event.sender !== this.window?.webContents) return null;
      const [x, y] = this.window!.getPosition();
      return petLookAt(screen.getCursorScreenPoint(), { x: x + 120, y: y + 145 });
    });
    ipcMain.handle('pet:snapshot', (event) => {
      if (event.sender !== this.window?.webContents) return null;
      return selectPetTask(this.tasks);
    });
    ipcMain.on('pet:move', (event, delta: unknown) => {
      if (
        event.sender !== this.window?.webContents ||
        !Array.isArray(delta) ||
        delta.length !== 2 ||
        !delta.every((v) => typeof v === 'number' && Number.isFinite(v))
      )
        return;
      const win = this.window!;
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      const next = { x: Math.round(x + delta[0]), y: Math.round(y + delta[1]) };
      const area = screen.getDisplayNearestPoint({ x: next.x + width / 2, y: next.y + height / 2 }).workArea;
      win.setPosition(
        Math.round(Math.max(area.x, Math.min(area.x + area.width - width, next.x))),
        Math.round(Math.max(area.y, Math.min(area.y + area.height - height, next.y))),
      );
    });
    ipcMain.on('pet:open', (event, id: unknown) => {
      if (event.sender !== this.window?.webContents) return;
      const main = BrowserWindow.getAllWindows().find((w) => w !== this.window);
      if (!main) return;
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      if (typeof id === 'string' && this.tasks.some((t) => t.id === id))
        main.webContents.send('work:agent-event', {
          type: 'event',
          event: 'attention_open',
          requestId: id,
          payload: {},
        });
    });
  }
  update(tasks: readonly PetTask[]): void {
    this.tasks = [...tasks];
    this.notices.update(tasks, Boolean(this.window && !this.window.isDestroyed()));
  }
  setCharacter(id: PetCharacterId): void {
    const character = normalizePetCharacter(id);
    if (this.character === character) return;
    this.character = character;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.reload();
  }
  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.window?.destroy();
      this.window = null;
      return;
    }
    if (this.window && !this.window.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const root = path.dirname(fileURLToPath(import.meta.url));
    const win = new BrowserWindow({
      width: 240,
      height: 230,
      x: area.x + area.width - 260,
      y: area.y + area.height - 250,
      transparent: true,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(root, 'renderer', 'pet-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = win;
    this.notices.reset();
    this.notices.update(this.tasks);
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
    void win.loadFile(path.join(root, 'renderer', 'pet.html'));
  }
}
