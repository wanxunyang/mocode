/**
 * computer.wait_until 的纯逻辑层(design-notes/computer-use-rpa.md §3.1)。
 *
 * 条件解析、轮询状态机、type 输入方式选择都在这里;抓屏与元素存在性检查通过 WaitDeps 注入,
 * 因此可以用合成 PngImage 序列 + 假时钟离线单测,不碰屏幕/进程。
 */
import { diffRatio, type PngImage } from './screen-pipeline.js';
import type { UiaSelectorStep } from './uia-selector.js';

export const WAIT_UNTIL_DEFAULT_TIMEOUT_MS = 10000;
export const WAIT_UNTIL_MIN_TIMEOUT_MS = 500;
export const WAIT_UNTIL_MAX_TIMEOUT_MS = 30000;
export const WAIT_INTERVAL_MIN_MS = 200;
export const WAIT_INTERVAL_MAX_MS = 2000;
export const WAIT_INTERVAL_DEFAULT_MS = 400;
export const STABLE_FRAMES_MIN = 2;
export const STABLE_FRAMES_MAX = 5;

/** 等待目标元素:ref(当前 inspect 快照里的元素)或 selector_text 简写解析出的单步选择器。 */
export type ElementTarget = { ref: string } | { step: UiaSelectorStep; text: string };

export type WaitCondition =
  | { kind: 'stable'; frames: number; intervalMs: number; threshold: number }
  | { kind: 'changed'; intervalMs: number; threshold: number }
  | { kind: 'element_present'; intervalMs: number; target: ElementTarget }
  | { kind: 'element_absent'; intervalMs: number; target: ElementTarget };

export type ParsedCondition = { ok: true; condition: WaitCondition } | { ok: false; error: string };

const KINDS = ['stable', 'changed', 'element_present', 'element_absent'] as const;

/**
 * 解析 selector_text 简写:`Button:"确定"` 或仅 `"确定"`(不限 role)。
 * 引号内按 JSON 字符串转义解析(可写 \" ),失败则取原文。
 */
export function parseSelectorText(text: string): UiaSelectorStep | null {
  const m = /^\s*(?:([A-Za-z][A-Za-z0-9]*)\s*:\s*)?("(?:[^"\\]|\\.)*")\s*$/s.exec(text);
  if (!m) return null;
  let name: string;
  try {
    name = JSON.parse(m[2]) as string;
  } catch {
    name = m[2].slice(1, -1);
  }
  if (!name) return null;
  const step: UiaSelectorStep = { name };
  if (m[1]) step.role = m[1];
  return step;
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** 校验并规整 wait_until 的 condition 参数;defaultThreshold 为 computer.ts 的画面差分阈值。 */
export function parseWaitCondition(raw: unknown, defaultThreshold: number): ParsedCondition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `action "wait_until" requires condition: { kind: ${KINDS.join('|')}, ... }` };
  }
  const c = raw as Record<string, unknown>;
  const kind = c.kind;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `condition.kind must be one of: ${KINDS.join(', ')}` };
  }
  let intervalMs = WAIT_INTERVAL_DEFAULT_MS;
  if (c.interval_ms !== undefined) {
    if (!inRange(c.interval_ms, WAIT_INTERVAL_MIN_MS, WAIT_INTERVAL_MAX_MS)) {
      return {
        ok: false,
        error: `condition.interval_ms must be an integer in ${WAIT_INTERVAL_MIN_MS}-${WAIT_INTERVAL_MAX_MS}`,
      };
    }
    intervalMs = c.interval_ms;
  }
  let threshold = defaultThreshold;
  if (c.threshold !== undefined) {
    if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold) || c.threshold < 0 || c.threshold > 1) {
      return { ok: false, error: 'condition.threshold must be a number in 0-1' };
    }
    threshold = c.threshold;
  }
  if (kind === 'stable') {
    let frames = STABLE_FRAMES_MIN;
    if (c.frames !== undefined) {
      if (!inRange(c.frames, STABLE_FRAMES_MIN, STABLE_FRAMES_MAX)) {
        return { ok: false, error: `condition.frames must be an integer in ${STABLE_FRAMES_MIN}-${STABLE_FRAMES_MAX}` };
      }
      frames = c.frames;
    }
    return { ok: true, condition: { kind, frames, intervalMs, threshold } };
  }
  if (kind === 'changed') return { ok: true, condition: { kind, intervalMs, threshold } };

  // element_present / element_absent:ref 与 selector_text 二选一。
  const hasRef = c.ref !== undefined;
  const hasText = c.selector_text !== undefined;
  if (hasRef === hasText) {
    return { ok: false, error: `condition kind "${kind}" requires exactly one of ref or selector_text` };
  }
  if (hasRef) {
    if (typeof c.ref !== 'string' || !/^e\d+$/.test(c.ref)) {
      return { ok: false, error: 'condition.ref must look like "e12" (from the latest inspect)' };
    }
    return {
      ok: true,
      condition: { kind: kind as 'element_present' | 'element_absent', intervalMs, target: { ref: c.ref } },
    };
  }
  const text = typeof c.selector_text === 'string' ? c.selector_text : '';
  const step = parseSelectorText(text);
  if (!step) {
    return { ok: false, error: 'condition.selector_text must look like Button:"OK" or "OK" (quoted element name)' };
  }
  return {
    ok: true,
    condition: { kind: kind as 'element_present' | 'element_absent', intervalMs, target: { step, text: text.trim() } },
  };
}

