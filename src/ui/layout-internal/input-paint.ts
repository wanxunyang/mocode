// L2 输入框绘制:开窗 / 折行 / 反白 / dim 占位,以及 repaint 总刷新。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { stdout } from 'node:process';
import { charWidth, displayWidth, truncateDisplay, truncateDisplayHead, wrapByDisplayWidth } from '../render.js';
import { ui } from '../theme.js';
import * as content from '../content.js';
import type { StatusBarData, InputView } from '../layout-types.js';
import { state } from './state.js';
import { esc, cup, getGeo, setRegion, runningCaretPos } from './screen.js';
import { SEL_OPEN, SEL_OFF, normalizeInputSelection, inputViewSig } from './selection.js';
import { composeSpinnerLine, composeModelLine, composePlanLines, drawStatusBar } from './statusbar.js';

// ── 输入区(底栏输入框 + 向上菜单)──

/**
 * 把逻辑行软折成可视行并开窗(超 maxInputRows 时滑窗保光标可见)。返回可见可视行文本(已折行)+
 * 光标在窗口内行号 + 光标在该可视行的显示列 + 所需输入行数 + 窗口起始全局可视行号。
 *
 * 光标可视位置按各行**实际**显示宽度逐行累加(不按 width×行号 除法):宽字符(CJK=2)在行尾放不下时
 * 整字折到下行、本行留尾空格,简单除法会把光标算偏;逐行累加 displayWidth 才与终端实际光标一致。
 */
function windowInputVis(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  cols: number,
  promptW: number,
  rows: number
): {
  visRows: string[];
  visLine: number;
  cursorVisCol: number;
  inputRows: number;
  startVis: number;
} {
  const W = Math.max(1, cols - promptW);
  const lineVis: string[][] = lines.map((l) => wrapByDisplayWidth(l, W));
  const flat: string[] = [];
  for (const lv of lineVis) for (const r of lv) flat.push(r);
  const totalVis = flat.length;

  // 光标在其逻辑行内的可视行 / 可视列
  const clRows = lineVis[cursorLine] ?? [''];
  let curVisRow = 0;
  let curVisCol = cursorCol;
  {
    let acc = 0;
    for (let i = 0; i < clRows.length; i++) {
      const rw = displayWidth(clRows[i]);
      if (cursorCol <= acc + rw) {
        curVisRow = i;
        curVisCol = cursorCol - acc;
        break;
      }
      acc += rw;
      curVisRow = i;
      curVisCol = cursorCol - acc;
    }
  }

  // 光标绝对可视行
  let curAbs = 0;
  for (let i = 0; i < cursorLine; i++) curAbs += lineVis[i].length;
  curAbs += curVisRow;

  const maxInputRows = Math.max(1, Math.floor(rows * 0.4));
  let startVis = 0;
  if (totalVis > maxInputRows) {
    startVis = Math.max(
      0,
      Math.min(curAbs - maxInputRows + 1, totalVis - maxInputRows)
    );
  }
  const showCount = Math.min(maxInputRows, totalVis);
  return {
    visRows: flat.slice(startVis, startVis + showCount),
    visLine: curAbs - startVis,
    cursorVisCol: curVisCol,
    inputRows: showCount,
    startVis,
  };
}

/** 把 lines 按 W 做软折,返回 lineVis;供 paintInput 高亮预算用。与 windowInputVis 复用 wrap 算法。 */
function visInputLines(lines: string[], W: number): string[][] {
  return lines.map((l) => wrapByDisplayWidth(l, W));
}

/**
 * 给纯文本(无 ANSI,来自 wrap 后的可视段)做"显示列区间"高亮,返回插入 SEL_OPEN/SEL_OFF 后的字符串。
 * 输入字段 vis 段宽 = displayWidth(seg),clipStart/clipEnd 单位 = display_col。
 * 与 highlightRange 等价语义但省去 ANSI split(纯文本无 SGR),更省。
 */
