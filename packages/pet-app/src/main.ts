// 桌宠 Electron 主进程:WS Server 单例 + 最新连接覆盖 + BrowserWindow 生命周期。
// 不感知 mocode CLI 内部逻辑,只是纯粹的状态转发枢纽:接收 WS state 消息 → IPC 推给渲染进程。

import { app, BrowserWindow, screen } from 'electron';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseClientMessage,
  type PetState,
  type PetStateMeta,
} from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认端口;MOCODE_PET_PORT 环境变量覆盖(与 mocode 主包 src/pet/bridge.ts 保持一致的默认假设)。 */
const DEFAULT_PORT = 47821;
function petPort(): number {
  const v = process.env.MOCODE_PET_PORT;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/** 心跳:每 15s 检查一次,10s 内无 pong 视为死连接(design.md 默认假设)。 */
const HEARTBEAT_CHECK_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 10000;

/** 状态展示超时后自动回落(design.md 默认假设:done/aborted/error 短暂展示 1500ms)。 */
const TRANSIENT_STATE_TIMEOUT_MS = 1500;

interface ConnectionRecord {
  socket: WebSocket;
  clientId: string;
  connectedAt: number;
  lastPongAt: number;
  isActive: boolean;
}

/** 全局连接表 + 唯一活跃连接引用("最新连接覆盖"算法的状态载体,见 design.md Low-Level)。 */
const connections = new Map<WebSocket, ConnectionRecord>();
let activeSocket: WebSocket | null = null;

let mainWindow: BrowserWindow | null = null;
let transientTimer: NodeJS.Timeout | null = null;

/** 把状态推给渲染进程(IPC)。渲染进程窗口未就绪时静默丢弃(下次状态到达会重推)。 */
function broadcastToRenderer(state: PetState, meta?: PetStateMeta): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('pet:state', { state, meta });
  } catch {
    // 渲染进程尚未加载完毕或已崩溃:静默,不影响 Server 侧状态机
  }
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  if (state === 'done' || state === 'aborted' || state === 'error') {
    transientTimer = setTimeout(() => {
      // 展示超时:done/aborted → idle;error → thinking(工具报错后 agent 通常还会继续跑)。
      // 简化实现:统一回 idle,若 agent 仍在跑,下一个 hook 事件会立即覆盖为正确状态。
      broadcastToRenderer('idle');
    }, TRANSIENT_STATE_TIMEOUT_MS);
  }
}

/**
 * 新连接建立时的处理:注册 ConnectionRecord,立即成为唯一 active(覆盖之前的 active)。
 * 见 design.md "最新连接覆盖"算法:不断开旧连接,只是把它降级为非活跃(isActive=false)。
 */
function onConnection(socket: WebSocket): void {
  // 步骤 1:把之前的 active 连接降级(至多一条为 active,核心不变量)
  if (activeSocket && connections.has(activeSocket)) {
    connections.get(activeSocket)!.isActive = false;
  }

  // 步骤 2:新连接成为唯一 active(clientId 在收到 hello 前先留空,占位用连接本身作 key)
  const record: ConnectionRecord = {
    socket,
    clientId: '',
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    isActive: true,
  };
  connections.set(socket, record);
  activeSocket = socket;

  send(socket, { type: 'welcome', isActive: true, ts: Date.now() });
  broadcastToRenderer('idle'); // 新连接刚建立还没收到它的第一条 state,先归 idle 兜底

  socket.on('message', (data: RawData) => onMessage(socket, String(data)));
  socket.once('close', () => onDisconnect(socket));
  socket.once('error', () => onDisconnect(socket));
}

/**
 * 连接断开处理。若断开的是活跃连接:立即广播 idle,且不提升任何"次新"连接为新的活跃状态源
 * (design.md Requirement 3.2 的核心约束)。
 */
function onDisconnect(socket: WebSocket): void {
  const wasActive = socket === activeSocket;
  connections.delete(socket);

  if (wasActive) {
    activeSocket = null; // 强制清空,不回退到任何仍 open 的连接
    broadcastToRenderer('idle');
  }
  // wasActive = false:该连接原本就被忽略,断开对当前状态源无影响
}

