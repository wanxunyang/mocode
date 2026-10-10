/**
 * computer 动作的结构化录制(design-notes/computer-use-rpa.md §5.1)。
 *
 * 与 session/gui-actions.ts 的区别:台账是给模型看的有损文本(24 条滚动);trace 是给 flow 导出用的
 * 结构化 JSONL(`gui-trace.jsonl`,同会话目录),元素动作落盘的是 selector 而不是会过期的 ref。
 *
 * 契约:
 *   - 纯函数 buildTraceEntry 不碰盘、不碰屏幕,可用 fixture 单测;
 *   - 观察类动作(screenshot/zoom/inspect/list_windows/cursor_position)不入 trace;
 *   - 命中 computerTextNeedsReview 的文本**不落明文**,记为 `{ $param: "text_<seq>" }`,回放时由调用方提供;
 *   - 写入失败静默:trace 是可观测性,绝不能影响 computer 动作结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { computerTextNeedsReview } from '../permissions/computer-review.js';
import { getSandboxRoot } from '../sandbox/root.js';
import { getCurrentSessionId } from '../session/state.js';
import {
  buildSelector,
  rectToNorm,
  type NormGeometry,
  type UiaRawTree,
  type UiaSelector,
} from '../runtime/uia-selector.js';

export const TRACE_FILENAME = 'gui-trace.jsonl';

/** 敏感文本占位:`{ $param: "text_7" }`。 */
export interface ParamRef {
  $param: string;
}

export function isParamRef(v: unknown): v is ParamRef {
  return !!v && typeof v === 'object' && typeof (v as ParamRef).$param === 'string';
}

export interface TraceEntry {
  seq: number;
  ts: string;
  action: string;
  /** 回放用参数(白名单字段;不含 ref/window ref;敏感文本为 ParamRef)。 */
  args: Record<string, unknown>;
  /** click_element / set_value:定位元素用的选择器。 */
  selector?: UiaSelector;
  /** 目标元素的 role/name,供回放前的敏感审查(selector 可能只含 automationId)。 */
  target?: { role: string; name: string };
  /** 录制时元素中心的 norm1000 坐标;只有 flow 显式 allowCoordinateFallback 才会用。 */
  fallback?: { coordinate: [number, number] };
  /** focus_window:目标窗口(processName 来自 list_windows 快照;titleRegex 仅在调用方给了 title_regex 时记录)。 */
  window?: { processName?: string; titleRegex?: string };
  /** 纯坐标动作:依赖屏幕布局,窗口一动就会失效。 */
  fragile?: boolean;
  /** 本步让界面发生了变化(导出 flow 时据此插入 wait_until stable)。 */
  changed?: boolean;
}

const KEEP_ARGS: Readonly<Record<string, readonly string[]>> = {
  mouse_move: ['coordinate'],
  left_click: ['coordinate'],
  right_click: ['coordinate'],
  middle_click: ['coordinate'],
  double_click: ['coordinate'],
  triple_click: ['coordinate'],
  left_mouse_down: ['coordinate'],
  left_mouse_up: ['coordinate'],
  left_click_drag: ['coordinate', 'coordinate_to'],
  scroll: ['coordinate', 'scroll_direction', 'scroll_amount'],
  type: ['text', 'method'],
  key: ['text'],
  wait: ['duration_ms'],
  wait_until: ['condition', 'timeout_ms'],
  click_element: ['button', 'click_count', 'via'],
  set_value: ['text', 'via'],
  focus_window: ['move_to_primary'],
};

/** 会入 trace 的动作集合。 */
export const RECORDED_ACTIONS: ReadonlySet<string> = new Set(Object.keys(KEEP_ARGS));

export function isRecordedAction(action: string): boolean {
  return RECORDED_ACTIONS.has(action);
}

const COORDINATE_ACTIONS: ReadonlySet<string> = new Set([
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'scroll',
]);

const TEXT_ACTIONS: ReadonlySet<string> = new Set(['type', 'key', 'set_value']);

export interface TraceBuildContext {
  seq: number;
  /** 测试注入;默认当前时间。 */
  ts?: string;
  /** click_element / set_value 的目标:录制时的 UIA 树与节点 id。 */
  element?: { tree: UiaRawTree; nodeId: number };
  geometry?: NormGeometry;
  /** focus_window 按 wN 选窗时,list_windows 快照里该窗口的进程名。 */
  windowProcess?: string;
  /** wait_until 条件里的 ref → role/name(把会过期的 ref 转成 selector_text)。 */
  lookupRef?: (ref: string) => { role: string; name: string } | undefined;
}

/**
 * 把一次(即将执行的)computer 调用转成 trace 条目。返回 null = 无法形成可回放的步骤(调用方不记录)。
 * 必须在执行**前**调用:此时 elementSnapshot / windowSnapshot / ref 登记表还是模型当时所见。
 */