function highlightWithinRow(seg: string, clipStart: number, clipEnd: number): string {
  if (clipEnd <= clipStart) return seg;
  let out = '';
  let w = 0;
  let opened = false;
  for (const ch of seg) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (!opened && w >= clipStart && w < clipEnd) {
      out += SEL_OPEN;
      opened = true;
    }
    if (opened && w >= clipEnd) {
      out += SEL_OFF;
      opened = false;
    }
    out += ch;
    w += cw;
  }
  if (opened) out += SEL_OFF;
  return out;
}

/**
 * 画输入区:擦旧菜单 → (必要时)setRegion → 画状态行 + 输入行 + 向上菜单,光标留输入框(dim 时回续写位)。
 * prompt.ts 每次按键调;enterInputMode / enterRunningMode 也调(空 / dim)。
 */
export function paintInput(view: InputView): void {
  if (!state.active || !state.base) return;
  state.lastView = view;
  // 失效检测:lastView 文本若有变化(键输入/AI 续写)→ 选区锚点不再有效,清掉避免「错位反白」。
  // 内容区选区用 content 自己的锚,与 lastView 无关,不动。
  if (state.inputSelection) {
    const sig = inputViewSig(view);
    if (sig !== state.lastInputSig) {
      state.inputSelection = null;
    }
    state.lastInputSig = sig;
  } else {
    state.lastInputSig = inputViewSig(view);
  }
  const preGeo = getGeo();
  // 累积本帧所有 cup/clearLine/文本,末尾一次写出——避免「擦旧菜单」与「重画」分多次 write 时,
  // 终端把中间空白渲染出来 → 菜单/面板切换时闪烁(↑↓ 导航每次 redraw 都全帧擦后重画)。
  let buf = '';

  // 1. 擦旧菜单(用上次记录的起始行 + 行数,与本次几何无关——setRegion 不动屏幕内容)
  if (state.lastMenuRows > 0) {
    for (let i = 0; i < state.lastMenuRows; i++) {
      buf += cup(state.lastMenuStartRow + i, 1) + esc.clearLine;
    }
    state.lastMenuRows = 0;
  }

  // 2. 算输入可视行(软折行)+ 必要时 setRegion。dim=运行态占位:单行不折行。
  const promptW = displayWidth(view.prompt);
  const vis = view.dim
    ? {
        visRows: [view.lines[0] ?? ''],
        visLine: 0,
        cursorVisCol: 0,
        inputRows: 1,
        startVis: 0,
      }
    : windowInputVis(
        view.lines,
        view.cursorLine,
        view.cursorCol,
        preGeo.cols,
        promptW,
        preGeo.rows
      );
  const needFooterH = 5 + vis.inputRows + (state.planRows - 1); // 1 虚拟空 + 1 spinner 行 + 1 上线 + 输入行 + 1 下线 + 1 model 行 + plan 多出的行数
  let g = preGeo;
  if (needFooterH !== state.footerH) {
    // setRegion 自己 write(DECSTBM + 清行 + 归位):先把已累积的擦除 flush 出去保序(擦除用的是旧几何的
    // lastMenuStartRow,须在 setRegion 改区域前落地),再 setRegion,之后 2b..6 重新累积。
    // footerH 不变时(常见:单行输入 / 菜单切换 / ↑↓ 导航)整帧一次 write,终端原子应用,无中间空白→不闪烁。
    if (buf) {
      stdout.write(buf);
      buf = '';
    }
    g = setRegion(needFooterH);
  }

  // 2b. 重画内容末行(底栏上一行)从缓冲:防 WT 边距漏影(状态行重复到该行),并保证该行显正确内容
  {
    const slice = content.sliceFromEnd(state.scrollOffset, g.contentBottom);
    const line = slice[g.contentBottom - 1] ?? '';
    buf += cup(g.contentBottom, 1) + esc.clearLine + line;
  }

  // 2c. 虚拟空行(内容区与状态栏之间的视觉间隔,属底栏非内容):
  //     - 无活跃 plan:清空保留作分隔(原设计)
  //     - 有活跃 plan:渲染 plan chip(整帧重画时也要更新,避免 listener 漏触发后残留)
  //     - plan 过长:占 2 行(planRows=2),spinner/上线/输入行随之整体下移 1 行
  //     paintInput 与 drawStatusBar 共享同一 planRows 模块态,setRegion 已据此把脚栏撑高。
  {
    const planBuf = composePlanLines(state.base as StatusBarData, preGeo.cols);
    for (let i = 0; i < planBuf.length; i++) {
      buf += cup(g.contentBottom + 1 + i, 1) + esc.clearLine + planBuf[i];
    }
    // 计划行从 2 行降到 1 行(plan 当前很短):清掉残留的第 2 行,不留尾巴。
    if (planBuf.length < state.planRows && state.planRows === 2) {
      buf += cup(g.contentBottom + 2, 1) + esc.clearLine;
      state.planRows = 1;
    }
    // plan 从非空变成空(已结算/无活跃段)时,清掉残留的 plan 行 1。
    // 上面 for 循环在 planBuf.length===0 时不写任何 cup,需要显式清一行回到「虚拟空行」。
    if (planBuf.length === 0) {
      buf += cup(g.contentBottom + 1, 1) + esc.clearLine;
    }
  }

  // 3. 状态行:spinner 行 + model 行(两行式底栏)
  const spinnerRow = g.contentBottom + 1 + state.planRows; // plan 占 planRows 行(1 或 2),spinner 紧跟其后
  const modelRow = g.rows; // 屏底:model 行
  const status: StatusBarData = { ...state.base, status: state.statusText, spinnerFrame: state.spinnerFrame };
  buf += cup(spinnerRow, 1) + esc.clearLine + composeSpinnerLine(status, g.cols);
  buf += cup(modelRow, 1) + esc.clearLine + composeModelLine(status, g.cols);

  // 3b. 上线(输入框顶):满屏宽细线 ─(cyan),框住输入区上边界
  buf += cup(g.contentBottom + 2 + state.planRows, 1) + esc.clearLine + ui.accent + '─'.repeat(g.cols) + ui.reset;

  // 4. 输入行(g.contentBottom+3+planRows .. rows-1)——按可视行画,首行带 prompt、其余缩进 promptW
  const firstInputRow = g.contentBottom + 3 + state.planRows;
  const inputRowsAvail = vis.inputRows; // 脚栏总高 - 1(spinner) - 1(上 sep) - 1(下 sep) - 1(model) - planRows
  const indent = ' '.repeat(promptW);
  // 光标:不画反白块/假光标——输入框走终端真光标(WT / VSCode 终端默认竖线/闪烁块,
  // 各终端表现略不同但都贴合 IME 候选气泡且不再"挡住字符")。真光标位置由下方第 6 步 cup 写。
  // 保留 view.caret=false 路径给 picker 等非文本输入:把真光标定位到 hint 末尾。
  const inpSel = normalizeInputSelection(); // 已签名检测失效,这里看到的要么有效要么 null
  // 预算 (visRow -> line) 用于高亮:与 inputScreenToInputPos 的反推同源(flat → line + segInLine)
  const colW = Math.max(1, preGeo.cols - promptW);
  const lineVisArr: string[][] = visInputLines(view.lines, colW);
  const flatInput: string[] = [];
  for (const lv of lineVisArr) for (const r of lv) flatInput.push(r);
  const flatToLine: { line: number; segInLine: number; inLineDisplayCol: number }[] = [];
  for (let li = 0; li < lineVisArr.length; li++) {
    const segs = lineVisArr[li];
    let acc = 0;
    for (let s = 0; s < segs.length; s++) {
      flatToLine.push({ line: li, segInLine: s, inLineDisplayCol: acc });
      acc += displayWidth(segs[s]);
    }
    if (segs.length === 0) flatToLine.push({ line: li, segInLine: 0, inLineDisplayCol: 0 });
  }
  for (let i = 0; i < inputRowsAvail; i++) {
    const line = vis.visRows[i] ?? '';
    const r = firstInputRow + i;
    const prefix = vis.startVis === 0 && i === 0 ? view.prompt : indent;
    let text: string;
    if (view.dim) {
      text = renderDimInputRow(view.prompt, line, view.placeholder ?? '', g.cols);
    } else {
      text = `${prefix}${line}`;
      // 空输入引导:INPUT 态缓冲为空时,在首行画 dim ghost 占位(「输入 / 查看命令…」);
      // 任何按键都会改变缓冲 → 下一帧 isEmpty=false → 占位自然消失,无需额外擦除逻辑。
      if (!line && view.placeholder && vis.startVis === 0 && i === 0) {
        const avail = Math.max(0, preGeo.cols - promptW);
        text = `${prefix}${ui.dim}${truncateDisplay(view.placeholder, avail)}${ui.reset}`;
      }
      // 输入框反白叠层:仅当 paintInput 不是 dim(运行态 typeahead 不参与选区,避免干扰 IME 气泡),
      // 且该可视段所属的逻辑行落在 inpSel 区间内 → 高亮行内 [colStart,colEnd) 段。
      if (inpSel) {
        const flatIdx = vis.startVis + i;
        const m = flatIdx < flatToLine.length ? flatToLine[flatIdx] : flatToLine[flatToLine.length - 1];
        if (m.line >= inpSel.startLine && m.line <= inpSel.endLine) {
          const seg = flatInput[flatIdx] ?? '';
          const segW = displayWidth(seg);
          const colStart = m.line === inpSel.startLine ? inpSel.startCol - m.inLineDisplayCol : 0;
          const colEnd = m.line === inpSel.endLine ? inpSel.endCol - m.inLineDisplayCol : segW;
          if (colStart < segW && colEnd > colStart) {
            // 对 seg(纯文本无 ANSI)做行内高亮:在 [clipStart, clipEnd) 之间插 SEL_OPEN/SEL_OFF。
            text = `${prefix}${highlightWithinRow(seg, Math.max(0, colStart), Math.min(segW, colEnd))}`;
          }
        }
      }
    }
    buf += cup(r, 1) + esc.clearLine + text;
  }

  // 4b. 下线(输入框底):满屏宽细线 ─(cyan),在 model 行上一行(model 行占屏底 rows)
  buf += cup(g.rows - 1, 1) + esc.clearLine + ui.accent + '─'.repeat(g.cols) + ui.reset;

  // 5. 向上菜单(画在内容区底,底栏正上方)
  if (view.menu && view.menu.lines.length > 0) {
    const menuRows = Math.min(view.menu.lines.length, g.contentBottom);
    const menuStart = g.contentBottom - menuRows + 1;
    for (let i = 0; i < menuRows; i++) {
      buf += cup(menuStart + i, 1) + esc.clearLine + view.menu.lines[i];
    }
    state.lastMenuStartRow = menuStart;
    state.lastMenuRows = menuRows;
  }

  // 6. 光标
  if (view.dim) {
    // 运行态(回尾 / 滚动回看均):真光标归输入框光标位(供 IME 锚定,气泡在输入框而非内容区)。
    // 滚动态也归输入框——上滑看历史时打字,IME 候选气泡须锚到输入框(conhost IME 不跟随 cup 后续移动,
    // 须让打字前光标已在输入框);viewport 锁历史靠 scrollOffset,不靠光标位置。
    const p = runningCaretPos();
    buf += cup(p.row, p.col);
  } else {
    const r = firstInputRow + vis.visLine;
    const col = promptW + vis.cursorVisCol + 1;
    buf += cup(r, col);
  }

  if (buf) stdout.write(buf); // 整帧一次写出(footerH 不变时):终端原子应用,无中间空白→不闪烁
}

