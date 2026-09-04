// 顶层编排 + 桶文件。
//
// 显式 re-export 各分层模块的公开 API,对外仍是 ../layout.js 的 `export *`(名单一字不变)。
// 这里不用 `export *`:那会把「为跨文件引用而提升 export 的内部实现」一并公开
// (cup / esc / normalizeSelection / SEL_OPEN 等),污染对外 API。
//
// 本文件只留「必须站在所有子系统之上」的部分:
//   - alt screen 生命周期:enterAltScreen / exitAltScreen
//   - 模式切换:enterInputMode / enterRunningMode / setUserActive
//   - 鼠标事件入口:handleMouseEvent 及 handler 注册——最大消费者,
//     跨 content-write / scroll / input-paint / selection 四层,只能待在顶层
//   - 裸 console 劫持:routeConsoleToContent → contentWrite
//
// 分层依赖(严格 DAG,零循环 import):
//   screen → selection / statusbar → input-paint → scroll → content-write → 本文件
// 可变运行态全部在 ./state.ts(单一共享实例,各层 import 同一份)。
import { stdin, stdout } from 'node:process';
import { inspect } from 'node:util';
import { ui, resetTerminalBackground } from '../theme.js';
import * as content from '../content.js';
import * as mouse from '../mouse.js';
import { setMaxCols } from '../batch.js';
import { copyToClipboard } from '../clipboard.js';
import { t } from '../../i18n/index.js';
import type { StatusBarData } from '../layout-types.js';
import { state } from './state.js';
import { esc, cup, getGeo, setRegion, runningCaretPos, contentMode } from './screen.js';
import { normalizeSelection, normalizeInputSelection, extractSelectionText, extractInputSelectionText, isInputRow, pasteIntoInput, inputScreenToInputPos } from './selection.js';
import { composePlanLines, drawStatusBar, startTurnTimer, stopTurnTimer } from './statusbar.js';
import { paintInput, repaint } from './input-paint.js';
import { WHEEL_LINES, screenRowToAbsLine, repaintViewport, scrollBy, scrollWheel, resetScroll, lockScrollToBottom } from './scroll.js';
import { contentWrite, contentInsertAfter, contentDeleteFrom, contentReplaceLine, reflowContentForResize } from './content-write.js';

export { isTuiActive, getGeo, setRegion, contentMode, isStreamingPaused } from './screen.js';
export { drawStatusBar, setStatus, stopTurnTimer, startTurnTimerIfRunning, paintLiveAtCursor, clearLiveAtCursor, setLiveUsage, setStatusBase } from './statusbar.js';
export { paintInput, paintRunningInput, repaint } from './input-paint.js';
export { isScrolled, repaintViewport, scrollBy, scrollWheel, resetScroll, lockScrollToBottom, unlockScroll, isScrollLocked } from './scroll.js';
export { contentWrite, writeBanner, rewriteBanner, bannerHeight, contentWriteMd, contentWriteMdOnce, clearContent, rewindContent, writeWelcomeBlock, dismissWelcomeBlock, contentInsertAfter, contentDeleteFrom, totalRows, isLastContentRowBlank, normalizeMutationBoundary, normalizeInputBoundary, contentReplaceLine, notifyContentReset } from './content-write.js';

// ── 裸 console 防御 ──
// 第三方库(如 openai SDK)可能用 console.log 直写 stdout,在 RUNNING 态会落到光标所在的底栏
// 输入框、污染输入。进入 TUI 后把 console.* 劫持到 contentWrite,统一进内容区(运行态下
// contentWrite 末尾会把真光标归位输入框),既不再泄漏到输入框,也不会破坏 TUI 布局。
// TUI 外(active=false)不劫持、恢复原始 console,保证 host 子进程 JSON 协议 / 退出日志正常。
// 开关标志 consoleHookInstalled 见 state.ts。
const origConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

function routeConsoleToContent(method: 'log' | 'error' | 'warn' | 'info'): void {
  const c = console as unknown as Record<string, (...args: any[]) => void>;
  c[method] = (...args: any[]): void => {
    if (state.active && ui.isTTY) {
      let s: string;
      try {
        s = args
          .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 })))
          .join(' ');
      } catch {
        s = String(args[0]);
      }
      if (!s.endsWith('\n')) s += '\n';
      contentWrite(s);
    } else {
      origConsole[method](...args);
    }
  };
}

