/**
 * computer.list_windows / focus_window 的纯逻辑层(design-notes/computer-use-rpa.md §4)。
 *
 * 窗口枚举的原始数据来自 uia-service 的 `windows` op;过滤、编号(w1..wN)、norm1000 换算、
 * 按 ref / title_regex 选窗口都在这里,可用 fixture 离线单测,不碰 Win32。
 */
import { rectToNorm, type NormGeometry, type UiaRect } from './uia-selector.js';

/** list_windows 输出前缀;session/gui-actions.ts 靠它识别台账条目,改动须同步。 */
export const LIST_WINDOWS_OUTPUT_PREFIX = 'Windows (';

/** 最多展示的窗口数:桌面上几十个窗口再多对模型只是噪声。 */
export const LIST_WINDOWS_MAX = 40;

/** PowerShell `windows` op 返回的原始窗口(z-order 由前到后)。 */
export interface RawWindow {
  hwnd: number;
  title: string;
  processName: string;
  pid: number;
  /** 物理像素,虚拟桌面坐标;最小化时无意义。 */
  rect: UiaRect;
  minimized: boolean;
  foreground: boolean;
  /** WS_EX_TOOLWINDOW:浮动工具条/托盘弹层,不是用户心智里的"窗口"。 */
  toolWindow: boolean;
  /** DWM cloaked:其它虚拟桌面上的窗口 / 被挂起的 UWP 壳,可见标志为真但用户看不到。 */
  cloaked: boolean;
}

export interface WindowItem {
  /** 快照内短引用 w1..wN,仅在最近一次 list_windows 之后有效。 */
  ref: string;
  hwnd: number;
  title: string;
  processName: string;
  pid: number;
  rect: UiaRect;
  minimized: boolean;
  foreground: boolean;
  /** 窗口中心点是否落在主屏内(computer 的动作只作用于主屏)。 */
  onPrimary: boolean;
  /** 主屏 norm1000 [x, y, w, h];最小化或不在主屏时为 null。 */
  norm: [number, number, number, number] | null;
}

function toInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/** 解析 PowerShell 响应里的 windows 数组;字段缺失一律取保守默认值。 */
export function parseRawWindows(resp: Record<string, unknown>): RawWindow[] {
  const arr = Array.isArray(resp.windows) ? resp.windows : resp.windows ? [resp.windows] : [];
  const out: RawWindow[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const w = entry as Record<string, unknown>;
    const hwnd = toInt(w.hwnd);
    if (!hwnd) continue;
    const r = (w.rect && typeof w.rect === 'object' ? w.rect : {}) as Record<string, unknown>;
    out.push({
      hwnd,
      title: typeof w.title === 'string' ? w.title : '',
      processName: typeof w.processName === 'string' ? w.processName : '',
      pid: toInt(w.pid),
      rect: { x: toInt(r.x), y: toInt(r.y), w: Math.max(0, toInt(r.w)), h: Math.max(0, toInt(r.h)) },
      minimized: w.minimized === true,
      foreground: w.foreground === true,
      toolWindow: w.toolWindow === true,
      cloaked: w.cloaked === true,
    });
  }
  return out;
}

