import { stdin } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, truncateDisplay } from './render.js';
import * as layout from './layout.js';
import * as mouse from './mouse.js';
import { fuzzyRank } from './fuzzy.js';
import { t } from '../i18n/index.js';

/**
 * 历史模糊搜索面板(Ctrl+R / Ctrl+P):输入框即过滤词,菜单列出匹配的历史 query。
 *
 * 交互契约(与"防误发"目标一致):
 *  - Enter         只把选中项**填回输入框**,不发送 —— 用户可以改完再发。
 *  - Ctrl+Enter    填入并直接发送(确定要原样重发时用)。
 *  - Esc / Ctrl+C  取消,输入框保持原样(Ctrl+C 在输入框内是"取消"而非退出进程,
 *                  与 prompt.ts 里"有内容则清空"的分层语义不同,这里无内容可清)。
 *
 * 渲染骨架与 promptTurnPicker / promptRevertChoice 一致(raw mode + layout.paintInput 的 menu),
 * 区别只在输入框是可编辑的过滤词,而非静态提示行。
 */

export interface HistoryPickResult {
  /** 选中的历史原文(可能多行)。 */
  text: string;
  /** true = 调用方应立即提交,false = 只填回输入框。 */
  send: boolean;
}

export interface HistorySearchOpts {
  /** 候选原文,调用方已按"最近优先"排好(空 query 时保持这个顺序)。 */
  items: readonly string[];
  /** 初始过滤词;通常带入当前输入框已敲的字。 */
  initialQuery?: string;
}

/** 菜单里最多显示几条(带开窗滚动)。 */
const MAX_VISIBLE = 8;

/** emitKeypressEvents 后 stdin 会发 'keypress',但该事件不在 ReadStream 类型里,单独声明。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(event: 'keypress', listener: (str: string, key: Key) => void): this;
}

/** 多行 query 折叠成一行展示:首行 + 行数后缀。 */
function displayLine(text: string): string {
  const lines = text.split('\n');
  const extra = lines.length - 1;
  return extra > 0 ? `${lines[0] ?? ''}  (+${extra})` : (lines[0] ?? '');
}

export async function promptHistorySearch(opts: HistorySearchOpts): Promise<HistoryPickResult | null> {
  if (!layout.isActive()) return null;
  const items = opts.items.filter((s) => s.trim().length > 0);
  if (items.length === 0) return null;

  const emitter = stdin as unknown as KeypressEmitter;
  let query = opts.initialQuery ?? '';
  let cursor = query.length;
  let matches: string[] = [];
  let selected = 0;
  let menuTop = 0;
  let resolved = false;
  let resolve!: (v: HistoryPickResult | null) => void;

  function recompute(): void {
    matches = fuzzyRank(query, items).map((r) => r.text);
    if (selected >= matches.length) selected = Math.max(0, matches.length - 1);
    if (selected < 0) selected = 0;
    if (selected < menuTop) menuTop = selected;
  }

  function menuLines(): string[] {
    const cols = layout.getGeo().cols;
    const hint = `${ui.dim}${truncateDisplay(t('history.hint'), cols - 2)}${ui.reset}`;
    if (matches.length === 0) {
      return [hint, `${ui.dim}${truncateDisplay(t('history.empty'), cols - 2)}${ui.reset}`];
    }
    const visibleCount = Math.min(MAX_VISIBLE, matches.length);
    if (selected < menuTop) menuTop = selected;
    else if (selected >= menuTop + visibleCount) menuTop = selected - visibleCount + 1;
    const win = matches.slice(menuTop, menuTop + visibleCount);
    const hasMoreAbove = menuTop > 0;
    const hasMoreBelow = menuTop + visibleCount < matches.length;
    const rows = win.map((text, i) => {
      const idx = menuTop + i;
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      let scrollHint = '';
      if (i === 0 && hasMoreAbove) scrollHint = ' ▲';
      if (i === win.length - 1 && hasMoreBelow) scrollHint = ' ▼';
      const body = truncateDisplay(displayLine(text), cols - 4 - scrollHint.length);
      return `${marker} ${color}${body}${ui.reset}${ui.dim}${scrollHint}${ui.reset}`;
    });
    return [hint, ...rows];
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

  function cleanup(): void {
    layout.setMouseEnabled(true); // 输入框态是启用鼠标的(框选/右键粘贴)
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }

  function finish(value: HistoryPickResult | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;

    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      finish(null);
      return;
    }
    if (key.name === 'escape') {
      finish(null);
      return;
    }

    // Ctrl+J 也是「直接发送」:Ctrl+Enter 在部分终端发的是裸 \r(与 Enter 无从区分),
    // 给一个永远可靠的替代键。
    if (key.ctrl && key.name === 'j') {
      const p = matches[selected];
      finish(p ? { text: p, send: true } : null);
      return;
    }

    const isReturn = key.name === 'return' || key.name === 'enter';
    if (isReturn) {
      const picked = matches[selected];
      if (!picked) {
        finish(null); // 无匹配:什么都不改,回输入框
        return;
      }
      // Ctrl+Enter / Alt+Enter → 直接发送;裸 Enter → 只填回输入框
      finish({ text: picked, send: !!key.ctrl || !!key.meta });
      return;
    }

    switch (key.name) {
      case 'up':
        if (matches.length) selected = (selected - 1 + matches.length) % matches.length;
        redraw();
        return;
      case 'down':
        if (matches.length) selected = (selected + 1) % matches.length;
        redraw();
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
      query = query.slice(cursor);
      cursor = 0;
      recompute();
      redraw();
      return;
    }
    if (key.ctrl && (key.name === 'a' || key.name === 'q')) {
      cursor = 0;
      redraw();
      return;
    }
    if (key.ctrl && key.name === 'e') {
      cursor = query.length;
      redraw();
      return;
    }

    // 可打印字符(含中文;粘贴会逐字符到达,行为正确)
    const s = key.sequence ?? '';
    if (s && s >= ' ' && !key.ctrl && !key.meta) {
      query = query.slice(0, cursor) + s + query.slice(cursor);
      cursor += s.length;
      recompute();
      redraw();
    }
  }

  recompute();
  return new Promise<HistoryPickResult | null>((res) => {
    resolve = res;
    layout.setMouseEnabled(false); // 面板期间禁鼠标框选,防拖拽覆盖菜单
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