function installConsoleGuard(): void {
  if (state.consoleHookInstalled) return;
  routeConsoleToContent('log');
  routeConsoleToContent('error');
  routeConsoleToContent('warn');
  routeConsoleToContent('info');
  state.consoleHookInstalled = true;
}

function uninstallConsoleGuard(): void {
  if (!state.consoleHookInstalled) return;
  console.log = origConsole.log;
  console.error = origConsole.error;
  console.warn = origConsole.warn;
  console.info = origConsole.info;
  state.consoleHookInstalled = false;
}

const USER_ACTIVE_PAUSE_MS = 1500;

/**
 * 运行态用户打字时调(repl onRunningKey 每次按键):标记活跃 + 重置 flush 定时器。
 * 活跃期间流式只喂缓冲不物理写(光标不入内容区);用户停手 USER_ACTIVE_PAUSE_MS 后 flush:
 * repaintViewport 重画缓冲内容 + drawStatusBar 刷状态行 + 光标归输入框。
 * 解决 IME 候选窗跟流式输出跑:流式写必须 cup 到 contentRow,IME 逐光标跟踪→气泡跟跑;打字时暂停写则光标不动。
 */
export function setUserActive(): void {
  if (!state.active || state.mode !== 'running') return;
  state.userActiveUntil = Date.now() + USER_ACTIVE_PAUSE_MS;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    state.userActiveUntil = 0;
    if (state.active && state.mode === 'running' && state.scrollOffset === 0) {
      repaintViewport(); // 重画内容区(显示活跃期间缓冲的流式内容)
      drawStatusBar(); // 刷状态行(活跃期间冻住,现恢复)
      const p = runningCaretPos();
      stdout.write(cup(p.row, p.col));
    }
  }, USER_ACTIVE_PAUSE_MS);
  state.flushTimer.unref();
}

/** 清活跃选区(不复制),若原有选区则重画去掉反白。供 ESC / 点击别处 / 退出滚动态等场景调。 */
export function clearSelection(): void {
  if (!state.selection && !state.inputSelection) return;
  state.selection = null;
  if (state.inputSelection) {
    state.inputSelection = null;
    if (state.active && state.base && state.lastView) paintInput(state.lastView);
    return;
  }
  if (state.scrollOffset >= 0) repaintViewport();
}

/**
 * 注册"点击输入框粘贴"回调:当前持有文本输入的模块(prompt.ts 的 promptWithSlashMenu / repl 运行态
 * typeahead)在挂键盘监听时调,退出时传 null 注销。点击输入行(未拖动)时 layout 读剪贴板后回调此函数,
 * 由回调方完成插入(各输入状态的行/光标结构不同,layout 不掺和文本编辑逻辑,只管"贴入"这个动作触发)。
 */
export function setPasteHandler(fn: ((text: string) => void) | null): void {
  state.pasteHandler = fn;
}

/** 注册"点击输入框 → 改光标"回调:prompt.ts 等文本所有者挂此回调后,
 *  鼠标左键落输入行算出的新 (line, col) 会在 prompt 下次 redraw 前喂入此回调
 *  (prompt 用它写自己的 cl / cc,真正改 source of truth)。
 *  传 null 注销(在 cleanup / 退出输入态时调,防下个 prompt 实例被旧回调污染)。 */
export function setCursorChangeHandler(fn: ((line: number, col: number) => void) | null): void {
  state.cursorChangeHandler = fn;
}

export function setOverlayMouseHandler(fn: ((e: mouse.MouseEvent) => boolean) | null): void {
  state.overlayMouseHandler = fn;
}

/** picker / 介入面板期间禁用鼠标选区与拖拽(避免 viewport 重画覆盖菜单);滚轮仍可用。面板退出后恢复。 */
export function setMouseEnabled(v: boolean): void {
  state.mouseEnabled = v;
  if (!v) {
    state.selecting = false;
    if (state.selection) {
      state.selection = null;
      repaintViewport();
    }
    if (state.inputSelection) {
      state.inputSelection = null;
      if (state.active && state.base && state.lastView) paintInput(state.lastView);
    }
  }
}

