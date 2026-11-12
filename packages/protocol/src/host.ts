/**
 * NDJSON Host 协议（work-app ⇄ mocode-agent-host 子进程）。
 *
 * 版本策略：**只做向后兼容的加法**。新增命令/事件/字段一律只增不改；
 * 老 host 收到不认识的 type 会在 parseCommand 里被拒（fail-closed），
 * 老客户端收到不认识的事件走现有 switch 的 default 分支忽略。
 * `HOST_PROTOCOL_VERSION` 由 host 在 `runtime_ready` 里回报，客户端据此提示不匹配，
 * 而不是靠猜。
 */
export const HOST_PROTOCOL_VERSION = 2;

export interface HostAttachment {
  name: string;
  dataUrl: string;
}

/** agent 运行模式：auto=可写可执行；plan=只读探查并产出计划。 */
export type HostMode = 'auto' | 'plan';

/**
 * 会话面板动作。list/search 只读；resume 切换当前会话；fork 不改当前会话。
 * workspaces 列出 mocode 用过的全部工作空间（~/.mocode/workspaces.jsonl），
 * 供 GUI 选择「看哪个工作空间的会话」——终端每进一个目录就登记一次，这份登记是跨端共享的。
 */
export type HostSessionAction = 'list' | 'search' | 'resume' | 'fork' | 'workspaces';

/**
 * 会话列表范围。current（默认）= 本 host 的工作空间，与终端 /sessions 一致；
 * all = 扫描全局工作空间注册表，把终端在别的目录里留下的会话也列出来。
 */
export type HostSessionScope = 'current' | 'all';

/**
 * 记忆面板动作。与终端的斜杠命令一一对应：
 *   overview = /memory、health = /memory health、audit = /memory audit、
 *   profile = /memory profile、confirm/drop = /memory confirm|drop <id>、
 *   search = memory_search 的用户面、forget = /memory forget、reflect = /reflect。
 * 只有 confirm/drop/forget 是写操作，客户端必须二次确认后再带 confirm:true 重发。
 */
export type HostMemoryAction =
  | 'overview'
  | 'health'
  | 'audit'
  | 'profile'
  | 'confirm'
  | 'drop'
  | 'search'
  | 'forget'
  | 'reflect';

/** 设置的取值域：字符串/数字/布尔，null 只在 set 里表示「清除该键」。 */
export type HostSettingValue = string | number | boolean | null;

export type HostCommand =
  | { id: string; type: 'run'; prompt: string; sessionId?: string; attachments?: HostAttachment[] }
  | { id: string; type: 'cancel' }
  | { id: string; type: 'compact'; focus?: string }
  /**
   * 回答一次人工介入。`submitted` 是自由文本回答（ask_human 的 input 形态），
   * 与 `selected`（从给定选项里挑一个）区分开：两者回给模型的措辞不同。
   * 旧客户端只会发 selected / cancelled，新增的取值不影响它们。
   */
  | {
      id: string;
      type: 'approval';
      approvalId: string;
      action: 'selected' | 'submitted' | 'cancelled';
      value?: string;
    }
  /** 切换 agent 模式。host 重写 history[0] 并回 `mode_changed`。 */
  | { id: string; type: 'set_mode'; mode: HostMode }
  /**
   * 会话面板。list/search 只读(顺带列出归档会话)；resume 会切换 host 内存里的当前会话；
   * fork 从 sessionId(缺省=当前会话)复制出一份新会话，**不**切换当前会话。
   */
  | {
      id: string;
      type: 'sessions';
      action: HostSessionAction;
      /** search 关键词。 */
      query?: string;
      /** list/search 的条数上限。 */
      limit?: number;
      /** resume / fork 的源会话 id；fork 缺省用当前会话。 */
      sessionId?: string;
      /**
       * list 的扫描范围（缺省 current）。all 会读全局工作空间注册表，
       * 把 mocode 终端在别的目录留下的会话一起列出来。
       */
      scope?: HostSessionScope;
    }
  /**
   * 回滚。list 只读(轮次 + 每轮改动文件)；apply 截断对话到第 turnIndex 轮之前，
   * 并**只**还原 revertFiles 里显式列出的文件——文件还原是危险操作，
   * 默认一个都不还原，调用方必须逐个列出。
   */
  | {
      id: string;
      type: 'rollback';
      action: 'list' | 'apply';
      /** 0-based 轮次下标（与 list 返回顺序一致）。 */
      turnIndex?: number;
      revertFiles?: string[];
    }
  /** 文件改动与 unified diff 文本；turn 缺省=最近一轮，path 缺省=全部文件。 */
  | { id: string; type: 'changes'; action: 'list' | 'diff'; turn?: number; path?: string }
  /**
   * 用量：session = 某个会话的 usage.jsonl；global = 跨工作空间账本窗口（days 默认 7）。
   *
   * session 口径必须能指定 sessionId：面板命令由懒启动的 host 处理时进程内 sessionId
   * 还是空的（那字段只在 run 期间有效），不带就永远查不到。
   */
  | { id: string; type: 'usage'; scope: 'session' | 'global'; days?: number; sessionId?: string }
  /** 记忆面板。写操作需带 confirm:true。 */
  | {
      id: string;
      type: 'memory';
      action: HostMemoryAction;
      query?: string;
      entryId?: string;
      limit?: number;
      confirm?: boolean;
    }
  /**
   * 运行时设置。get 返回当前快照；set 应用 patch 并持久化到 ~/.mocode/config，
   * 应答 `settings_state`。调用方负责重启 host 让启动期固化的项生效。
   */
  | { id: string; type: 'settings'; action: 'get' | 'set'; patch?: Record<string, HostSettingValue> };

export interface HostEnvelope {
  type: 'event' | 'error';
  requestId?: string;
  event?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

/** `runtime_ready` 载荷里与协议版本相关的最小形状（客户端类型提示用）。 */
export interface HostRuntimeReadyPayload {
  protocolVersion?: number;
  projectRoot?: string;
  provider?: string;
  promptCache?: boolean;
  warnings?: string[];
  pid?: number;
  workerId?: string;
}