function onPrimaryScreen(rect: UiaRect, g: NormGeometry): boolean {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return cx >= g.originX && cx < g.originX + g.physW && cy >= g.originY && cy < g.originY + g.physH;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 过滤(空标题 / 工具窗口 / cloaked)→ 编号 → norm1000 换算 → 文本。
 * 保持原始 z-order(前 → 后),最多 LIST_WINDOWS_MAX 个。
 */
export function formatWindowList(
  raw: readonly RawWindow[],
  geometry: NormGeometry,
): { text: string; items: WindowItem[]; truncated: boolean } {
  const visible = raw.filter((w) => w.title.trim().length > 0 && !w.toolWindow && !w.cloaked);
  const truncated = visible.length > LIST_WINDOWS_MAX;
  const items: WindowItem[] = visible.slice(0, LIST_WINDOWS_MAX).map((w, i) => {
    const onPrimary = !w.minimized && onPrimaryScreen(w.rect, geometry);
    return {
      ref: `w${i + 1}`,
      hwnd: w.hwnd,
      title: w.title,
      processName: w.processName,
      pid: w.pid,
      rect: w.rect,
      minimized: w.minimized,
      foreground: w.foreground,
      onPrimary,
      norm: onPrimary ? rectToNorm(w.rect, geometry) : null,
    };
  });

  const lines: string[] = [
    `${LIST_WINDOWS_OUTPUT_PREFIX}${items.length}${truncated ? `, first ${LIST_WINDOWS_MAX} shown` : ''}, front to back). ` +
      'Rects are normalized 0-1000 [x, y, w, h] over the primary screen. ' +
      'Use focus_window with window: "wN" to bring one to the front; refs expire on the next list_windows.',
  ];
  if (items.length === 0) lines.push('(no top-level windows with a title)');
  for (const it of items) {
    const flags: string[] = [];
    if (it.foreground) flags.push('foreground');
    if (it.minimized) flags.push('minimized');
    else if (!it.onPrimary) flags.push('on secondary display');
    const proc = it.processName ? `${it.processName}.exe` : 'unknown';
    const rect = it.norm ? ` rect=[${it.norm.join(', ')}]` : '';
    const tag = flags.length ? ` (${flags.join(', ')})` : '';
    lines.push(`${it.ref} ${proc} ${JSON.stringify(clip(it.title, 80))}${rect}${tag}`);
  }
  return { text: lines.join('\n'), items, truncated };
}

export type PickResult = { ok: true; item: WindowItem } | { ok: false; error: string };

/**
 * 按 ref(w3)或 title_regex 选窗口。regex 命中多个视为歧义,返回错误并列出候选——
 * 宁可让模型再指定一次,也不替它在两个同名窗口里挑一个。
 */
export function pickWindow(items: readonly WindowItem[], sel: { ref?: string; titleRegex?: string }): PickResult {
  if (sel.ref !== undefined) {
    const item = items.find((i) => i.ref === sel.ref);
    if (!item) {
      return { ok: false, error: `window ${sel.ref} is not in the current window list; call list_windows again` };
    }
    return { ok: true, item };
  }
  if (sel.titleRegex === undefined) {
    return { ok: false, error: 'a window selector (window: "wN" or title_regex) is required' };
  }
  let re: RegExp;
  try {
    re = new RegExp(sel.titleRegex, 'i');
  } catch {
    return { ok: false, error: `title_regex is not a valid regular expression: ${sel.titleRegex}` };
  }
  const hits = items.filter((i) => re.test(i.title));
  if (hits.length === 0) {
    return { ok: false, error: `no window title matches /${sel.titleRegex}/i; call list_windows to see what is open` };
  }
  if (hits.length > 1) {
    const names = hits.map((h) => `${h.ref} ${JSON.stringify(clip(h.title, 50))}`).join(', ');
    return {
      ok: false,
      error: `title_regex /${sel.titleRegex}/i is ambiguous (${hits.length} windows: ${names}); use window: "wN" or a narrower regex`,
    };
  }
  return { ok: true, item: hits[0] };
}

/**
 * flow 回放用:按进程名(+可选标题正则)在原始窗口里选唯一目标。
 * 与 pickWindow 的区别:不依赖 wN 快照;同进程多窗口时,只在恰有一个前台窗口时取前台,否则报歧义。
 */
export function pickWindowForReplay(
  raw: readonly RawWindow[],
  sel: { processName?: string; titleRegex?: string },
): { ok: true; window: RawWindow } | { ok: false; error: string } {
  let re: RegExp | undefined;
  if (sel.titleRegex !== undefined) {
    try {
      re = new RegExp(sel.titleRegex, 'i');
    } catch {
      return { ok: false, error: `window titleRegex is not a valid regular expression: ${sel.titleRegex}` };
    }
  }
  const proc = sel.processName?.toLowerCase();
  const label = [sel.processName ? `${sel.processName}.exe` : undefined, re ? `title /${sel.titleRegex}/i` : undefined]
    .filter(Boolean)
    .join(' ');
  const hits = raw.filter(
    (w) =>
      w.title.trim().length > 0 &&
      !w.toolWindow &&
      !w.cloaked &&
      (proc === undefined || w.processName.toLowerCase() === proc) &&
      (!re || re.test(w.title)),
  );
  if (hits.length === 0) return { ok: false, error: `no open window matches ${label || '(any)'}` };
  if (hits.length === 1) return { ok: true, window: hits[0] };
  const foreground = hits.filter((w) => w.foreground);
  if (foreground.length === 1) return { ok: true, window: foreground[0] };
  const names = hits.map((h) => JSON.stringify(clip(h.title, 40))).join(', ');
  return {
    ok: false,
    error: `${hits.length} windows match ${label || '(any)'} and none is uniquely in front: ${names}`,
  };
}