/** 鼠标左键落输入行:进输入态(若是 running)→ 用统一的 display_col 单位算出"目标光标位"
 *  → paintInput 用新光标重画(末步 cup 把终端真光标移到点击位,默认即竖线/闪烁块),
 *  并同步调 cursorChangeHandler 让 prompt.ts 改自己的 cl/cc(source of truth),下次按键按新位写字。
 *
 *  单位说明:
 *  - paintInput 的 view.cursorCol 单位 = display_col(同 paintInput 的 dispCursorCol,见 prompt.ts:186)
 *  - prompt 的 cc 单位 = char_idx(字符索引)
 *  本函数同时给出 targetLine、targetDisplayCol(paintInput 用)、targetCharCol(prompt 用),
 *  故 visitColToCharCol 那一套反推只是用于把 click 屏幕列换成字符偏移,与 paintInput 的视协议完全对齐。
 *
 *  点击行为:
 *  - 屏幕 visRow/visCol 用 charWidth 计列(中文/Emoji 全角占 2);落在宽字符中段归到字符左边界。
 *  - 累加 flat[0..flatIdx-1] 的 display_w + 字符长度 → targetDisplayCol/targetCharCol,与 paintInput 渲染一致。
 *  - 段接缝点击因 paintInput 协议限制(<= 还是 <),会落到前段末;这是 paintInput 全局行为,不归本函数。
 *  - 未注册 handler(非输入态)→ 仅视觉真光标可见;cl/cc 不变。 */
function setInputCursorFromClick(screenRow: number, screenCol: number): void {
  if (!state.active || !state.base || !state.lastView) return;

  // running 态:先收归输入态(enterInputMode 会 paintInput 整帧重画;之后我们再按新光标重画一次覆盖即可)
  if (state.mode !== 'input') {
    enterInputMode(state.statusText);
  }

  const pos = inputScreenToInputPos(screenRow, screenCol);
  if (!pos) {
    paintInput(state.lastView);
    return;
  }

  // 三步原子:
  // 1) lastView.cursorLine = targetLine — view.cursorLine 单位 = lines 行号 in dispLines(供 paintInput)
  // 2) lastView.cursorCol = targetDisplayCol — view.cursorCol 单位 = display_col(供 paintInput,
  //    paintInput 内部 wrap/flat 后用 cursorCol 算 visLine + cursorVisCol)
  // 3) paintInput 重画——末步 cup 把真光标移到点击位的可视位置
  // 4) cursorChangeHandler(dispatchFlatIdx, dispatchInSegVis) — 给 prompt 的"屏 tap 原坐标",
  //    prompt 自己重做 flat 算 cl/cc(扣 chip prefix,与 layout 端的 stamp 时 dispLines 一致即可)。
  // 未注册 handler(非输入态)→ 仅步骤 3 可见真光标移动;步骤 4 不动 prompt 的 cl/cc。
  state.lastView = { ...state.lastView, cursorLine: pos.line, cursorCol: pos.displayCol };
  paintInput(state.lastView);
  if (state.cursorChangeHandler) state.cursorChangeHandler(pos.flatIdx, pos.inSegVis);
}

/**
 * 鼠标事件分发(mouse.setHandler 注册)。
 *  - 左键(button 0):内容区按下开选区、拖动扩展(触边自动翻页)、释放只更新高亮**不复制**;
 *    纯点击(未拖动)清空旧选区(点别处的常见预期);落在输入行 → 自动进入输入态 + 光标定位到点击位
 *    (沿用 windowInputVis 的软折规则做逆解,支持多行 / 中文宽字符;右键 release 落输入行仍贴入)。
 *  - 右键(button 2,单击 = press→release 未拖动):落在输入行 → 读剪贴板贴入(仿常见终端"右键粘贴");
 *    落在内容区 → 复制当前选区(若有)到剪贴板后立即清空高亮(视觉确认"已复制",不留旧选区误导),
 *    静默不弹提示;都无对应状态则 no-op。
 *  - 滚轮(button&64,由 mouse.ts 解析为 wheel 事件):照常 scrollBy。
 * 选区坐标存绝对缓冲行(viewportAbsStart + 屏行),故翻页 / 追加新内容期间选区锚点仍指向同段文字。
 */
