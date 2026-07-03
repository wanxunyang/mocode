// 桌宠 WS 协议:mocode 主包侧的类型定义与消息校验。
// 与 packages/pet-app/src/protocol.ts 字段保持一致,但两处各自维护副本——
// 主包不 import 子包源码(子包是 optionalDependency,可能未安装;设计上刻意解耦)。

/** 桌宠状态集合。子 agent(task 工具派生)永不产生这些状态——只在主 agent hooks 组装处广播。 */
export type PetState =
  | 'idle' // 空闲:未在运行任何 agent 循环,或活跃连接已断开
  | 'thinking' // 等待 LLM 响应(onStepStart 已触发,尚无正文/工具调用到达)
  | 'speaking' // 正在流式输出正文(onText 首个 delta 到达后)
  | 'tool_call' // 正在调用/执行工具(onToolCall / onToolStart),可附带 toolName
  | 'done' // 本轮正常完毕(onDone),短暂展示后自动回 idle
  | 'aborted' // 用户中断(onAbort),短暂展示后自动回 idle
  | 'error'; // 工具执行报错或步数上限,短暂展示后回 thinking 或 idle

/** 全部合法状态值(供运行时校验,如 Set 成员判断)。 */
export const PET_STATES: readonly PetState[] = [
  'idle',
  'thinking',
  'speaking',
  'tool_call',
  'done',
  'aborted',
  'error',
];

/** 状态负载:随 state 消息携带的可选元数据。 */
export interface PetStateMeta {
  /** 仅 tool_call 状态携带:当前调用的工具名(如 "write_file")。 */
  toolName?: string;
  /** 仅 error 状态携带:简短错误摘要(截断,不含敏感路径/密钥)。 */
  errorMessage?: string;
}

/** 每个 mocode 进程生成一次,进程存活期间稳定。 */
export type ClientId = string;

// ── Client → Server ──────────────────────────────────────────────────────

export interface HelloMessage {
  type: 'hello';
  clientId: ClientId;
  pid: number;
  cwd: string;
  ts: number;
}

export interface StateMessage {
  type: 'state';
  clientId: ClientId;
  state: PetState;
  meta?: PetStateMeta;
  ts: number;
}

export interface PingMessage {
  type: 'ping';
  ts: number;
}

export interface ByeMessage {
  type: 'bye';
  clientId: ClientId;
  ts: number;
}

/** 主动请求桌宠进程整体退出(与 disconnect 不同:disconnect 只断开本连接,shutdown 让桌宠 app.quit()）。
 *  不要求发送方是当前活跃连接——任何已连接的 mocode 进程都可以关闭桌宠(见 Requirement 补充:关闭桌宠)。 */
export interface ShutdownMessage {
  type: 'shutdown';
  clientId: ClientId;
  ts: number;
}

/** 请求切换桌宠皮肤(选宠物)。skinId 对应 assets/pets/manifest.json 里的 id,空字符串/'default' 表示恢复默认 mascot.svg。 */
export interface SetSkinMessage {
  type: 'set_skin';
  clientId: ClientId;
  skinId: string;
  ts: number;
}

/** 请求当前可用皮肤列表(触发 server 回复 SkinListMessage)。 */
export interface ListSkinsMessage {
  type: 'list_skins';
  ts: number;
}

export type ClientMessage =
  | HelloMessage
  | StateMessage
  | PingMessage
  | ByeMessage
  | ShutdownMessage
  | SetSkinMessage
  | ListSkinsMessage;

// ── Server → Client ───────────────────────────────────────────────────────

export interface WelcomeMessage {
  type: 'welcome';
  isActive: boolean;
  ts: number;
}

export interface PongMessage {
  type: 'pong';
  ts: number;
}

/** 皮肤列表(供 /pet skin 菜单展示)。桌宠进程回复,ids 对应 assets/pets/ 下的候选素材。 */
export interface SkinListMessage {
  type: 'skin_list';
  skins: { id: string; name: string }[];
  currentSkinId: string;
  ts: number;
}

export type ServerMessage = WelcomeMessage | PongMessage | SkinListMessage;

/** 判断值是否为合法 PetState(供消息校验,非法值丢弃不崩)。 */
export function isValidPetState(v: unknown): v is PetState {
  return typeof v === 'string' && (PET_STATES as readonly string[]).includes(v);
}

/** 校验并解析一条原始 JSON 字符串为 ClientMessage;失败(JSON 非法/缺字段/type 未知)返回 null。
 *  永不抛错——调用方(bridge/server)据此静默丢弃畸形消息,不断开连接。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const m = obj as Record<string, unknown>;
  if (typeof m.ts !== 'number') return null;
  switch (m.type) {
    case 'hello':
      if (typeof m.clientId !== 'string' || typeof m.pid !== 'number' || typeof m.cwd !== 'string') {
        return null;
      }
      return { type: 'hello', clientId: m.clientId, pid: m.pid, cwd: m.cwd, ts: m.ts };
    case 'state': {
      if (typeof m.clientId !== 'string' || !isValidPetState(m.state)) return null;
      let meta: PetStateMeta | undefined;
      if (m.meta && typeof m.meta === 'object') {
        const mm = m.meta as Record<string, unknown>;
        meta = {};
        if (typeof mm.toolName === 'string') meta.toolName = mm.toolName;
        if (typeof mm.errorMessage === 'string') meta.errorMessage = mm.errorMessage;
      }
      return { type: 'state', clientId: m.clientId, state: m.state, meta, ts: m.ts };
    }
    case 'ping':
      return { type: 'ping', ts: m.ts };
    case 'bye':
      if (typeof m.clientId !== 'string') return null;
      return { type: 'bye', clientId: m.clientId, ts: m.ts };
    case 'shutdown':
      if (typeof m.clientId !== 'string') return null;
      return { type: 'shutdown', clientId: m.clientId, ts: m.ts };
    case 'set_skin':
      if (typeof m.clientId !== 'string' || typeof m.skinId !== 'string') return null;
      return { type: 'set_skin', clientId: m.clientId, skinId: m.skinId, ts: m.ts };
    case 'list_skins':
      return { type: 'list_skins', ts: m.ts };
    default:
      return null;
  }
}

/** 校验并解析一条原始 JSON 字符串为 ServerMessage;失败返回 null(同上,永不抛错)。 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const m = obj as Record<string, unknown>;
  if (typeof m.ts !== 'number') return null;
  switch (m.type) {
    case 'welcome':
      if (typeof m.isActive !== 'boolean') return null;
      return { type: 'welcome', isActive: m.isActive, ts: m.ts };
    case 'pong':
      return { type: 'pong', ts: m.ts };
    case 'skin_list': {
      if (!Array.isArray(m.skins) || typeof m.currentSkinId !== 'string') return null;
      const skins: { id: string; name: string }[] = [];
      for (const s of m.skins) {
        if (!s || typeof s !== 'object') continue;
        const ss = s as Record<string, unknown>;
        if (typeof ss.id === 'string' && typeof ss.name === 'string') {
          skins.push({ id: ss.id, name: ss.name });
        }
      }
      return { type: 'skin_list', skins, currentSkinId: m.currentSkinId, ts: m.ts };
    }
    default:
      return null;
  }
}
