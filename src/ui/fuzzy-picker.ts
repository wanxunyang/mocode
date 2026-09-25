/**
 * 通用模糊选择器（#模型命令交互）。
 *
 * 把 history-picker 的「输入即过滤 + ↑↓ + Enter」骨架抽成泛型组件：候选是任意对象，
 * 由调用方提供 searchable 文本与渲染行。不绑定「历史/模型」语义，任何「从一大堆项里
 * 挑一个」的场景都能用。
 *
 * 交互契约：
 *  - 可打印字符      追加到过滤词，实时模糊过滤（fuzzy.ts）
 *  - ↑/↓            移动高亮（循环；只在可选项间移动）
 *  - Enter          确认当前高亮项
 *  - Esc / Ctrl+C   取消，返回 null
 *  - Backspace 等    常规行编辑；Ctrl+U 清行
 */
import { stdin } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, truncateDisplay } from './render.js';
import * as layout from './layout.js';
import { fuzzyMatch } from './fuzzy.js';

export interface FuzzyPickerItem<T> {
  value: T;
  /** 参与模糊匹配的文本。 */
  searchText: string;
  /** 列表里显示的主文本。 */
  label: string;
  /** label 同行右侧的次要信息（暗色），可选。 */
  detail?: string;
  /** true 时该项可见但不可选（跳过）。 */
  disabled?: boolean;
}

export interface FuzzyPickerOpts<T> {
  title: string;
  items: ReadonlyArray<FuzzyPickerItem<T>>;
  initialQuery?: string;
  /** 空过滤词时的提示副标题；有过滤但零结果时显示「无匹配」。 */
  hint?: string;
  /** 列表最多可见行数。 */
  maxVisible?: number;
}

interface Ranked<T> {
  item: FuzzyPickerItem<T>;
  score: number;
}

/** 纯函数：按 query 过滤+排序，禁用项沉底并保留（用于呈现，不参与选择）。导出供单测。 */
export function filterItems<T>(query: string, items: ReadonlyArray<FuzzyPickerItem<T>>): Ranked<T>[] {
  const q = query.trim();
  const enabled: Ranked<T>[] = [];
  const disabled: Ranked<T>[] = [];
  for (const item of items) {
    if (!q) {
      (item.disabled ? disabled : enabled).push({ item, score: 0 });
      continue;
    }
    const m = fuzzyMatch(q, item.searchText);
    if (!m) continue;
    (item.disabled ? disabled : enabled).push({ item, score: m.score });
  }
  if (q) enabled.sort((a, b) => b.score - a.score);
  return [...enabled, ...disabled];
}