function handleMouseEvent(e: mouse.MouseEvent): void {
  if (!state.active) return;
  if (state.overlayMouseHandler && state.overlayMouseHandler(e)) return; // overlay(composer 等)先接管,消费即止
  if (e.type === 'wheel') {
    // 滚轮始终可用:面板/picker 期间也允许上下查看 agent 输出,
    // 与 onRunningKey 的 PgUp/PgDn 行为一致;mouseEnabled 仅管选区/拖拽。
    scrollWheel(e.dir);
    return;
  }
  // 输入行左键点击:即使 mouseEnabled=false(如 intervention 面板期间)也允许定位光标,
  // 提升用户体验(点哪插哪)。拖拽/右键/内容区点击仍受 mouseEnabled 限制。
  if (e.button === 0 && e.type === 'press' && isInputRow(e.row)) {
    setInputCursorFromClick(e.row, e.col);
    const pos = inputScreenToInputPos(e.row, e.col);
    if (pos) {
      if (state.selection) {
        state.selection = null;
      }
      state.inputSelection = {
        anchor: { line: pos.line, col: pos.displayCol },
        end: { line: pos.line, col: pos.displayCol },
        dragged: false,
      };
      paintInput(state.lastView!);
    }
    return;
  }
  if (!state.mouseEnabled) return;
  const g = getGeo();
  const col = Math.max(0, e.col - 1); // SGR 报表列 1-based → 显示列 0-based

  // 右键释放:落输入行 → 优先复制当前输入框选区(若有),退化为贴入;落内容区 → 复制选区后清高亮。
  if (e.type === 'release' && e.button === 2) {
    if (isInputRow(e.row)) {
      // 输入框选区存在且真拖动过:复制(不动 text 光标,不改 cl/cc),与内容区"copy 后清高亮"对齐
      const inpSel = normalizeInputSelection();
      if (inpSel) {
        const text = extractInputSelectionText(inpSel);
        state.inputSelection = null;
        if (state.lastView) paintInput(state.lastView); // 立刻擦反白,视觉反馈
        if (text) copyToClipboard(text);
        return;
      }
      pasteIntoInput();
      return;
    }
    const sel = normalizeSelection();
    if (!sel) return;
    const text = extractSelectionText(sel);
    state.selection = null;
    repaintViewport(); // 复制后清高亮:视觉反馈"已复制",不留旧选区误导
    if (!text) return;
    copyToClipboard(text);
    return;
  }

  if (e.button !== 0) return; // 其余中/右键 press/drag 不处理(终端原生右键菜单等不受影响)

  if (e.type === 'press') {
    // 输入行左键已在上方 mouseEnabled 检查之前处理(支持 intervention 面板期间点击定位光标)。
    // 此处只处理内容区选区。
    state.selecting = true;
    const rowInContent = Math.max(1, Math.min(e.row, g.contentBottom));
    const absLine = screenRowToAbsLine(rowInContent);
    state.selection = { anchorLine: absLine, anchorCol: col, endLine: absLine, endCol: col, dragged: false };
    // 切内容区选区时清掉输入框旧选区(若有)。
    state.inputSelection = null;
    repaintViewport();
    repaint(); // 补一次输入区重画:INPUT 态 repaintViewport 把真光标留在内容区续写位,须靠 repaint 把它带回输入框(否则点内容区会现假闪烁光标,见 issue)
    return;
  }
  if (e.type === 'drag') {
    if (state.inputSelection) {
      // 输入框拖动选区:更新 end,触边不动 scroll(输入框行数有限,无外滚概念);重画底栏。
      const pos = inputScreenToInputPos(e.row, e.col);
      if (pos) {
        if (pos.line !== state.inputSelection.end.line || pos.displayCol !== state.inputSelection.end.col) {
          state.inputSelection.dragged = true;
          state.inputSelection.end = { line: pos.line, col: pos.displayCol };
        }
        paintInput(state.lastView!);
      }
      return;
    }
    if (!state.selecting || !state.selection) return;
    // 触边自动翻页:motion 事件持续到达时靠此逐步滚动,把选区扩展到滚出去的历史行。
    if (e.row <= 1) scrollBy(WHEEL_LINES);
    else if (e.row >= g.contentBottom) scrollBy(-WHEEL_LINES);
    const rowInContent = Math.max(1, Math.min(e.row, g.contentBottom));
    const absLine = screenRowToAbsLine(rowInContent);
    if (absLine !== state.selection.endLine || col !== state.selection.endCol) state.selection.dragged = true;
    state.selection.endLine = absLine;
    state.selection.endCol = col;
    repaintViewport();
    repaint(); // 同上:把真光标带回输入框,防拖动选区期间光标停留内容区闪烁
    return;
  }
  // release(左键)
  state.selecting = false;
  // 输入框 release 优先:未拖动 → 清选区(光标已定好);拖动过 → 留高亮等右键复制
  if (state.inputSelection) {
    if (!state.inputSelection.dragged) {
      state.inputSelection = null;
      if (state.lastView) paintInput(state.lastView);
    }
    // 拖动过:不操作,留高亮
    return;
  }
  if (!state.selection) return;
  if (!state.selection.dragged) {
    // 内容区纯点击(未拖动):若落在工具 batch 摘要行上 → 切换展开/折叠;
    // 否则原行为:清选区。batch 反查通过 content lineAt + dynamic import(避免 layout↔batch 循环依赖)。
    const absClick = state.selection.anchorLine; // 起止同行同列,取任一;未拖动时 line = anchor = end
    void (async (): Promise<void> => {
      try {
        const m = await import('../batch.js');
        const entry = m.findEntryByAbsLine(absClick);
        if (entry) {
          // 先清选区再改 buffer：contentInsert/Delete 内会立即 repaintViewport；若此时仍保留
          // 旧绝对行选区，会短暂画出一帧错位高亮，随后二次重画，视觉上就是抖动。
          state.selection = null;
          m.toggleEntry(entry.batchId, entry.entryIndex, {
            contentInsertAfter: (after, lines) => contentInsertAfter(after, lines),
            contentDeleteFrom: (start, n) => contentDeleteFrom(start, n),
            contentReplaceLine: (absIdx, line) => contentReplaceLine(absIdx, line),
          });
          repaint();
          return;
        }
        const id = m.findBatchByAbsLine(absClick);
        if (id) {
          state.selection = null;
          m.toggleBatch(id, {
            contentInsertAfter: (after, lines) => contentInsertAfter(after, lines),
            contentDeleteFrom: (start, n) => contentDeleteFrom(start, n),
          });
          repaint();
          return;
        }
      } catch {
        // batch 不可用(非 TTY 等)→ 走默认清选区路径
      }
      state.selection = null;
      repaintViewport();
      repaint();
    })();
    return;
  }
  // 拖动过:保留高亮选区供右键复制(不在此处复制,复制交给右键释放分支)。
  repaint(); // 同上:把真光标带回输入框
}

