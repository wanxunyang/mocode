// 桌宠 WS 客户端 + 生命周期管理(mocode 主包侧,不 import electron)。
// /pet 命令(src/repl/index.ts)调 togglePet();主 agent hooks(src/pet/state.ts createPetHooks)
// 调 sendState() 广播状态。所有失败路径均静默降级——桌宠是可选增强,绝不能拖垮/中断主 agent 循环。

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type {
  PetState,
  PetStateMeta,
  ClientId,
  StateMessage,
  HelloMessage,
  ServerMessage,
  SkinListMessage,
} from './protocol.js';
import { parseServerMessage } from './protocol.js';

/** 默认端口;MOCODE_PET_PORT 环境变量覆盖(design.md 默认假设)。 */
export const DEFAULT_PET_PORT = 47821;
function petPort(): number {
  const v = process.env.MOCODE_PET_PORT;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PET_PORT;
}

/** 探测端口超时(ms)。 */
const PROBE_TIMEOUT_MS = 300;
/** spawn 拉起后的退避重试序列(ms),design.md 默认假设。 */
const RETRY_DELAYS_MS = [200, 400, 800, 1600, 3200];
/** 心跳间隔 / 超时(design.md 默认假设)。 */
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 10000;

/** 本进程稳定的 clientId(进程存活期间不变)。 */
const clientId: ClientId = `${process.pid}-${randomUUID()}`;

let socket: WebSocket | null = null;
let lastSentState: PetState | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
/** list_skins 请求的等待队列(先进先出;桌宠单连接场景下不会有并发歧义)。 */
const pendingSkinListResolvers: ((msg: SkinListMessage) => void)[] = [];

function clearHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
  heartbeatTimer = null;
  heartbeatTimeoutTimer = null;
}

/** 心跳超时未收到 pong → 视为死连接,清理本地状态(不重连;下次 /pet 触发时重新探测)。 */
function startHeartbeat(ws: WebSocket): void {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch {
      // 发送失败:静默,等超时定时器兜底清理
    }
    heartbeatTimeoutTimer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // no-op
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

/**
 * 探测本地端口是否已有 WS server 监听并可完成一次 WS 握手。
 * 前置条件:port 为合法端口号。
 * 后置条件:返回 true 表示 <timeoutMs> 内握手成功(桌宠已在跑);false 表示超时/拒绝连接。
 * 无副作用(探测用的临时连接在返回前关闭)。
 */
export function probePort(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
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
    }, timeoutMs);
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

/**
 * 拉起独立 Electron 桌宠进程(detached,不随当前 mocode 进程退出而杀死)。
 * 前置条件:调用方已确认端口未被占用(避免重复 spawn)。
 * 后置条件:
 *   - resolve() 表示 spawn 系统调用成功发出(不代表桌宠已可连接,调用方需配合 connectWithBackoff)。
 *   - reject(err) 表示可执行文件不可解析(mocode-pet-app 未安装/安装失败)——降级路径。
 */