/** 给台账/输出用的简短条件描述。 */
export function describeCondition(c: WaitCondition): string {
  if (c.kind === 'stable' || c.kind === 'changed') return c.kind;
  const t = 'ref' in c.target ? c.target.ref : c.target.text;
  return `${c.kind} ${t}`;
}

export interface WaitDeps {
  /** 抓一帧(已按 computer 的 maxEdge 缩放,保证同尺寸可比)。 */
  captureFrame(): Promise<PngImage>;
  /** 目标元素此刻是否存在(前台窗口内)。 */
  elementExists(target: ElementTarget): Promise<boolean>;
  /** changed 的比较基准(模型最近看到的帧);为空则以第一轮抓到的帧作基准。 */
  baseline?: PngImage | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

export interface WaitResult {
  outcome: 'met' | 'timeout' | 'aborted';
  elapsedMs: number;
  polls: number;
  /** 最近一次画面差异比例(仅 stable/changed)。 */
  lastDiff?: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 尺寸不同意味着显示配置变了——视为"变化"最安全(diff=1),而不是抛错中断等待。 */
function safeDiff(a: PngImage, b: PngImage): number {
  try {
    return diffRatio(a, b);
  } catch {
    return 1;
  }
}

/**
 * 轮询直到条件满足 / 超时 / abort。
 * stable:连续 `frames` 次相邻两帧 diff ≤ threshold;changed:相对基准 diff > threshold(互补判定)。
 */
export async function waitUntil(cond: WaitCondition, timeoutMs: number, deps: WaitDeps): Promise<WaitResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const start = now();
  let polls = 0;
  let lastDiff: number | undefined;
  let prev: PngImage | null = null;
  let base: PngImage | null = cond.kind === 'changed' ? (deps.baseline ?? null) : null;
  let stableRun = 0;
  const finish = (outcome: WaitResult['outcome']): WaitResult => ({
    outcome,
    elapsedMs: now() - start,
    polls,
    lastDiff,
  });

  for (;;) {
    if (deps.signal?.aborted) return finish('aborted');
    polls++;
    let met = false;
    if (cond.kind === 'stable') {
      const frame = await deps.captureFrame();
      if (prev) {
        lastDiff = safeDiff(prev, frame);
        stableRun = lastDiff <= cond.threshold ? stableRun + 1 : 0;
        met = stableRun >= cond.frames;
      }
      prev = frame;
    } else if (cond.kind === 'changed') {
      const frame = await deps.captureFrame();
      if (base) {
        lastDiff = safeDiff(base, frame);
        met = lastDiff > cond.threshold;
      } else {
        base = frame;
      }
    } else {
      const exists = await deps.elementExists(cond.target);
      met = cond.kind === 'element_present' ? exists : !exists;
    }
    if (deps.signal?.aborted) return finish('aborted');
    if (met) return finish('met');
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) return finish('timeout');
    await sleep(Math.min(cond.intervalMs, timeoutMs - elapsed), deps.signal);
  }
}

// ── type 输入方式 ──────────────────────────────────────────────────────

export type TypeMethod = 'keys' | 'paste';

/** 超过此长度的文本逐字 SendInput 太慢且易被 IME/自动补全打断,auto 时改走剪贴板。 */
export const PASTE_AUTO_MIN_LENGTH = 200;

/** method 缺省(auto)时:长文本或含换行用 paste,否则 keys;显式 method 原样返回。 */
export function pickTypeMethod(text: string, method?: TypeMethod): TypeMethod {
  if (method === 'keys' || method === 'paste') return method;
  return text.length > PASTE_AUTO_MIN_LENGTH || /[\r\n]/.test(text) ? 'paste' : 'keys';
}