/** 进入输入态:画空输入框 + 状态行,光标入输入框。 */
export function enterInputMode(status: string = t('repl.idle')): void {
  state.mode = 'input';
  state.statusText = status;
  state.spinnerFrame = undefined;
  state.runningFrame = -1; // 回 INPUT 态:停状态行 chip 旋转,composeStatus 退回静态 ●
  state.turnStart = null; // 停走时
  stopTurnTimer();
  state.scrollLockUntil = 0; // 轮末:清轮首滚动锁,INPUT 态可自由滚动
  state.frameRow = 0; // 轮末:清 spinner 帧位置(防下轮残留)
  state.frameCol = 0;
  // 运行态若有未 flush 的缓冲内容(用户打字暂停了流式写),切回 INPUT 前重画内容区显示之,免丢内容
  if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
  if (state.userActiveUntil) {
    state.userActiveUntil = 0;
    if (state.active) repaintViewport();
  }
  if (state.active && state.base) {
    // 先按当前 base.planSummary 重算 planRows(可能从上次会话残留 stale 值),再据此 setRegion
    // 撑出正确脚栏高;否则 plan 撑 2 行时 setRegion(6) 会把 spinner 挤到 plan 第 2 行位置。
    composePlanLines(state.base as StatusBarData, (getGeo()).cols);
    setRegion(4 + state.planRows + 1); // 1 虚拟空 + 1 spinner行 + 1 上线 + 1 输入 + 1 下线 + 1 model行 + plan 多出的行
    paintInput({
      prompt: '❯ ',
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
    });
    stdout.write(esc.cursorShow); // 回 INPUT 态:显真光标(运行态藏了)
  }
}