export function buildTraceEntry(args: Record<string, unknown>, ctx: TraceBuildContext): TraceEntry | null {
  const action = typeof args.action === 'string' ? args.action : '';
  const keep = KEEP_ARGS[action];
  if (!keep) return null;

  const out: Record<string, unknown> = {};
  for (const k of keep) if (args[k] !== undefined) out[k] = args[k];

  const entry: TraceEntry = {
    seq: ctx.seq,
    ts: ctx.ts ?? new Date().toISOString(),
    action,
    args: out,
  };

  // 文本:敏感内容不落明文。
  if (TEXT_ACTIONS.has(action) && typeof out.text === 'string' && computerTextNeedsReview(out.text)) {
    out.text = { $param: `text_${ctx.seq}` } satisfies ParamRef;
  }

  if (COORDINATE_ACTIONS.has(action)) entry.fragile = true;

  if (action === 'click_element' || action === 'set_value') {
    const el = ctx.element;
    const node = el?.tree.nodes[el.nodeId];
    if (!el || !node) return null;
    entry.target = { role: node.role, name: node.name };
    const selector = buildSelector(el.tree, el.nodeId);
    if (selector) entry.selector = selector;
    else entry.fragile = true;
    if (ctx.geometry) {
      const [x, y, w, h] = rectToNorm(node.rect, ctx.geometry);
      entry.fallback = { coordinate: [Math.round(x + w / 2), Math.round(y + h / 2)] };
    }
    if (!entry.selector && !entry.fallback) return null;
  }

  if (action === 'focus_window') {
    const titleRegex = typeof args.title_regex === 'string' ? args.title_regex : undefined;
    if (!ctx.windowProcess && !titleRegex) return null;
    entry.window = {
      ...(ctx.windowProcess ? { processName: ctx.windowProcess } : {}),
      ...(titleRegex ? { titleRegex } : {}),
    };
  }

  if (action === 'wait_until') {
    const cond = args.condition;
    if (!cond || typeof cond !== 'object') return null;
    const c = { ...(cond as Record<string, unknown>) };
    if (typeof c.ref === 'string') {
      const known = ctx.lookupRef?.(c.ref);
      if (!known) return null;
      delete c.ref;
      c.selector_text = `${known.role}:${JSON.stringify(known.name)}`;
    }
    out.condition = c;
  }

  return entry;
}

/** 本步是否改变了界面:wait/wait_until 的"重截屏"只是观察,不算。 */
export function outputIndicatesChange(action: string, output: string): boolean {
  if (action === 'wait' || action === 'wait_until') return false;
  return output.includes('Screen re-captured');
}

// ── 存储 ────────────────────────────────────────────────────────────────

export function traceEnabled(): boolean {
  const v = (process.env.MOCODE_FLOW_TRACE ?? '').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

export function getTraceFilePath(sessionId = getCurrentSessionId()): string | null {
  if (!sessionId) return null;
  const root = getSandboxRoot() ?? process.cwd();
  return path.join(root, '.mocode', 'sessions', sessionId, TRACE_FILENAME);
}

/** 读整个 trace;文件缺失/坏行一律跳过。 */
export function readTrace(sessionId = getCurrentSessionId()): TraceEntry[] {
  const file = getTraceFilePath(sessionId);
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: TraceEntry[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as TraceEntry;
      if (e && typeof e.seq === 'number' && typeof e.action === 'string' && e.args && typeof e.args === 'object') {
        out.push(e);
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/** 下一个序号 = 现有最大 seq + 1(无文件为 1)。 */
export function nextTraceSeq(sessionId = getCurrentSessionId()): number {
  let max = 0;
  for (const e of readTrace(sessionId)) if (e.seq > max) max = e.seq;
  return max + 1;
}

/** 追加一条;失败静默,返回是否写入成功。 */
export function appendTrace(entry: TraceEntry, sessionId = getCurrentSessionId()): boolean {
  const file = getTraceFilePath(sessionId);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── 回放期间暂停录制 ─────────────────────────────────────────────────────

let suspendDepth = 0;

export function isTraceSuspended(): boolean {
  return suspendDepth > 0;
}

/** 回放 flow 时包住执行:回放产生的动作不应再被当作"新录制"污染 trace。 */
export async function withTraceSuspended<T>(fn: () => Promise<T>): Promise<T> {
  suspendDepth += 1;
  try {
    return await fn();
  } finally {
    suspendDepth -= 1;
  }
}

/** flow 文件校验用:某动作在 trace/flow 里允许携带的 computer 参数名。 */
export function recordedArgKeys(action: string): readonly string[] {
  return KEEP_ARGS[action] ?? [];
}
