import readline from 'node:readline';
import { stdin } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from '../theme.js';
import { displayWidth, truncateDisplay } from '../render.js';
import * as layout from '../layout.js';
import * as mouse from '../mouse.js';
import { t } from '../../i18n/index.js';
import { ensurePasteDetector } from './paste.js';
import type { KeypressEmitter, SessionPickerItem } from './types.js';

/**
 * 轮次选择菜单(供 /rollback 菜单化选择):↑/↓ 导航、Enter 选中、Esc/Ctrl+D 取消。
 * 把 items 画成向上展开的菜单(经 layout.paintInput,与斜杠菜单同套渲染),输入框行作操作提示。
 * 返回选中的 0-based 下标;null=取消 / 非 TTY / 空列表。纯导航(不收文本输入)。
 * 长列表(超屏高)自动开窗保光标可见;默认聚焦末项(最新轮次,靠近输入框)。
 */
export async function promptTurnPicker(items: { firstLine: string }[]): Promise<number | null> {
  if (!layout.isActive() || items.length === 0) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  const hint = t('prompt.chooseRollback');
  let selected = items.length - 1; // 默认聚焦最新(末项,菜单底、靠近输入框)
  let resolved = false;
  let resolve!: (v: number | null) => void;
  let reject!: (e: Error) => void;

  /** 菜单行(带开窗):超屏高时以 selected 为中心取窗,保光标可见;末项在底(靠近输入框)。 */
  function menuLines(): string[] {
    const g = layout.getGeo();
    const maxRows = Math.max(1, g.contentBottom);
    let start = 0;
    if (items.length > maxRows) {
      start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), items.length - maxRows));
    }
    const count = Math.min(maxRows, items.length);
    const cols = g.cols;
    return Array.from({ length: count }, (_, i) => {
      const idx = start + i;
      // 选中项:▸/序号/正文均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = `${color}${idx + 1}${ui.reset}`;
      const text = truncateDisplay(items[idx].firstLine, cols - 6);
      return `${marker} ${num} ${color}${text}${ui.reset}`;
    });
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [hint],
      cursorLine: 0,
      cursorCol: displayWidth(hint),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true); // 恢复鼠标框选/滚轮(面板期间被禁,防拖拽覆盖菜单)
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: number | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return; // 鼠标 fragment 吞掉(框选已禁,滚轮 handleMouseEvent no-op)
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + items.length) % items.length;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % items.length;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(selected);
        return;
      case 'escape':
        finish(null);
        return;
    }
  }

  return new Promise<number | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false); // 面板期间禁鼠标框选/滚轮(防拖拽 viewport 重画覆盖菜单)
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}

/**
 * 会话选择菜单(供 /resume 菜单化选择):↑/↓ 导航、Enter 续接、Esc/Ctrl+D 取消、a 切换「仅最近 N / 全部」。
 * 把 items 画成向上展开的菜单(经 layout.paintInput,与斜杠菜单 / 轮次菜单同套渲染),输入框行作操作提示。
 * 默认仅显示最近 N 条(默认 N=10,取 items 前缀——调用方按 createdAt 降序传入则前缀=最新 N);
 * items 多于 N 时按 a 展开全部,再按 a 折回最近 N。选中项 cyan+bold + ▸ 高亮(同 promptTurnPicker)。
 * 返回选中的 item(含 id);null=取消 / 非 TTY / 空列表。纯导航(不收文本输入)。
 * 长列表(超屏高)自动开窗保光标可见;默认聚焦首项(最新会话,Enter 即续接最近一条)。
 */
export async function promptSessionPicker(
  items: SessionPickerItem[],
  recentCap = 10,
): Promise<SessionPickerItem | null> {
  if (!layout.isActive() || items.length === 0) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  const cap = Math.max(1, recentCap);
  const canToggle = items.length > cap; // 不超过 cap 时无切换意义(本就全显)
  let showAll = !canToggle; // 超过 cap 才默认折叠到最近 N,否则全显
  let selected = 0; // 默认聚焦首项(调用方降序传入 → 最新会话)
  let resolved = false;
  let resolve!: (v: SessionPickerItem | null) => void;
  let reject!: (e: Error) => void;

  /** 当前可见项:折叠态取前 cap 条(=最近 N),展开态取全部。 */
  function visible(): SessionPickerItem[] {
    return showAll ? items : items.slice(0, cap);
  }
  /** 输入框行的操作提示;折叠态显「a 全部(N)」,展开态显「a 仅最近N」。不超 cap 时无 a 项。 */
  function hint(): string {
    const base = t('prompt.chooseResume');
    if (!canToggle) return base;
    return showAll ? t('prompt.recent', { count: cap }) : t('prompt.all', { count: items.length });
  }

  /** 菜单行(带开窗):超屏高时以 selected 为中心取窗,保光标可见。行格式:▸ N  title  subtitle。 */
  function menuLines(): string[] {
    const g = layout.getGeo();
    const cols = g.cols;
    const maxRows = Math.max(1, g.contentBottom);
    const vis = visible();
    let start = 0;
    if (vis.length > maxRows) {
      start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), vis.length - maxRows));
    }
    const count = Math.min(maxRows, vis.length);
    return Array.from({ length: count }, (_, i) => {
      const idx = start + i;
      // 选中项:▸/序号/正文/副标题均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = String(idx + 1);
      const it = vis[idx];
      const title = it.title || '(无)';
      const sub = it.subtitle ?? '';
      const leadW = displayWidth(num) + 4; // "▸ " + num + "  "
      let subW = sub ? displayWidth(sub) + 2 : 0; // "  " + sub
      let titleW = cols - leadW - subW;
      if (titleW < 4 && sub) {
        // 太窄:先丢副标题把空间让给标题
        subW = 0;
        titleW = cols - leadW;
      }
      const titleT = titleW > 0 ? truncateDisplay(title, titleW) : '';
      const subPart = subW > 0 ? `  ${sub}` : '';
      return `${marker} ${color}${num}  ${titleT}${subPart}${ui.reset}`;
    });
  }

  function redraw(): void {
    const h = hint();
    layout.paintInput({
      prompt: '❯ ',
      lines: [h],
      cursorLine: 0,
      cursorCol: displayWidth(h),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: SessionPickerItem | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    // a 切换「仅最近 N / 全部」:纯导航菜单无文本输入,a 自由;key.name 不分大小写,Shift+A 亦触发。
    if (canToggle && key.name === 'a' && !key.ctrl && !key.meta) {
      showAll = !showAll;
      const vis = visible();
      if (selected > vis.length - 1) selected = vis.length - 1; // 折回 cap 时选中项越界则钳到末项
      redraw();
      return;
    }
    const n = visible().length;
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + n) % n;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % n;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(visible()[selected] ?? null);
        return;
      case 'escape':
        finish(null);
        return;
    }
  }

  return new Promise<SessionPickerItem | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false);
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}