/** 进入运行态:底栏输入行与空闲态同色(非 dim)、可任意位置编辑,cursor 留输入框。footerH 恒 6(虚拟空+spinner行+上线+输入+下线+model行)。新轮回尾(确保新内容可见)。 */
export function enterRunningMode(status: string, placeholder: string): void {
  state.mode = 'running';
  state.statusText = status;
  state.spinnerFrame = undefined;
  state.turnStart = Date.now(); // 起走时(整轮从发起到 enterInputMode 止)
  resetScroll(); // 若上轮 INPUT 滚动过(未打字回底),新轮回尾
  lockScrollToBottom(); // 轮首短时锁:吸收发消息前后残留滚轮事件,保 agent 输出从底部开始(锁过期或轮末 enterInputMode 解)
  if (state.active && state.base) {
    // 先按当前 base.planSummary 重算 planRows(可能从上次会话残留 stale 值),再据此 setRegion
    // 撑出正确脚栏高;否则 plan 撑 2 行时 setRegion(6) 会把 spinner 挤到 plan 第 2 行位置。
    composePlanLines(state.base as StatusBarData, (getGeo()).cols);
    setRegion(4 + state.planRows + 1); // 1 虚拟空 + 1 spinner行 + 1 上线 + 1 输入 + 1 下线 + 1 model行 + plan 多出的行
    paintInput({
      prompt: '❯ ',
      lines: [''],
      placeholder,
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
    });
    startTurnTimer(); // 续刷状态行走时(流式期间 spinner 停转,由它兜底)
    contentMode();
    // 真光标可见,停在输入框光标位(供 IME 锚定气泡到光标处)。打字时 setUserActive 暂停流式写、
    // 光标稳定在输入框;流式写时瞬时到 contentRow 但合并写入很快回输入框(光标跟流式是终端常态)。
    // 不再藏光标:藏了 IME 气泡会跑到输入框最右边而非光标处(WT 不锚定隐藏光标)。
  }
}

// ── alt screen 生命周期 + 钩子 ──

export function enterAltScreen(): void {
  if (state.active || !ui.isTTY) return;
  state.active = true;
  state.lastTerminalCols = getGeo().cols;
  setMaxCols(state.lastTerminalCols); // 同步 batch 展开行宽钳制,防超宽行 auto-wrap 打乱屏位
  stdout.write(esc.altOn);
  // 不动终端窗口背景:底色保持用户终端原色,主题只作用于我们画出的 SGR 颜色。
  stdout.write(esc.mouseOn); // 完整鼠标追踪(按下/拖动/释放/滚轮)→ mouse.swallow 重组 → handleMouseEvent
  mouse.setHandler(handleMouseEvent);
  // 进入 alt screen 前 base 可能已设了 planSummary;按当前 planSummary 重算 planRows,
  // 让首次 setRegion 撑出正确脚栏高(否则 plan 撑 2 行时会被 spinner 行覆盖)。
  if (state.base) composePlanLines(state.base as StatusBarData, (getGeo()).cols);
  setRegion(4 + state.planRows + 1); // 1 虚拟空 + 1 spinner行 + 1 上线 + 1 输入 + 1 下线 + 1 model行 + plan 多出的行
  state.contentRow = 1;
  state.contentCol = 1;
  state.segmentStartRow = 1;
  state.scrollOffset = 0;
  state.scrollLockUntil = 0;
  state.mdActive = false;
  state.mdBuf = '';
  state.selection = null;
  state.selecting = false;
  content.reset();

  state.exitHandler = () => exitAltScreen();
  process.on('exit', state.exitHandler);

  state.sigwinchHandler = () => {
    if (!state.active) return;
    // 立即(同步)更新行号 + 重设 DECSTBM 区域:不 debounce,否则快速拖动边框时
    // contentRow 停在旧值、区域未更新,spinner/contentWrite 画到旧行号(「思考中在消息堆里」根因)。
    // 重画 repaintViewport 防抖(下面 timer),避免连续拖动闪烁;但行号/区域必须立即正确。
    const g = getGeo(state.footerH);
    setMaxCols(g.cols); // 列宽变 → 展开行钳宽上限同步(后续新展开行生效)
    const total = content.totalRows();
    const committed = content.committedRows();
    // 缩小:contentRow > 新 bottom → 钳到新 bottom
    if (state.contentRow > g.contentBottom) state.contentRow = g.contentBottom;
    // 放大:contentRow < 新 bottom 且回尾(offset=0)→ 推进到 min(committed+1, bottom)
    //    committed+1 是合法「待写位」;用 total+1 在 hasCurrent=true(breakRow 后)时会多跳一行。
    if (state.scrollOffset === 0 && state.contentRow < g.contentBottom) {
      state.contentRow = Math.min(committed + 1, g.contentBottom);
    }
    if (state.frameRow && state.frameRow > g.contentBottom) state.frameRow = g.contentBottom;
    const maxOff = Math.max(0, total - g.contentBottom);
    if (state.scrollOffset > maxOff) state.scrollOffset = maxOff;
    setRegion(state.footerH); // 用新 rows 立即重设 DECSTBM 区域(contentBottom 变)
    // 重画防抖(仅 repaint,避免快速拖动闪烁);行号/区域已立即更新
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      state.resizeTimer = null;
      if (!state.active) return;
      const latest = getGeo(state.footerH);
      // 列宽变化时会重排 markdown；即便仅高度变化或重排后行数不变，也必须重算
      // active segment 的屏幕锚点与当前待写列，避免后续流式 chunk 使用旧坐标。
      const colsChanged = latest.cols !== state.lastTerminalCols;
      reflowContentForResize(latest.cols, colsChanged);
      state.lastTerminalCols = latest.cols;
      repaintViewport(); // 内容区按最新高度和列宽重画；markdown 历史已按新列宽 reflow
      repaint(); // 底栏重画
    }, 100);
    state.resizeTimer?.unref?.();
  };
  process.on('SIGWINCH', state.sigwinchHandler);

  installConsoleGuard(); // 进入 TUI 即接管裸 console 输出,防第三方日志污染输入框
}