export function spawnPetProcess(): Promise<void> {
  return new Promise((resolve, reject) => {
    let binPath: string;
    try {
      const require = createRequire(import.meta.url);
      binPath = require.resolve('mocode-pet-app/bin/pet-app.js');
    } catch {
      reject(new Error('mocode-pet-app 未安装,请运行 npm install mocode-pet-app'));
      return;
    }
    try {
      const child = spawn(process.execPath, [binPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (err) => reject(err));
      child.unref();
      resolve();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * 按退避序列重试连接,直到成功或耗尽重试次数。
 * 前置条件:retryDelaysMs 非空、单调(本设计取 [200,400,800,1600,3200])。
 * 后置条件:
 *   - resolve(ws) 表示某次尝试内 probePort/connect 成功。
 *   - reject(err) 表示所有尝试均失败,err 汇总最后一次失败原因。
 * 循环不变量:每次尝试前 attempts < retryDelaysMs.length;每次失败后 attempts 严格 +1。
 */
export async function connectWithBackoff(port: number, retryDelaysMs: number[] = RETRY_DELAYS_MS): Promise<WebSocket> {
  let lastErr: Error = new Error('连接失败');
  for (let attempts = 0; attempts < retryDelaysMs.length; attempts++) {
    await sleep(retryDelaysMs[attempts]);
    const ok = await probePort(port, PROBE_TIMEOUT_MS);
    if (ok) {
      try {
        return await openConnection(port);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        continue;
      }
    }
    lastErr = new Error('桌宠尚未就绪(端口未监听)');
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 真正建立并返回一条打开的 WS 连接(不做探测,假定端口已确认可连)。 */
function openConnection(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // no-op
      }
      reject(new Error('连接超时'));
    }, PROBE_TIMEOUT_MS * 2);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** 连接建立后的公共收尾:发 hello、挂消息/关闭监听、起心跳。 */
function wireConnection(ws: WebSocket): void {
  socket = ws;
  lastSentState = null;
  const hello: HelloMessage = {
    type: 'hello',
    clientId,
    pid: process.pid,
    cwd: process.cwd(),
    ts: Date.now(),
  };
  try {
    ws.send(JSON.stringify(hello));
  } catch {
    // 静默:hello 发送失败不影响后续状态广播尝试(sendState 内部会再检查连接状态)
  }
  ws.on('message', (data: RawData) => {
    const msg: ServerMessage | null = parseServerMessage(String(data));
    if (!msg) return; // 解析失败静默丢弃(协议层已保证不抛错)
    if (msg.type === 'pong' && heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
      return;
    }
    if (msg.type === 'skin_list') {
      const resolver = pendingSkinListResolvers.shift();
      resolver?.(msg);
      return;
    }
  });
  ws.once('close', () => {
    if (socket === ws) {
      socket = null;
      clearHeartbeat();
    }
  });
  ws.once('error', () => {
    // 连接异常:不自动重连(避免用户已关闭桌宠窗口时无限重连刷日志);下次 /pet 触发时重新走探测/拉起流程。
    if (socket === ws) {
      socket = null;
      clearHeartbeat();
    }
  });
  startHeartbeat(ws);
}

/**
 * 发送一次状态消息(经节流:与上次发送状态相同则跳过)。
 * 前置条件:无(未连接时静默 no-op,不抛错、不阻塞 agent 主循环)。
 * 后置条件:若 state !== lastSentState,构造并发送一条合法 StateMessage;否则无副作用。
 */
export function sendState(state: PetState, meta?: PetStateMeta): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return; // 未连接:no-op,不缓冲不报错
  if (state === lastSentState) return; // 节流:状态未变化不重发
  lastSentState = state;
  const msg: StateMessage = { type: 'state', clientId, state, meta, ts: Date.now() };
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // 静默:发送失败不影响 agent 主循环
  }
}

/** 当前是否已建立活跃连接。 */
export function isConnected(): boolean {
  return !!socket && socket.readyState === WebSocket.OPEN;
}

/** 主动断开连接(best-effort 发 bye 后 close code=1000)。 */
export function disconnect(): void {
  clearHeartbeat();
  if (!socket) return;
  const ws = socket;
  socket = null;
  try {
    ws.send(JSON.stringify({ type: 'bye', clientId, ts: Date.now() }));
  } catch {
    // no-op
  }
  try {
    ws.close(1000);
  } catch {
    // no-op
  }
}

/**
 * 请求桌宠进程整体退出(方案C:CLI 侧退出入口;托盘图标是桌面侧的另一入口,见 packages/pet-app/src/main.ts)。
 * 不要求本连接是活跃连接——任何已连接的 mocode 进程都可以关闭桌宠。
 * 前置条件:当前进程已建立连接(未连接则先尝试探测端口直连,再发 shutdown)。
 * 后置条件:发送 shutdown 消息后主动断开本地连接;不等待桌宠进程确认退出(best-effort,不阻塞 REPL)。
 */
export async function killPetProcess(): Promise<{ ok: boolean; reason?: string }> {
  const port = petPort();
  let ws = socket;
  let owned = false; // 是否为本函数临时建立的连接(需要负责关闭)
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const already = await probePort(port, PROBE_TIMEOUT_MS);
    if (!already) {
      return { ok: false, reason: '桌宠未运行' };
    }
    try {
      ws = await openConnection(port);
      owned = true;
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : '无法连接桌宠' };
    }
  }
  try {
    ws.send(JSON.stringify({ type: 'shutdown', clientId, ts: Date.now() }));
  } catch {
    // 静默:发送失败不影响后续清理
  }
  try {
    ws.close(1000);
  } catch {
    // no-op
  }
  if (!owned && socket === ws) {
    // 本连接原本就是活跃连接:同步清理本地状态(桌宠进程退出后 WS 也会被动关闭,这里主动先清)。
    socket = null;
    clearHeartbeat();
  }
  return { ok: true };
}

/**
 * 请求当前可用皮肤列表(供 /pet skin 菜单展示)。
 * 前置条件:当前进程已建立连接(未连接则先尝试探测端口直连;若桌宠未运行则失败)。
 * 后置条件:resolve 桌宠回复的 SkinListMessage;超时(2s 内无回复)reject。
 */
export async function listSkins(): Promise<SkinListMessage> {
  const port = petPort();
  let ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const already = await probePort(port, PROBE_TIMEOUT_MS);
    if (!already) throw new Error('桌宠未运行,请先 /pet 打开');
    ws = await openConnection(port);
    wireConnection(ws);
  }
  return new Promise<SkinListMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = pendingSkinListResolvers.indexOf(onMsg);
      if (idx >= 0) pendingSkinListResolvers.splice(idx, 1);
      reject(new Error('桌宠未响应皮肤列表请求'));
    }, 2000);
    const onMsg = (msg: SkinListMessage): void => {
      clearTimeout(timer);
      resolve(msg);
    };
    pendingSkinListResolvers.push(onMsg);
    try {
      ws!.send(JSON.stringify({ type: 'list_skins', ts: Date.now() }));
    } catch (e) {
      clearTimeout(timer);
      const idx = pendingSkinListResolvers.indexOf(onMsg);
      if (idx >= 0) pendingSkinListResolvers.splice(idx, 1);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * 请求桌宠切换皮肤(选宠物)。
 * 前置条件:当前进程已建立连接(未连接则静默 no-op,与 sendState 的降级策略一致)。
 * 后置条件:已连接时发送 set_skin 消息;未连接时不抛错、无副作用。
 */
export function setSkin(skinId: string): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ type: 'set_skin', clientId, skinId, ts: Date.now() }));
  } catch {
    // 静默:发送失败不影响 REPL 主流程
  }
}