function onMessage(socket: WebSocket, raw: string): void {
  touchAlive(socket); // 收到任意消息即视为存活,刷新心跳超时判定基准
  const msg = parseClientMessage(raw);
  if (!msg) return; // 畸形消息:静默丢弃,连接不断开(Requirement 6.1)

  const record = connections.get(socket);
  if (!record) return;

  switch (msg.type) {
    case 'hello':
      record.clientId = msg.clientId;
      return;
    case 'ping':
      send(socket, { type: 'pong', ts: Date.now() });
      return;
    case 'bye':
      onDisconnect(socket);
      try {
        socket.close(1000);
      } catch {
        // no-op
      }
      return;
    case 'state':
      if (socket !== activeSocket) return; // 非活跃连接的状态消息静默丢弃
      broadcastToRenderer(msg.state, msg.meta);
      return;
    default:
      return;
  }
}

function send(socket: WebSocket, msg: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // 静默:发送失败不影响 Server 主循环
  }
}

/** 心跳巡检:每 HEARTBEAT_CHECK_INTERVAL_MS 检查所有连接,超时未 pong 的视为死连接并清理。 */
function startHeartbeatSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [socket, record] of connections) {
      if (now - record.lastPongAt > HEARTBEAT_TIMEOUT_MS + HEARTBEAT_CHECK_INTERVAL_MS) {
        try {
          socket.terminate();
        } catch {
          // no-op
        }
        onDisconnect(socket);
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/** pong 到达时更新 lastPongAt(客户端主动发 ping,这里作为 server 收 ping 后回 pong 的对端确认;
 *  同时 server 也可能主动关心 client 是否存活——此处简化为"收到任意消息即视为存活"，
 *  在 onMessage 里对每条消息更新，避免额外维护 ping/pong 状态机的复杂度)。 */
function touchAlive(socket: WebSocket): void {
  const record = connections.get(socket);
  if (record) record.lastPongAt = Date.now();
}

/**
 * 启动 WS Server;若端口已被占用则尝试 WS 握手验证占用方是否为桌宠自身。
 * 验证通过(是桌宠)→ 静默退出(exit 0,已有实例在跑,不重复常驻)。
 * 验证失败(端口被别的服务占用)→ 退出并附带诊断信息(exit 非 0)。
 */
async function startServer(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const httpServer = createHttpServer();
    const wss = new WebSocketServer({ server: httpServer });

    httpServer.once('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const isPet = await probeIsPetServer(port);
        if (isPet) {
          console.log('[pet-app] 端口已有桌宠实例在运行,本进程退出。');
          process.exit(0);
        } else {
          console.error(`[pet-app] 端口 ${port} 被非桌宠进程占用,无法启动。`);
          process.exit(1);
        }
      } else {
        reject(err);
      }
    });

    wss.on('connection', (socket: WebSocket) => {
      touchAlive(socket);
      onConnection(socket);
    });

    httpServer.listen(port, '127.0.0.1', () => {
      resolve(wss);
    });
  });
}

/** 探测占用端口的服务是否是桌宠自身(能完成一次 WS 握手并收到 welcome)。 */
function probeIsPetServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        // no-op
      }
      resolve(false);
    }, 500);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // no-op
      }
      resolve(true);
    });
    ws.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 跨平台悬浮窗配置(design.md 跨平台 BrowserWindow 配置差异表)。 */
function createPetWindow(): BrowserWindow {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const winHeight = 220;
  // 宽度在原有正方形基础上加宽,容纳宠物右侧的信号灯(见 renderer/style.css #signal-light-container)。
  const winWidth = 260;
  const margin = 24;

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: width - winWidth - margin,
    y: screen.getPrimaryDisplay().workAreaSize.height - winHeight - margin,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'floating');
    app.dock?.hide();
  } else {
    win.setAlwaysOnTop(true);
  }

  // 鼠标穿透:允许用户点击桌面下层内容,不遮挡操作。悬浮窗本身仍可接收自身渲染的动画更新。
  win.setIgnoreMouseEvents(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('render-process-gone', () => {
    // 渲染进程崩溃但主进程(WS Server)存活:重建一次窗口,不重启 WS Server、不断开现有客户端连接。
    console.error('[pet-app] 渲染进程崩溃,尝试重建窗口。');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    mainWindow = createPetWindow();
  });

  return win;
}

app.whenReady().then(async () => {
  const port = petPort();
  await startServer(port);
  startHeartbeatSweep();
  mainWindow = createPetWindow();
});

app.on('window-all-closed', () => {
  // 用户关闭悬浮窗:整个桌宠进程退出(WS Server 一并关闭,已连 mocode 客户端会收到 close 事件,
  // 按 bridge.ts 的"连接异常不自动重连"策略,下次 /pet 会重新探测并拉起新实例)。
  app.quit();
});
