import readline from 'node:readline';
import { stdin, stderr } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, truncateDisplay, visColToCharCol, wrapByDisplayWidth } from './render.js';
import * as layout from './layout.js';
import * as mouse from './mouse.js';
import { Spinner } from './spinner.js';

/**
 * 介入面板:agent 执行中遇到需要用户决策的岔路时,弹问题 + 选项让用户选择(ask_human 工具调用)。
 * 用户可挑预设选项,也可选"自定义输入"自由作答。
 *
 * 渲染复用 promptTurnPicker 的模式(layout.paintInput:菜单向上展开进内容区底、提示/输入放底栏),
 * 不碰固定边框、不用 DECSC/DECRC、逐行 \x1B[2K 擦除(符合 TUI 不变量)。
 *
 * 两个冲突由本函数自行处理(因 ask_human 在 executeTool 内被调,此时 agent 处 RUNNING 态):
 *  1. spinner 在转(agent 在 await executeTool 前调了 spinner.start('执行 ask_human'),onFrame 每 80ms
 *     paintLiveAtCursor 画帧会覆盖面板)→ 进入前 Spinner.pauseCurrent() 停转。
 *  2. repl 的 onRunningKey 在整个 runAgent 期间已挂载(↑/↓ 当滚动、Ctrl+C 当中断、可打印键当 typeahead
 *     回显)→ 快照并摘掉现有 keypress 监听、挂自己的 onKey,退出 finally 按原序恢复。
 * 滚轮:面板内滚轮只滚动查看 agent 输出内容(↑↓ 才选菜单),与 onRunningKey 一致;菜单经 scrollBy 末尾
 * repaint()→paintInput(lastView) 重画,不被 viewport 滚动覆盖。进入时 resetScroll 回尾,退出时若滚过再回尾。
 * 退出时 paintInput(dim,menu:null) 擦菜单 + 复位 lastMenuRows,再 resetScroll(面板内滚过)/repaintViewport
 * 从缓冲重画内容区(恢复被菜单覆盖的 ● ask_human 行);顺序不可反——反了 stale lastMenuRows 会擦掉已恢复的内容。
 *
 * 非 TTY(管道/CI):不弹面板,choice 自动选第一项、input 返回 seed/空,打一行 stderr 日志,不阻塞。
 */

export type InterventionType = 'choice' | 'input';

/** choice 单个选项:label 是选项本身(选中后回传的值),detail 是选它意味着什么/取舍(可选,渲染时与 label 同行、用全角括号()包裹)。 */
export interface ChoiceOption {
  label: string;
  detail?: string;
}

export interface InterventionRequest {
  type: InterventionType;
  /** 问题/标题,显示在面板顶部。 */
  title: string;
  /** choice 的选项列表(2~6 个);为空则降级 input。纯字符串 = 无说明,等价 {label}。 */
  options?: Array<string | ChoiceOption>;
  /** 背景说明,显示在标题下(可多行)。 */
  detail?: string;
  /** input 模式预填文本。 */
  seed?: string;
  /** choice 末尾是否追加「其他(自定义输入)」项。默认 true;只有调用方确实想关掉才传 false。 */
  allowCustom?: boolean;
}

export interface InterventionResult {
  /** selected=选中某选项;submitted=提交自定义文本;cancelled=用户取消(Esc/Ctrl+C)。 */
  action: 'selected' | 'submitted' | 'cancelled';
  /** selected=选项文本;submitted=输入文本;cancelled 时无。 */
  value?: string;
}

/** emitKeypressEvents 后 stdin 发 'keypress'(不在 ReadStream 类型里),单独声明。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(
    event: 'keypress',
    listener: (str: string, key: Key) => void
  ): this;
  listeners(event: 'keypress'): Array<(str: string, key: Key) => void>;
}

const emitter = stdin as unknown as KeypressEmitter;

/** choice 末尾的"自定义输入"项标签(纯 ASCII,宽度安全)。选中后切到 input 子态。 */
const CUSTOM_LABEL = '其他(自定义输入)';

