/**
 * 层级模糊选择器（#模型命令交互·两级浏览）。
 *
 * 一个按层级浏览的选择器（厂商 → 模型），搜索栏是**作用域内过滤**，不跨层：
 *  - 顶层（厂商列表）：打字只匹配**厂商名**，Enter 钻入选中厂商。
 *  - 进入厂商后：打字只匹配**该厂商下的模型名**，Enter 确认模型；Backspace 回厂商。
 * 不会把模型和厂商混在一个搜索结果里。
 *
 * 交互契约：
 *  - 可打印字符      追加到过滤词，实时过滤当前层级
 *  - ↑/↓            移动高亮（循环；跳过禁用项）
 *  - Enter          分支钻入 / 叶子确认
 *  - Backspace       编辑过滤词；词为空时退回上一层
 *  - Esc             先清过滤词 → 再退回上一层 → 顶层则取消
 *  - Ctrl+C          取消，返回 null
 *  - Ctrl+U          清空过滤词
 */
import { stdin } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, truncateDisplay } from './render.js';
import * as layout from './layout.js';
import { fuzzyMatch } from './fuzzy.js';

export interface HPNode<T> {
  /** 参与模糊匹配的文本（应只含本层语义：组名 / 模型名）。 */
  searchText: string;
  label: string;
  detail?: string;
  /** 叶子：确认时返回该值；与 children 互斥。 */
  value?: T;
  /** 分支：Enter 钻入。 */
  children?: ReadonlyArray<HPNode<T>>;
  disabled?: boolean;
}

export interface HierarchicalPickerOpts<T> {
  /** root 标题；进入子层后自动以「标题 › 组名 › …」拼接面包屑。 */
  title: string;
  roots: ReadonlyArray<HPNode<T>>;
  maxVisible?: number;
}

/** 拍平后的一个节点：携带从 root 到自身的下标路径与祖先链标签（树工具，供需要处使用）。 */
export interface FlatHit<T> {
  node: HPNode<T>;
  path: number[];
  crumb: string;
}

/** 深度优先拍平整棵树（含分支与叶子）。纯函数，导出供单测/外部复用。 */
export function flattenTree<T>(roots: ReadonlyArray<HPNode<T>>): FlatHit<T>[] {
  const out: FlatHit<T>[] = [];
  const walk = (nodes: ReadonlyArray<HPNode<T>>, path: number[], ancestorLabels: string[]): void => {
    nodes.forEach((node, i) => {
      const here = [...path, i];
      out.push({ node, path: here, crumb: ancestorLabels.join(' › ') });
      if (node.children && node.children.length) {
        walk(node.children, here, [...ancestorLabels, node.label]);
      }
    });
  };
  walk(roots, [], []);
  return out;
}

/** 内部统一候选：当前层级中的一个可选项。 */
interface Cand<T> {
  node: HPNode<T>;
  score: number;
  value?: T;
  /** 分支要钻入的绝对路径。 */
  enterPath?: number[];
}

interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(event: 'keypress', listener: (str: string, key: Key) => void): this;
}