/** 复原:复位 margins + 显光标 + 退 alt + 还原 raw。幂等。 */
export function exitAltScreen(): void {
  if (!state.active) return;
  state.active = false;
  uninstallConsoleGuard(); // 退出 TUI 恢复原始 console(不影响 host 子进程 / 退出日志)
  resetTerminalBackground();
  stopTurnTimer(); // 兜底清走时计时器(防异常退出泄漏)
  state.turnStart = null;
  state.scrollLockUntil = 0; // 清轮首滚动锁(防状态泄漏到下次进 alt 屏)
  state.frameRow = 0; // 清 spinner 帧位置(防状态泄漏到下次进 alt 屏)
  state.frameCol = 0;
  mouse.setHandler(null);
  mouse.resetMouse();
  state.selection = null;
  state.selecting = false;
  // raw 还原独立 try:非 TTY / 不支持时 setRawMode 抛错,不应阻断 stdout 恢复(alt 退屏必须执行)。
  try {
    stdin.setRawMode(false); // 还原 raw(RUNNING 态常驻 raw,退出时必须还原,否则终端残留 raw 模式)
  } catch {
    // 非 TTY / 不支持:忽略
  }
  try {
    stdout.write('\x1B[r'); // 复位 DECSTBM margins
    stdout.write(esc.cursorShow);
    stdout.write(esc.mouseOff); // 关鼠标追踪(反序:先 1006l 再 1002l 再 1000l)
    stdout.write(esc.altOff); // 退 alt(恢复主屏 + 光标)
  } catch {
    // 忽略
  }
  if (state.exitHandler) {
    try {
      process.removeListener('exit', state.exitHandler);
    } catch {
      // 忽略
    }
    state.exitHandler = null;
  }
  if (state.sigwinchHandler) {
    try {
      process.removeListener('SIGWINCH', state.sigwinchHandler);
    } catch {
      // 忽略
    }
    state.sigwinchHandler = null;
  }
  if (state.resizeTimer) {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = null;
  }
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.userActiveUntil = 0;
}

/**
 * 直写终端(绕过 content buffer):仅限弹窗类覆盖层(输入面板)使用——
 * 它画在 content 区之上,关闭后由调用方 repaintViewport() 整幅还原。
 * 不做行宽钳制:调用方自己保证每行 ≤ cols(弹窗几何已按 getGeo() 计)。
 */
export function writeDirect(s: string): void {
  try {
    stdout.write(s);
  } catch {
    // 忽略
  }
}

export function isActive(): boolean {
  return state.active;
}