/**
 * 渲染运行态输入行(dim):❯ + (有打字:dim 文本 + 末尾反白块状光标;无打字:反白光标在起点 + dim 占位 ghost)。
 * 光标是「画出来」的反白块(非真终端光标)——真光标仍归续写位,避开与 contentWrite/drawStatusBar 争用;
 * 输入行在 RUNNING 期间只被按键回显重画(流式/spinner 不碰这行),故画上去的光标能稳住。
 * 内容截断到 cols-promptW-1(留 ❯ 与光标各 1 cell),防超长软折行写穿下线。
 */
function renderDimInputRow(
  prompt: string,
  text: string,
  placeholder: string,
  cols: number
): string {
  const promptW = displayWidth(prompt);
  // dim 态(运行中打字):不画反白块——反白块视觉占位是 INPUT 态真光标的旧版,这里真光标本
  // 就被隐起来(IME 锚定需要,见 contentMode),在 dim 文本后硬塞个反白空格会"白块闪烁"。
  // 用户读 dim 文本本身就能定位打字边界;真光标在 INPUT 态显形(竖线/闪烁块,跟终端默认一致)。
  const contentW = Math.max(0, cols - promptW);
  if (text.length > 0) {
    // 有打字:❯ dim + 文本(dim,超长从头部截断保留尾部——光标恒在末尾,须始终看到刚打的字)
    return `${ui.dim}${prompt}${truncateDisplayHead(text, contentW)}${ui.reset}`;
  }
  // 空:❯ dim + dim 占位 ghost(taking the full row)
  const p = placeholder ? truncateDisplay(placeholder, contentW) : '';
  return `${ui.dim}${prompt}${p}${ui.reset}`;
}