export async function promptHierarchicalPicker<T>(opts: HierarchicalPickerOpts<T>): Promise<T | null> {
  if (!layout.isActive()) return null;
  const maxVisible = opts.maxVisible ?? 12;
  const emitter = stdin as unknown as KeypressEmitter;

  let query = '';
  let cursor = 0;
  let path: number[] = [];
  let cands: Cand<T>[] = [];
  let selected = 0;
  let resolved = false;
  let resolve!: (v: T | null) => void;

  /** 沿 path 取当前层级节点列表。 */
  function currentNodes(): ReadonlyArray<HPNode<T>> {
    let nodes: ReadonlyArray<HPNode<T>> = opts.roots;
    for (const idx of path) {
      const next = nodes[idx]?.children;
      if (!next) return [];
      nodes = next;
    }
    return nodes;
  }

  function enabledIndices(): number[] {
    const out: number[] = [];
    cands.forEach((c, i) => {
      if (!c.node.disabled) out.push(i);
    });
    return out;
  }

  function clampSelected(): void {
    const en = enabledIndices();
    if (en.length === 0) {
      selected = 0;
      return;
    }
    if (!en.includes(selected)) selected = en[0];
  }

  /** 只过滤当前层级：空 query 全显示；有 query 在本层节点 searchText 上模糊匹配。 */
  function recompute(): void {
    const q = query.trim();
    const enabled: Cand<T>[] = [];
    const disabled: Cand<T>[] = [];
    currentNodes().forEach((node, i) => {
      let m: { score: number } | null = { score: 0 };
      if (q) {
        m = fuzzyMatch(q, node.searchText);
        if (!m) return;
      }
      const c: Cand<T> = { node, score: m.score };
      if (node.children && node.children.length) c.enterPath = [...path, i];
      else c.value = node.value;
      (node.disabled ? disabled : enabled).push(c);
    });
    if (q) enabled.sort((a, b) => b.score - a.score);
    cands = [...enabled, ...disabled];
    clampSelected();
  }

  function titleLine(): string {
    const parts = [opts.title];
    let nodes: ReadonlyArray<HPNode<T>> = opts.roots;
    for (const idx of path) {
      parts.push(nodes[idx]?.label ?? '');
      nodes = nodes[idx]?.children ?? [];
    }
    return parts.join('  ›  ');
  }

  /** 随层级变化的操作提示。 */
  function hintLine(): string {
    return path.length === 0
      ? '打字搜索厂商 · ↑↓ 选择 · Enter 进入厂商 · Esc 退出'
      : '打字搜索模型 · ↑↓ 选择 · Enter 确认 · Backspace 返回厂商列表';
  }

  function menuLines(): string[] {
    const cols = layout.getGeo().cols;
    const lines: string[] = [`${ui.bold}${truncateDisplay(titleLine(), cols)}${ui.reset}`];
    lines.push(`${ui.dim}${truncateDisplay(hintLine(), cols)}${ui.reset}`);

    const en = enabledIndices();
    if (en.length === 0) {
      lines.push(`${ui.dim}${query.trim() ? '无匹配，按 Esc 返回' : '（空列表）'}${ui.reset}`);
      return lines;
    }

    const visibleCount = Math.min(maxVisible, en.length);
    const selPos = en.indexOf(selected);
    const page = Math.floor(selPos / visibleCount);
    const winEn = en.slice(page * visibleCount, page * visibleCount + visibleCount);
    const hasMore = page * visibleCount + visibleCount < en.length;
    const hasAbove = page > 0;

    winEn.forEach((idx, i) => {
      const c = cands[idx];
      const isSel = idx === selected;
      const isBranch = !!c.enterPath;
      const color = isSel ? `${ui.accent}${ui.bold}` : '';
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      let scrollHint = '';
      if (i === 0 && hasAbove) scrollHint = ' ▲';
      if (i === winEn.length - 1 && hasMore) scrollHint = ' ▼';
      // 分支尾部提示「进入」；叶子 detail 原样。
      const detail = [c.node.detail, isBranch ? '进入 →' : ''].filter(Boolean).join(' · ');
      const detailStr = detail ? `  ${ui.dim}${detail}${ui.reset}` : '';
      const budget = cols - 4 - scrollHint.length - (detail ? displayWidth(detail) + 2 : 0);
      const body = truncateDisplay(c.node.label, Math.max(1, budget));
      lines.push(`${marker} ${color}${body}${ui.reset}${detailStr}${ui.dim}${scrollHint}${ui.reset}`);
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

  function drill(to: number[]): void {
    path = to;
    query = '';
    cursor = 0;
    recompute();
    redraw();
  }

  function goUp(): boolean {
    if (path.length === 0) return false;
    path = path.slice(0, -1);
    recompute();
    redraw();
    return true;
  }

  function finish(v: T | null): void {
    if (resolved) return;
    resolved = true;
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      /* 忽略 */
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
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
    if (key.name === 'escape') {
      if (query) {
        query = '';
        cursor = 0;
        recompute();
        redraw();
        return;
      }
      if (goUp()) return;
      return finish(null);
    }
    if (key.ctrl && key.name === 'c') return finish(null);

    if (key.name === 'return' || key.name === 'enter') {
      const c = cands[selected];
      if (!c || c.node.disabled) return;
      if (c.enterPath) return drill(c.enterPath);
      if (c.value !== undefined) return finish(c.value);
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
        } else if (!query) {
          goUp();
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
