import type {
  HostAttachment,
  HostCommand,
  HostMemoryAction,
  HostMode,
  HostSessionAction,
  HostSessionScope,
  HostSettingValue,
} from '@mocode/protocol/host';

export type { HostAttachment, HostCommand, HostEnvelope } from '@mocode/protocol/host';

/**
 * 宿主协议版本 —— **在这里定义**，不从 `@mocode/protocol` 值导入。
 *
 * 为什么不能 import 值：`@mocode/protocol` 是 private workspace 包，不随根包发到 npm。
 * 根包的 `dependencies` 里没有它，而 `bin/mocode-agent-host.js` 是用户真正会执行的入口。
 * 一旦这里出现值导入，编译产物 `dist/host/protocol.js` 会留下裸 import，tarball 安装后
 * 宿主一启动就是 `ERR_MODULE_NOT_FOUND: Cannot find package '@mocode/protocol'` ——
 * 1.10.0 的隔离安装 smoke 就是这么发现的（类型导入会被编译期擦除，所以以前没暴露）。
 *
 * 版本号的事实源仍是 `packages/protocol/src/host.ts`；两处相等由
 * `tests/host/protocol-version.test.ts` 扫描源码断言，改一处忘另一处会直接红。
 */
export const HOST_PROTOCOL_VERSION = 4;

function parseAttachments(value: unknown): HostAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HostAttachment[] = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== 'string') continue;
    const name = entry.name.slice(0, 240);
    if (typeof entry.dataUrl === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(entry.dataUrl)) {
      out.push({ name, dataUrl: entry.dataUrl });
    } else if (typeof entry.text === 'string' && entry.text.trim() && entry.text.length <= 100_000) {
      out.push({ name, text: entry.text, truncated: entry.truncated === true });
    }
  }
  return out;
}

/** 有限枚举白名单：拼错/未知取值一律 null，由调用方当作非法命令拒掉（fail-closed）。 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const SESSION_ACTIONS: readonly HostSessionAction[] = ['list', 'search', 'resume', 'fork', 'workspaces'];
const SESSION_SCOPES: readonly HostSessionScope[] = ['current', 'all'];
const MEMORY_ACTIONS: readonly HostMemoryAction[] = [
  'overview',
  'health',
  'audit',
  'profile',
  'confirm',
  'drop',
  'search',
  'forget',
  'reflect',
];
const MODES: readonly HostMode[] = ['auto', 'plan'];

/** 正整数上限解析：非法/负数一律 undefined，交给 host 侧用默认值。 */
function positiveInt(value: unknown, max = 10_000): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 && n <= max ? n : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 0 ? n : undefined;
}