/**
 * 单行运行态滑窗:以光标为中心,向左右扩展填满 contentW-1(留 1 cell 给光标),
 * 返回可见子串与光标在子串内的显示列。保证光标恒可见,且不软折行(运行态输入框恒单行,
 * 不触发 setRegion/ED,避免流式期间底栏抖动)。
 */
function windowSingleLine(text: string, cursor: number, contentW: number): { shown: string; curDisp: number } {
  const n = text.length;
  if (n === 0) return { shown: '', curDisp: 0 };
  const totalDisp = displayWidth(text);
  if (totalDisp <= contentW) return { shown: text, curDisp: displayWidth(text.slice(0, cursor)) };
  let i = cursor;
  let j = cursor;
  let w = 0;
  const cw = (idx: number) => charWidth(text.codePointAt(idx) ?? 0);
  while (i > 0 && w + cw(i - 1) <= contentW - 1) { w += cw(i - 1); i--; }
  while (j < n && w + cw(j) <= contentW - 1) { w += cw(j); j++; }
  return { shown: text.slice(i, j), curDisp: displayWidth(text.slice(i, cursor)) };
}

/**
 * 运行态 typeahead 回显:定向写输入行(底栏输入框),非 dim(与空闲态同色)、光标可任意位置、单行。
 * 只 cup 输入行 + clearLine + 文本 + cup 真光标到编辑位——不调 setRegion(运行中禁多行,避免 DECSTBM 抖动)、
 * 不重画状态行/contentBottom、不用 ED。同步 lastView 为运行视图(非 dim),使 scrollBy/resize 的 repaint
 * 仍显当前回显 + 光标。空且带 placeholder 时显 dim ghost(提示 agent 状态;非用户输入,不违反"打字不变灰")。
 * 选区高亮由 paintInput 路径(paint 时鼠标拖选)承担,此处轻量不重复实现。
 */
