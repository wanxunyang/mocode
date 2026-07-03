// 桌宠 WS 协议:pet-app 子包侧的类型定义与消息校验。
// 与 src/pet/protocol.ts(mocode 主包侧)字段保持一致,但两处各自维护副本——
// 子包不依赖主包源码(两者是独立发布单元,主包只在需要时 spawn 子包的可执行文件)。

/** 桌宠状态集合。 */
export type PetState =
  | 'idle'
  | 'thinking'
  | 'speaking'
  | 'tool_call'
  | 'done'
  | 'aborted'
  | 'error'
  | 'waiting_human';

/** 全部合法状态值(供运行时校验)。 */
export const PET_STATES: readonly PetState[] = [
  'idle',
  'thinking',
  'speaking',
  'tool_call',
  'done',
  'aborted',
  'error',
  'waiting_human',
];

/** 状态负载:随 state 消息携带的可选元数据。 */
export interface PetStateMeta {
  toolName?: string;
  errorMessage?: string;
}

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

/** 主动请求桌宠进程整体退出(与 bye 不同:bye 只断开本连接,shutdown 让桌宠 app.quit()）。 */
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

/** 皮肤列表(供 mocode 侧 /pet skin 菜单展示)。 */
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
 *  永不抛错——Server 据此静默丢弃畸形消息,不断开连接(Requirement 6.1)。 */
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