function optionalString(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/** 文件路径列表：只收字符串，逐个截断，去重后限量。 */
function parsePaths(value: unknown, max = 200): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item) continue;
    const trimmed = item.slice(0, 1000);
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/** 设置 patch：只接受 string / number / boolean / null，其余键直接丢弃。 */
function parseSettingPatch(value: unknown): Record<string, HostSettingValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, HostSettingValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(key)) continue;
    if (raw === null) out[key] = null;
    else if (typeof raw === 'string' || typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * NDJSON 行 → HostCommand。未知 type / 必填字段缺失 / 枚举越界一律返回 null。
 *
 * 这里是 host 的唯一入口，所以每条命令都必须显式解析（不做透传）：客户端多塞的字段
 * 不会自己流进业务层，避免「客户端决定 host 行为」。
 */
export function parseCommand(value: unknown): HostCommand | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || typeof input.type !== 'string') return null;
  const id = input.id;

  if (input.type === 'run' && typeof input.prompt === 'string') {
    return {
      id,
      type: 'run',
      prompt: input.prompt,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
      attachments: parseAttachments(input.attachments),
    };
  }
  if (input.type === 'cancel') return { id, type: 'cancel' };
  if (input.type === 'compact')
    return { id, type: 'compact', focus: typeof input.focus === 'string' ? input.focus : undefined };
  if (input.type === 'approval' && typeof input.approvalId === 'string') {
    return {
      id,
      type: 'approval',
      approvalId: input.approvalId,
      // 白名单而不是强转：未知取值一律当取消（fail-closed），不给「拼错的 action 意外放行」留口子。
      action:
        input.action === 'selected' || input.action === 'submitted'
          ? (input.action as 'selected' | 'submitted')
          : 'cancelled',
      value: typeof input.value === 'string' ? input.value : undefined,
    };
  }
  if (input.type === 'set_mode') {
    const mode = oneOf(input.mode, MODES);
    return mode ? { id, type: 'set_mode', mode } : null;
  }
  if (input.type === 'sessions') {
    const action = oneOf(input.action, SESSION_ACTIONS);
    if (!action) return null;
    return {
      id,
      type: 'sessions',
      action,
      query: optionalString(input.query, 200),
      limit: positiveInt(input.limit, 200),
      sessionId: optionalString(input.sessionId, 200),
      // scope 只对 list 有意义；未知取值当缺省（current），不因此拒掉整条命令。
      scope: oneOf(input.scope, SESSION_SCOPES) ?? undefined,
    };
  }
  if (input.type === 'rollback') {
    const action = oneOf(input.action, ['list', 'apply'] as const);
    if (!action) return null;
    // apply 必须带合法 turnIndex，否则解析成 null —— 不给「缺参数时默认回滚最近一轮」留口子。
    const turnIndex = nonNegativeInt(input.turnIndex);
    if (action === 'apply' && turnIndex === undefined) return null;
    return { id, type: 'rollback', action, turnIndex, revertFiles: parsePaths(input.revertFiles) };
  }
  if (input.type === 'changes') {
    const action = oneOf(input.action, ['list', 'diff'] as const);
    if (!action) return null;
    return {
      id,
      type: 'changes',
      action,
      turn: nonNegativeInt(input.turn),
      path: optionalString(input.path, 1000),
    };
  }
  if (input.type === 'usage') {
    const scope = oneOf(input.scope, ['session', 'global'] as const);
    if (!scope) return null;
    return {
      id,
      type: 'usage',
      scope,
      days: positiveInt(input.days, 366),
      // session 口径可显式指定会话：懒启动的 host 进程内 sessionId 是空串。
      sessionId: optionalString(input.sessionId, 200),
    };
  }
  if (input.type === 'context_usage') {
    return { id, type: 'context_usage', sessionId: optionalString(input.sessionId, 200) };
  }
  if (input.type === 'memory') {
    const action = oneOf(input.action, MEMORY_ACTIONS);
    if (!action) return null;
    return {
      id,
      type: 'memory',
      action,
      query: optionalString(input.query, 200),
      entryId: optionalString(input.entryId, 200),
      limit: positiveInt(input.limit, 200),
      confirm: input.confirm === true,
    };
  }
  if (input.type === 'commit_message') {
    const diff = optionalString(input.diff, 120_000);
    const stat = optionalString(input.stat, 24_000);
    const files = parsePaths(input.files, 2_000);
    if (!diff || !stat || !files?.length) return null;
    return {
      id,
      type: 'commit_message',
      diff,
      stat,
      files,
      truncated: input.truncated === true,
      language: oneOf(input.language, ['zh-CN', 'en-US'] as const) ?? undefined,
    };
  }
  if (input.type === 'cancel_commit_message') {
    const targetId = optionalString(input.targetId, 200);
    return targetId ? { id, type: 'cancel_commit_message', targetId } : null;
  }
  if (input.type === 'settings') {
    const action = oneOf(input.action, ['get', 'set'] as const);
    if (!action) return null;
    const patch = parseSettingPatch(input.patch);
    if (action === 'set' && !patch) return null;
    return { id, type: 'settings', action, patch };
  }
  return null;
}