/** 弹出介入面板,阻塞直到用户完成选择。 */
export async function promptIntervention(
  req: InterventionRequest
): Promise<InterventionResult> {
  // 非 TTY 降级:不阻塞,自动选默认。日志走 stderr(不污染 stdout 内容流)。
  if (!layout.isActive()) {
    const kind =
      req.type === 'choice' ? '自动选默认项' : '自动返回空输入';
    stderr.write(`[介入] ${req.title}(非交互环境,${kind})\n`);
    if (req.type === 'choice') {
      const first = req.options?.[0];
      const value = typeof first === 'string' ? first : first?.label ?? '';
      return { action: 'selected', value };
    }
    return { action: 'submitted', value: req.seed ?? '' };
  }

  const options: ChoiceOption[] =
    req.type === 'choice' && Array.isArray(req.options)
      ? req.options
          .map((o): ChoiceOption =>
            typeof o === 'string' ? { label: o } : { label: String(o.label ?? ''), detail: o.detail }
          )
          .filter((o) => o.label.length > 0)
      : [];
  // choice 但选项被滤空 → 降级 input(对齐设计文档 §8:ask_human 选项为空数组→input)。
  const startMode: InterventionType =
    req.type === 'choice' && options.length > 0 ? 'choice' : 'input';

  let mode: InterventionType = startMode;
  // choice:选中下标(0..options.length-1 为各选项,options.length 为"自定义"项)。
  let selected = 0;
  // input:可编辑文本 + 光标(UTF-16 码元索引;显示位置由 displayWidth 算,见 paintInput)。
  let text = req.seed ?? '';
  let cursor = text.length;
  // input 是否由 choice 的"自定义"项切入(决定 Esc 是返回 choice 还是取消)。
  let cameFromChoice = false;

  let resolved = false;
  let resolve!: (v: InterventionResult) => void;
  // 挂自己监听前快照的现有 keypress 监听(运行态即 onRunningKey),退出时按原序恢复。
  let savedListeners: Array<(str: string, key: Key) => void> = [];

  /** choice 菜单行:标题(bold)+ 背景 detail(dim,行数上限保选项可见)+ 空行 + 选项(▸ label,有 detail 的项用全角括号()拼到 label 同行)。 */
  function menuLinesChoice(): string[] {
    const g = layout.getGeo();
    const cols = g.cols;
    const allowCustom = req.allowCustom !== false;
    const items: ChoiceOption[] = allowCustom ? [...options, { label: CUSTOM_LABEL }] : [...options];
    const optionCount = items.length;
    // 每项占行数 = label + （detail）整体 wrap 到可用宽度后的实际行数(超长换行,不再省略)。
    // 短 label 仍只占 1 行;长 detail 自然占用多行,菜单总高度随之动态增长。
    const rowsFor = (o: ChoiceOption): number => {
      const prefixWidth = 2 + (optionCount <= 9 ? 3 : 4); // 保守:覆盖 1. 与 10. 两种前缀
      const text = o.label + (o.detail ? `（${o.detail}）` : '');
      return Math.max(1, wrapByDisplayWidth(text, Math.max(1, cols - prefixWidth)).length);
    };
    const totalOptionRows = items.reduce((n, o) => n + rowsFor(o), 0);
    // detail 上限:title(1)+detail(D)+空行(1)+options(totalOptionRows) ≤ contentBottom
    const detailCap = Math.max(0, g.contentBottom - 2 - totalOptionRows);
    const lines: string[] = [];
    lines.push(`${ui.bold}${truncateDisplay(req.title, cols)}${ui.reset}`);
    if (req.detail) {
      const dl = req.detail.split('\n');
      const shown = dl.slice(0, detailCap);
      for (const d of shown) {
        lines.push(`${ui.dim}${truncateDisplay(d, cols)}${ui.reset}`);
      }
      if (dl.length > detailCap) lines.push(`${ui.dim}…${ui.reset}`);
    }
    lines.push(''); // 分隔空行
    // 选项开窗:超屏高时以 selected 为中心收选中项可见。
    const maxOptRows = Math.max(1, g.contentBottom - lines.length);
    let start = 0;
    {
      let acc = 0;
      let s = 0;
      for (let i = 0; i <= selected && i < optionCount; i++) acc += rowsFor(items[i]);
      while (acc > maxOptRows && s < selected) {
        acc -= rowsFor(items[s]);
        s++;
      }
      start = s;
    }
    let used = 0;
    let idx = start;
    while (idx < optionCount) {
      const o = items[idx];
      const rows = rowsFor(o);
      if (used + rows > maxOptRows && idx > start) break;
      // 选中项:▸ 与正文均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      // 数字前缀:只标真实选项(1-9,与 onKeyChoice 的数字直选对应);"自定义"项不占号。
      const numStr = idx < options.length ? `${idx + 1}. ` : '';
      const prefixWidth = 2 + numStr.length; // marker(1)+空格(1)+numStr
      // 有 detail 的项:把说明拼到 label 后面、用全角括号()包裹;按可用宽度 wrap 多行(超长换行不再省略)。
      // 第 1 行画 marker+numStr,后续行只画占位空白(prefixWidth)使 label 视觉上悬挂缩进、保持对齐。
      // 颜色随 label 走(选中 cyan+bold、未选 dim),保持多行视觉整体性。
      const detailSuffix = o.detail ? `（${o.detail}）` : '';
      const fullText = o.label + detailSuffix;
      const wrapped = wrapByDisplayWidth(fullText, Math.max(1, cols - prefixWidth));
      const pad = ' '.repeat(prefixWidth);
      for (let li = 0; li < wrapped.length; li++) {
        const prefix = li === 0 ? `${marker} ${numStr}` : pad;
        lines.push(`${prefix}${color}${wrapped[li]}${ui.reset}`);
      }
      used += rows;
      idx++;
    }
    return lines;
  }

  /** input 菜单行:标题(bold)+ detail(dim)+ 提示行(dim)。可编辑文本在底栏输入框。 */
  function menuLinesInput(): string[] {
    const g = layout.getGeo();
    const cols = g.cols;
    const detailCap = Math.max(0, g.contentBottom - 2); // title(1)+提示(1)
    const lines: string[] = [];
    lines.push(`${ui.bold}${truncateDisplay(req.title, cols)}${ui.reset}`);
    if (req.detail) {
      const dl = req.detail.split('\n');
      const shown = dl.slice(0, detailCap);
      for (const d of shown) {
        lines.push(`${ui.dim}${truncateDisplay(d, cols)}${ui.reset}`);
      }
      if (dl.length > detailCap) lines.push(`${ui.dim}…${ui.reset}`);
    }
    lines.push(
      `${ui.dim}Enter 提交 · Esc ${cameFromChoice ? '返回选项' : '取消'} · Ctrl+C 取消${ui.reset}`
    );
    return lines;
  }

  /** 鼠标左键点击输入框 → 把 cursor 移到点击位置(与 prompt.ts 的 applyExternalCursor 同源逻辑)。
   *  intervention 的 input 只有一行 text(无 chip / 多行),算法简化:flatIdx=0,段内 visCol → charCol。 */
  function applyExternalCursor(_flatIdx: number, inSegVis: number): void {
    if (mode !== 'input') return; // choice 模式下点击输入框不移动光标(无文本可定位)
    // 把屏幕 visCol 映射到 text 的字符偏移:wrapByDisplayWidth 复刻 paintInput 的折行,
    // visColToCharCol 把显示列反推到字符索引(处理 CJK 全角字符)。
    const g = layout.getGeo();
    const promptW = displayWidth('❯ ');
    const W = Math.max(1, g.cols - promptW);
    const segs = wrapByDisplayWidth(text, W);
    // _flatIdx 由 layout 端算出(点击落在哪段),这里用它定位段;越界兜底末段。
    const seg = segs[Math.min(_flatIdx, segs.length - 1)] ?? '';
    const inChar = visColToCharCol(seg, inSegVis);
    // 累加前面段的字符数 → text 中的绝对偏移。
    let offset = 0;
    for (let i = 0; i < Math.min(_flatIdx, segs.length); i++) offset += segs[i].length;
    offset += inChar;
    cursor = Math.max(0, Math.min(offset, text.length));
    redraw();
  }

  function redraw(): void {
    if (mode === 'choice') {
      const hint = '↑↓ 选择 · Enter 确认 · 数字键直选 · Esc 取消';
      layout.paintInput({
        prompt: '❯ ',
        lines: [hint],
        cursorLine: 0,
        cursorCol: displayWidth(hint),
        menu: { lines: menuLinesChoice() },
      });
    } else {
      layout.paintInput({
        prompt: '❯ ',
        lines: [text],
        cursorLine: 0,
        cursorCol: displayWidth(text.slice(0, cursor)),
        menu: { lines: menuLinesInput() },
      });
    }
  }

  function finish(result: InterventionResult): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(result);
  }

  /** 退出:摘自己的监听 + 恢复快照监听 + 擦菜单恢复内容区。不 setRawMode(false)/pause stdin(运行态由 repl 接管)。 */
  function cleanup(): void {
    layout.setMouseEnabled(true); // 恢复鼠标框选(面板期间禁,防拖拽覆盖菜单)
    layout.setCursorChangeHandler(null); // 注销光标变更处理器
    emitter.removeListener('keypress', onKey);
    for (const l of savedListeners) emitter.on('keypress', l);
    savedListeners = [];
    // 先 paintInput(dim,menu:null):擦菜单(用 lastMenuRows)+ 画 dim 占位底栏 + 复位 lastMenuRows=0;
    // 再处理滚动:面板内可能滚过滚轮(scrollOffset>0)→ resetScroll 回尾让 agent 后续输出可见;
    //   未滚则 repaintViewport 从 content 缓冲重画内容区(恢复被菜单覆盖的 ● ask_human 行)。
    // 顺序不可反——resetScroll/repaintViewport 在菜单还在(lastMenuRows>0)时会用内容覆盖菜单区,擦不掉菜单。
    layout.paintInput({
      prompt: '❯ ',
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
      dim: true,
    });
    if (layout.isScrolled()) layout.resetScroll();
    else layout.repaintViewport();
    // 恢复走时计时器(RUNNING 态):面板期间 stopTurnTimer 停了心跳,退出后恢复状态行 200ms 刷新。
    layout.startTurnTimerIfRunning();
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    // 鼠标 fragment:滚轮走 handleMouseEvent(mouseEnabled=true 时仍可滚动查看内容,与之前行为一致);
    // 框选/拖拽在面板期间被 layout.setMouseEnabled(false) 挡掉(防 viewport 重画覆盖菜单)。
    if (mouse.swallow(key.sequence ?? '')) return;
    // Ctrl+C → 取消(不 reject SIGINT——否则经 executeTool 的 try/catch 变成 tool 错误串)
    if (key.ctrl && key.name === 'c') {
      finish({ action: 'cancelled' });
      return;
    }
    if (key.name === 'escape') {
      if (mode === 'input' && cameFromChoice) {
        // 由 choice"自定义"项切入的 input:Esc 返回选项(不取消整次提问)
        mode = 'choice';
        redraw();
        return;
      }
      finish({ action: 'cancelled' });
      return;
    }
    // PgUp/PgDn:翻页滚动查看 agent 输出内容(与 onRunningKey/prompt.ts 一致;↑↓ 仍归菜单导航,不抢)。
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const pageH = layout.getGeo().contentBottom;
      layout.scrollBy(key.name === 'pageup' ? pageH : -pageH);
      return;
    }
    if (mode === 'choice') {
      onKeyChoice(key);
    } else {
      onKeyInput(key);
    }
  }

  function onKeyChoice(key: Key): void {
    const allowCustom = req.allowCustom !== false;
    const itemCount = allowCustom ? options.length + 1 : options.length;
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + itemCount) % itemCount;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % itemCount;
        redraw();
        return;
      case 'return':
      case 'enter':
        if (allowCustom && selected === options.length) {
          // 自定义项 → 切 input 子态(空文本起)
          mode = 'input';
          cameFromChoice = true;
          text = '';
          cursor = 0;
          redraw();
        } else {
          finish({ action: 'selected', value: options[selected]?.label });
        }
        return;
    }
    // 数字键 1-9 直选对应选项(自定义项不绑定数字)
    const s = key.sequence ?? '';
    if (s >= '1' && s <= '9') {
      const n = Number(s) - 1;
      if (n < options.length) {
        finish({ action: 'selected', value: options[n].label });
      }
    }
  }

  function onKeyInput(key: Key): void {
    if (key.name === 'return' || key.name === 'enter') {
      finish({ action: 'submitted', value: text });
      return;
    }
    if (key.ctrl && key.name === 'a') {
      cursor = 0;
      redraw();
      return;
    }
    if (key.ctrl && key.name === 'e') {
      cursor = text.length;
      redraw();
      return;
    }
    switch (key.name) {
      case 'backspace':
        if (cursor > 0) {
          text = text.slice(0, cursor - 1) + text.slice(cursor);
          cursor--;
          redraw();
        }
        return;
      case 'left':
        if (cursor > 0) {
          cursor--;
          redraw();
        }
        return;
      case 'right':
        if (cursor < text.length) {
          cursor++;
          redraw();
        }
        return;
      case 'home':
        cursor = 0;
        redraw();
        return;
      case 'end':
        cursor = text.length;
        redraw();
        return;
    }
    // 可打印字符(>= 空格,非 ctrl/meta)→ 插入光标处(\n < ' ' 自动排除,保单行)
    const s = key.sequence ?? '';
    if (s && s >= ' ' && !key.ctrl && !key.meta) {
      text = text.slice(0, cursor) + s + text.slice(cursor);
      cursor += s.length;
      redraw();
    }
  }

  return new Promise<InterventionResult>((res, rej) => {
    resolve = res;
    try {
      // 进入面板:停 spinner(避免 onFrame 覆盖)+ 停走时计时器(避免 drawStatusBar 200ms 心跳
      // 把真光标拉到 runningCaretPos 覆盖 paintInput 的正确光标位)+ 禁鼠标框选(防拖拽 viewport 重画覆盖菜单)+ 回尾(若用户正滚动回看)
      Spinner.pauseCurrent();
      layout.stopTurnTimer();
      layout.setMouseEnabled(false);
      layout.resetScroll();
      // 快照现有 keypress 监听(运行态的 onRunningKey)并摘掉,挂自己的 onKey
      savedListeners = emitter.listeners('keypress').slice();
      for (const l of savedListeners) emitter.removeListener('keypress', l);
      readline.emitKeypressEvents(stdin); // 幂等(运行态已挂解析器,防御性再调)
      // raw 模式:runAgent 期间 repl 已设 true;防御性确保(失败则按键不来,但不崩)
      try {
        stdin.setRawMode(true);
      } catch {
        // 非 TTY / 不支持:忽略(实际非 TTY 已在上方 isActive 守卫返回)
      }
      stdin.resume();
      emitter.on('keypress', onKey);
      layout.setCursorChangeHandler(applyExternalCursor); // 鼠标左键单击输入框 → 移光标到点击位
      redraw();
    } catch (e) {
      // 进入失败:必须恢复运行态监听,否则 onRunningKey 残留摘除 → 本 turns 的 Ctrl+C/滚动/typeahead 全废
      layout.setMouseEnabled(true);
      try {
        emitter.removeListener('keypress', onKey);
      } catch {
        // 忽略
      }
      for (const l of savedListeners) {
        try {
          emitter.on('keypress', l);
        } catch {
          // 忽略
        }
      }
      savedListeners = [];
      rej(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