/**
 * 主题选择菜单(供 /theme):↑/↓ 导航、Enter 切换、Esc/Ctrl+D 取消、Ctrl+C 抛 SIGINT(调用方 try/catch)。
 * 复用 SessionPickerItem 形状({id,title,subtitle?});选中项 cyan+bold + ▸ 高亮(同 /resume 菜单)。
 * 返回选中的 item(含 id);null=取消 / 非 TTY / 空列表。纯导航(不收文本输入)。
 * 长列表超屏高自动开窗保光标可见;默认聚焦首项。
 */
export async function promptThemePicker(items: SessionPickerItem[]): Promise<SessionPickerItem | null> {
  if (!layout.isActive() || items.length === 0) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  let selected = 0;
  let resolved = false;
  let resolve!: (v: SessionPickerItem | null) => void;
  let reject!: (e: Error) => void;

  const hint = t('prompt.chooseSwitch');

  /** 菜单行(带开窗):超屏高时以 selected 为中心取窗,保光标可见。行格式:▸ N  title  subtitle。 */
  function menuLines(): string[] {
    const g = layout.getGeo();
    const cols = g.cols;
    const maxRows = Math.max(1, g.contentBottom);
    let start = 0;
    if (items.length > maxRows) {
      start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), items.length - maxRows));
    }
    const count = Math.min(maxRows, items.length);
    return Array.from({ length: count }, (_, i) => {
      const idx = start + i;
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = String(idx + 1);
      const it = items[idx];
      const title = it.title || '(无)';
      const sub = it.subtitle ?? '';
      const leadW = displayWidth(num) + 4; // "▸ " + num + "  "
      let subW = sub ? displayWidth(sub) + 2 : 0; // "  " + sub
      let titleW = cols - leadW - subW;
      if (titleW < 4 && sub) {
        subW = 0;
        titleW = cols - leadW;
      }
      const titleT = titleW > 0 ? truncateDisplay(title, titleW) : '';
      const subPart = subW > 0 ? `  ${sub}` : '';
      return `${marker} ${color}${num}  ${titleT}${subPart}${ui.reset}`;
    });
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [hint],
      cursorLine: 0,
      cursorCol: displayWidth(hint),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: SessionPickerItem | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    const n = items.length;
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + n) % n;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % n;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(items[selected] ?? null);
        return;
      case 'escape':
        finish(null);
        return;
    }
  }

  return new Promise<SessionPickerItem | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false);
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}

/**
 * 回滚方式二选一菜单(供 /rollback 选完轮次后):↑/↓ 导航、Enter 确认、Esc/Ctrl+D 保留文件。
 * 两个选项:1=撤销文件改动(恢复到回滚前);2=只撤销消息,保留文件改动。
 * 复用轮次/会话菜单的渲染骨架(raw mode + layout.paintInput 的 menu),选中项 cyan+bold + ▸ 高亮。
 * 返回 true=撤销文件 / false=只撤销消息 / null=取消(调用方按 false=保留文件处理)。
 * 默认聚焦首项(撤销文件)。无文件改动时调用方不应调此菜单(直接走只撤销消息)。
 */
export async function promptRevertChoice(fileCount: number): Promise<boolean | null> {
  if (!layout.isActive()) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  const hint = t('prompt.keepFiles');
  const detail = fileCount > 0 ? t('prompt.revertDetail', { count: fileCount }) : '';
  const items = [t('prompt.revertFiles', { detail }), t('prompt.messagesOnly')];
  let selected = 0; // 默认聚焦首项(撤销文件)
  let resolved = false;
  let resolve!: (v: boolean | null) => void;
  let reject!: (e: Error) => void;

  function menuLines(): string[] {
    const cols = layout.getGeo().cols;
    return items.map((text, idx) => {
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = `${color}${idx + 1}${ui.reset}`;
      const t = truncateDisplay(text, cols - 6);
      return `${marker} ${num} ${color}${t}${ui.reset}`;
    });
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [hint],
      cursorLine: 0,
      cursorCol: displayWidth(hint),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: boolean | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + items.length) % items.length;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % items.length;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(selected === 0); // true=撤销文件, false=只撤销消息
        return;
      case 'escape':
        finish(null); // 取消=保留文件
        return;
    }
  }

  return new Promise<boolean | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false);
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}