/**
 * /pet 命令入口。
 * 前置条件:REPL 主循环已初始化(不要求 agent 正在运行)。
 * 后置条件:
 *   - 若调用前无活跃连接:调用后 either 已建立连接(connected=true)
 *     或已尝试 spawn+重试全部失败(connected=false,附错误原因)。
 *   - 若调用前有活跃连接:调用后连接已关闭(connected=false)。
 * 不抛异常(所有失败路径转为返回值,供 REPL 渲染提示行)。
 */
export async function togglePet(): Promise<{ connected: boolean; reason?: string }> {
  if (isConnected()) {
    disconnect();
    return { connected: false, reason: '已断开桌宠连接' };
  }

  const port = petPort();
  try {
    const already = await probePort(port, PROBE_TIMEOUT_MS);
    if (already) {
      const ws = await openConnection(port);
      wireConnection(ws);
      return { connected: true };
    }

    try {
      await spawnPetProcess();
    } catch (e) {
      return {
        connected: false,
        reason: e instanceof Error ? e.message : '无法启动桌宠进程',
      };
    }

    const ws = await connectWithBackoff(port, RETRY_DELAYS_MS);
    wireConnection(ws);
    return { connected: true };
  } catch (e) {
    return {
      connected: false,
      reason: e instanceof Error ? e.message : '桌宠启动超时,请手动检查',
    };
  }
}