/** emitKeypressEvents 后 stdin 发 'keypress'，类型里没有，单独声明。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(event: 'keypress', listener: (str: string, key: Key) => void): this;
}

export async function promptFuzzyPicker<T>(opts: FuzzyPickerOpts<T>): Promise<T | null> {
  if (!layout.isActive()) return null;
  const maxVisible = opts.maxVisible ?? 10;
  const emitter = stdin as unknown as KeypressEmitter;

  let query = opts.initialQuery ?? '';
  let cursor = query.length;
  let matches: Ranked<T>[] = [];
  let selected = 0; // 在 matches 中的下标（可能落在禁用项，移动时跳过）
  let menuTop = 0;
  let resolved = false;
  let resolve!: (v: T | null) => void;

  /** 可选项（非禁用）下标集合。 */
  function enabledIndices(): number[] {
    const out: number[] = [];
    matches.forEach((r, i) => {
      if (!r.item.disabled) out.push(i);
    });
    return out;
  }

  function clampSelected(): void {
    const en = enabledIndices();
    if (en.length === 0) {
      selected = matches.length ? 0 : 0;
      return;
    }
    if (!en.includes(selected)) selected = en[0];
  }

  function recompute(): void {
    matches = filterItems(query, opts.items);
    clampSelected();
  }

  function menuLines(): string[] {
    const cols = layout.getGeo().cols;
    const lines: string[] = [`${ui.bold}${truncateDisplay(opts.title, cols)}${ui.reset}`];
    if (opts.hint) lines.push(`${ui.dim}${truncateDisplay(opts.hint, cols)}${ui.reset}`);

    const en = enabledIndices();
    if (en.length === 0) {
      lines.push(`${ui.dim}${query.trim() ? '无匹配，按 Esc 返回' : '（空列表）'}${ui.reset}`);
      return lines;
    }

    // 开窗：以 selected 为中心。
    const visibleCount = Math.min(maxVisible, en.length);
    const selPos = en.indexOf(selected);
    let page = Math.floor(selPos / visibleCount);
    const winEn = en.slice(page * visibleCount, page * visibleCount + visibleCount);
    menuTop = winEn[0];
    const hasMore = page * visibleCount + visibleCount < en.length;
    const hasAbove = page > 0;

    winEn.forEach((idx, i) => {
      const r = matches[idx];
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : '';
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      let scrollHint = '';
      if (i === 0 && hasAbove) scrollHint = ' ▲';
      if (i === winEn.length - 1 && hasMore) scrollHint = ' ▼';
      const detail = r.item.detail ? `  ${ui.dim}${r.item.detail}${ui.reset}` : '';
      const budget = cols - 4 - scrollHint.length - (r.item.detail ? displayWidth(r.item.detail) + 2 : 0);
      const body = truncateDisplay(r.item.label, Math.max(1, budget));
      lines.push(`${marker} ${color}${body}${ui.reset}${detail}${ui.dim}${scrollHint}${ui.reset}`);
    });
    return lines;
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [query],
      cursorLine: 0,
      cursorCol: displayWidth(query.slice(0, cursor)),
      menu: { lines: menuLines() },
    });
  }

  function finish(v: T | null): void {
    if (resolved) return;
    resolved = true;
    layout.setMouseEnabled(true); // 恢复输入框态鼠标(框选/右键粘贴)
    try {
      stdin.setRawMode(false);
    } catch {
      /* 忽略 */
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
    // 擦菜单区。
    layout.paintInput({ prompt: '❯ ', lines: [''], cursorLine: 0, cursorCol: 0, menu: null });
    resolve(v);
  }

  function move(delta: number): void {
    const en = enabledIndices();
    if (en.length === 0) return;
    const pos = en.indexOf(selected);
    const nextPos = (pos + delta + en.length) % en.length;
    selected = en[nextPos];
    redraw();
  }

  function onKey(_str: string, key: Key): void {
    if (key.name === 'escape') return finish(null);
    if (key.ctrl && key.name === 'c') return finish(null);

    if (key.name === 'return' || key.name === 'enter') {
      const r = matches[selected];
      if (r && !r.item.disabled) finish(r.item.value);
      return;
    }

    switch (key.name) {
      case 'up':
        move(-1);
        return;
      case 'down':
        move(1);
        return;
      case 'left':
        if (cursor > 0) {
          cursor--;
          redraw();
        }
        return;
      case 'right':
        if (cursor < query.length) {
          cursor++;
          redraw();
        }
        return;
      case 'home':
        cursor = 0;
        redraw();
        return;
      case 'end':
        cursor = query.length;
        redraw();
        return;
      case 'backspace':
        if (cursor > 0) {
          query = query.slice(0, cursor - 1) + query.slice(cursor);
          cursor--;
          recompute();
          redraw();
        }
        return;
      case 'delete':
        if (cursor < query.length) {
          query = query.slice(0, cursor) + query.slice(cursor + 1);
          recompute();
          redraw();
        }
        return;
    }

    if (key.ctrl && key.name === 'u') {
      query = '';
      cursor = 0;
      recompute();
      redraw();
      return;
    }

    const s = key.sequence ?? '';
    if (s && s >= ' ' && !key.ctrl && !key.meta) {
      query = query.slice(0, cursor) + s + query.slice(cursor);
      cursor += s.length;
      recompute();
      redraw();
    }
  }

  recompute();
  return new Promise<T | null>((res) => {
    resolve = res;
    layout.setMouseEnabled(false);
    try {
      stdin.setRawMode(true);
    } catch {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}