export function paintRunningInput(text: string, cursor: number, placeholder?: string): void {
  if (!state.active || !state.base) return;
  const g = getGeo();
  const inputRow = g.contentBottom + 3 + state.planRows; // 运行态 footerH 随 plan 行数动态(6 或 7)
  const promptW = displayWidth('❯ ');
  const contentW = Math.max(1, g.cols - promptW);
  let outLine: string;
  let curCol: number; // 输入框内的显示列(不含 prompt)
  if (text.length === 0 && placeholder) {
    outLine = `${ui.dim}❯ ${truncateDisplay(placeholder, contentW)}${ui.reset}`;
    curCol = 0;
  } else {
    const { shown, curDisp } = windowSingleLine(text, cursor, contentW);
    outLine = `❯ ${shown}`; // 正常色 —— 运行态打字与空闲态一致
    curCol = curDisp;
  }
  state.lastView = {
    prompt: '❯ ',
    lines: [text],
    placeholder,
    cursorLine: 0,
    cursorCol: cursor,
    menu: null,
    // 不置 dim:运行态输入框与空闲态同色、可任意位置编辑
  };
  const cursorCol = Math.min(g.cols, promptW + curCol + 1);
  stdout.write(cup(inputRow, 1) + esc.clearLine + outLine + cup(inputRow, cursorCol));
}

/** 重画当前视图(resize / 内部用)。 */
export function repaint(): void {
  if (!state.active || !state.base) return;
  if (state.lastView) paintInput(state.lastView);
  else drawStatusBar();
}
