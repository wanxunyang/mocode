import { stdin, stdout } from 'node:process';
import { inspect } from 'node:util';
import {
  charWidth,
  displayWidth,
  truncateDisplay,
  truncateDisplayHead,
  truncateAnsi,
  ansiDisplayWidth,
  wrapByDisplayWidth,
  fmtElapsed,
  stripAnsi,
  sliceByDisplayCol,
  remapWrappedPoint,
  padEndAnsiBackground,
} from '../render.js';
import { ui, resetTerminalBackground } from '../theme.js';
import * as content from '../content.js';
import * as mouse from '../mouse.js';
import {
  reset as resetBatches,
  shiftBatchesAfter,
  shiftBatchesForReflow,
  setMaxCols,
} from '../batch.js';
import { copyToClipboard, readClipboard } from '../clipboard.js';
import { renderMarkdown } from '../markdown.js';
import { t } from '../../i18n/index.js';
import type { Geo, StatusBarData, InputView } from '../layout-types.js';
import { state } from './state.js';

/**
 * 全屏 TUI 布局:alt screen + 单滚动区域(内容区)+ 区域外固定底栏(状态行 + 输入框)。
 *
 * 只依赖最成熟、Windows(WT / conhost)最稳的 ANSI 子集:
 *  - alt screen        \x1B[?1049h / \x1B[?1049l
 *  - DECSTBM 滚动区域  \x1B[<top>;<bottom>r   (区域内写满自动在区域内滚动,区域外底栏不被顶)
 *  - 逐行擦除          \x1B[2K / \x1B[K        (菜单 / 清屏,绝不用 ED \x1B[J 做边界擦除)
 *  - CUP 绝对定位      \x1B[<row>;<col>H
 * 不用原点模式(\x1B[?6h)、不依赖 ED 边界、不用 DECSC/DECRC、不用 IL/DL/SU/SD——这些在 conhost 上不可靠。
 *
 * 续写位(contentRow / contentCol)由 contentWrite 按字符宽度 + 折行模拟跟踪;CUP 到它即可随时回到内容续写位,
 * 故底栏刷新(状态行 / spinner)无需保存/恢复光标——CUP 回续写位即可。
 *
 * 关键洞察:RUNNING 态也支持 typeahead 输入与滚动回看。INPUT 态光标常驻输入框;RUNNING 态光标在续写位,
 * 运行中打的字经 paintRunningInput(非 dim)回显(占位行换成已打文本,光标停在编辑位,不与流式争用);
 * 运行中可滚动回看——contentWrite 在 scrollOffset>0 时只喂缓冲不物理写(否则新流式覆盖 viewport 历史行),
 * 回尾(scrollOffset===0)才 cup 续写位写出。两态切换不重设区域(底栏高度恒 = 2),仅多行输入换行撑高时才 setRegion。
 *
 * 非 TTY:全部空操作,contentWrite 退化为 stdout.write,与改造前内联行为一致。
 */

// 可变运行态全部集中在 ./state.ts 的共享单例;本文件只留纯常量与函数。

/** 是否处于全屏 TUI(alt screen)激活态。非 TTY / 嵌入宿主(host)下为 false。
 *  子 agent 等异步路径据此判断能否把中间过程实时写入主内容区。 */
export function isTuiActive(): boolean {
  return state.active;
}

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

// ── 纯常量(可变运行态在 state.ts)──
const SCROLL_LOCK_MS = 400; // 锁时长:覆盖 OS 缓冲残留 + 常规滚轮惯性;LLM TTFB 多 >200ms,不影响轮中后段滚动
const RUNNING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const USER_ACTIVE_PAUSE_MS = 1500;
/** Sticky banner 的 ❯ 前缀(同 repl 的 PROMPT;常量统一视觉)。 */
const BANNER_PROMPT = '❯ ';
const WHEEL_LINES = 3; // 滚轮每格滚动行数

const esc = {
  altOn: '\x1B[?1049h',
  altOff: '\x1B[?1049l',
  // 完整鼠标追踪:1000=按键(按下/释放)+ 1002=拖动 motion + 1006=SGR 编码。
  // 拿到按下/拖动/释放的坐标后,由 layout 在应用层维护选区(mouse.ts 重组报表 → handleMouseEvent):
  //  - 左键:内容区按下开选区、拖动扩展(触边自动翻页跨屏)、释放只留高亮,不自动复制;输入框不响应
  //    (不干扰正常打字/焦点)。
  //  - 右键(单击,press→release 未拖动):落在输入框 → 读剪贴板贴入(setPasteHandler 回调);
  //    落在内容区 → 复制当前选区(若有)到剪贴板(clipboard.ts),静默不弹提示。
  //  - 滚轮报表(button&64)转 scrollBy。
  // 代价:终端原生框选被鼠标捕获接管——想用终端原生选区可按住 Shift(多数终端放行)。
  // 1007l=关闭 Alternate Scroll Mode:VSCode xterm.js 进 alt screen(?1049)后默认开 1007,
  // 滚轮发 Up/Down 方向键而非 SGR 鼠标报表;不关的话滚轮会绕过 mouse.swallow 直接触发
  // prompt 的历史导航(recallPrevious/recallNext)→ "输入框打字时滚轮跳到上一条历史消息"。
  mouseOn: '\x1B[?1007l\x1B[?1000h\x1B[?1002h\x1B[?1006h',
  mouseOff: '\x1B[?1006l\x1B[?1002l\x1B[?1000l\x1B[?1007h', // 关:反序;末尾恢复 1007(交还终端默认)
  cursorShow: '\x1B[?25h',
  cursorHide: '\x1B[?25l',
  clearLine: '\x1B[2K',
  home: '\x1B[H',
};

/** CUP(光标绝对定位),钳到 >=1。 */
function cup(row: number, col: number): string {
  return `\x1B[${Math.max(1, Math.round(row))};${Math.max(1, Math.round(col))}H`;
}

export function getGeo(fh: number = state.footerH): Geo {
  const rows = stdout.rows || 24;
  const cols = stdout.columns || 80;
  const f = Math.max(1, Math.min(fh, rows - 1));
  return {
    rows,
    cols,
    footerH: f,
    contentTop: 1,
    contentBottom: Math.max(1, rows - f),
  };
}

/** (重)设滚动区域 [1, rows-footerH];设完 \x1B[H 归位(conhost 设 DECSTBM 时光标留旧位置行为未定义)。 */
export function setRegion(fh: number): Geo {
  const rows = stdout.rows || 24;
  const oldBottom = Math.max(1, rows - state.footerH);
  const g = getGeo(fh);
  state.footerH = g.footerH;
  if (state.active) {
    stdout.write(`\x1B[1;${g.contentBottom}r`); // DECSTBM: top=1, bottom=contentBottom
    // 底栏缩小:原底栏行变回内容区,清掉残留底栏文本(否则提交多行后旧输入残留在底部)
    if (g.contentBottom > oldBottom) {
      let p = '';
      for (let r = oldBottom + 1; r <= g.contentBottom; r++) {
        p += cup(r, 1) + esc.clearLine;
      }
      stdout.write(p);
    }
    stdout.write(esc.home);
  }
  if (state.contentRow > g.contentBottom) state.contentRow = g.contentBottom; // 底栏撑高挤掉内容:钳到新区底
  return g;
}

/** 运行态真光标(隐藏)的归位点 = 输入框光标位:行 = 动态 contentBottom+3+planRows(resize 安全)。
 *  非 dim 运行态(与空闲态同色、可任意位置编辑)→ 归当前编辑位,供 IME 锚定气泡到光标处;
 *  dim 占位(空 + placeholder)兼容态→ 归输入框起点。供 IME 锚定。 */
function runningCaretPos(): { row: number; col: number } {
  const g = getGeo();
  const row = g.contentBottom + 3 + state.planRows;
  if (state.lastView && !state.lastView.dim) {
    const promptW = displayWidth(state.lastView.prompt);
    const line = state.lastView.lines[state.lastView.cursorLine] ?? '';
    const before = line.slice(0, state.lastView.cursorCol);
    const col = Math.min(g.cols, promptW + displayWidth(before) + 1);
    return { row, col };
  }
  const text = state.lastView?.dim ? state.lastView.lines[0] ?? '' : '';
  const contentW = Math.max(0, g.cols - 3); // ❯ =2 + 光标=1
  const w = displayWidth(truncateDisplayHead(text, contentW));
  return { row, col: Math.min(g.cols, 2 + w + 1) };
}

export function contentMode(): void {
  if (!state.active) return;
  const g = getGeo();
  if (state.mode === 'running') {
    // 运行态(回尾 / 滚动回看均):真光标归输入框光标位(供 IME 锚定,气泡不跟流式跑)。
    // 滚动态也归输入框——否则上滑看历史时打字,IME 候选气泡会锚到内容区底而非输入框
    // (conhost IME 不跟随 cup 后续移动,须让打字前光标已在输入框)。
    const p = runningCaretPos();
    stdout.write(cup(p.row, p.col));
  } else {
    // INPUT 态:回尾归续写位,滚动回看归内容区底(viewport 锁历史;INPUT 态无 IME 锚定需求)
    stdout.write(
      cup(
        state.scrollOffset === 0 ? state.contentRow : g.contentBottom,
        state.scrollOffset === 0 ? state.contentCol : 1
      )
    );
  }
}

/** 运行态用户是否在打字(近期有按键)——是则暂停流式物理写(contentWrite/drawStatusBar/paintLiveAtCursor 跳过物理写),光标留输入框,IME 候选窗稳定不跟流式跑。 */
export function isStreamingPaused(): boolean {
  return state.mode === 'running' && Date.now() < state.userActiveUntil;
}

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

/**
 * 内容区正文写:CUP 到续写位 + 写出 + 按字符宽度/折行更新续写位 + 同步入 content 缓冲(供滚动回看)。
 * 滚动区域内写满自动在区域内滚动,底栏在区域外不被顶。非 TTY / 未激活:直接 stdout.write(内联退化)。
 *
 * 逐字符分类(按码点取字符,SGR 序列整段识别):SGR 码 → 0 宽跟踪 + content.feedSgr;其他 CSI/OSC → 跳过
 * (callers 理论上不传);\n / 折行 / tab 换行 → 行推进 + content.breakRow;可见字符 → charWidth 跟踪 +
 * content.feedChar。SGR 在终端 0 宽,故续写位只按可见字符推进(与终端实际光标一致)。
 */
export function contentWrite(s: string): void {
  if (!state.active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  if (state.mdActive) commitMd(); // 非 md 写接续:先收尾 md 段(清 segMark,否则 setLines 会截到旧段)
  // 滚动回看时(scrollOffset>0)只喂缓冲 + 推进续写位,不物理写——否则新流式内容覆盖 viewport 历史行。
  // 回尾(scrollOffset===0)才物理写;写起点 = 当前续写位(loop 会推进续写位,故先捕获)。
  const g = getGeo();
  const cols = g.cols;
  const bottom = g.contentBottom;
  // resize 缩窄后，当前待写行可能已占满或超过新列宽。必须在捕获物理写起点前
  // 先提交该行并移到下一行；否则 CUP 会把 cols+1 钳到末列，下一字符覆盖旧行尾。
  if (state.contentCol > cols) {
    content.breakRow();
    state.contentRow = state.contentRow >= bottom ? bottom : state.contentRow + 1;
    state.contentCol = 1;
  }
  // resize 后 contentRow 可能过时(拖终端框):
  //  - 缩小:contentRow > 新 bottom → 钳到新 bottom
  //  - 放大:contentRow < 新 bottom 且回尾 → 推进到 min(committed+1, bottom)
  // committed+1 是合法「待写位」(所有行已 breakRow 提交、光标在新空行);用 committed 会把续写位拉回到
  // 最后一行 banner/content 上,首次 contentWrite 覆盖 banner(首条消息「插到 logo 下面」bug)。
  // 注意:不能用 totalRows()+1——breakRow 后 hasCurrent=true,totalRows 已含当前空行,再 +1 会多跳一行,
  // 导致 onDone 摘要行等写 \n 后的 contentWrite 入口多跳 1 行(2 空行 bug)。
  if (state.contentRow > bottom) state.contentRow = bottom;
  else if (state.scrollOffset === 0 && state.contentRow < bottom) {
    state.contentRow = Math.min(content.committedRows() + 1, bottom);
  }
  const startRow = state.contentRow;
  const startCol = state.contentCol;
  const advanceRow = (r: number): number => (r >= bottom ? bottom : r + 1); // 到底则滚动,续写位留底
  // 滚动回看冻结(仿 ink store.pushBlock 的 offset+=newLines):scrollOffset>0 时新内容只入缓冲,
  // 但缓冲增长后若 offset 不变,下次 scrollBy→repaintViewport 会取漂移窗口、把新内容画进历史视图
  // (「工具消息跳到上面覆盖」bug;滚回底又正常,因 buffer 正确)。故入缓冲前后算 totalRows 差,
  // offset += 差以冻住视图(窗口停原绝对行,无需 repaint;滚回底自显尾部新内容)。
  const scrolled = state.scrollOffset > 0;
  const totalBefore = scrolled ? content.totalRows() : 0;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    // SGR 序列 \x1B[...m:0 宽 + 喂缓冲
    const sgr = /^\x1b\[[0-9;]*m/.exec(rest);
    if (sgr) {
      content.feedSgr(sgr[0]);
      i += sgr[0].length;
      continue;
    }
    // 其他 CSI / OSC 序列(兜底跳过,不喂缓冲——callers 不该传控制码)
    if (s[i] === '\x1b') {
      const csi = /^\x1b\[[0-9;]*[A-Za-z]/.exec(rest);
      if (csi) {
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07]*(\x07|\x1b\\)/.exec(rest);
      if (osc) {
        i += osc[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (ch === '\n') {
      state.contentRow = advanceRow(state.contentRow);
      content.breakRow();
      state.contentCol = 1;
      i += ch.length;
      continue;
    }
    if (ch === '\r') {
      state.contentCol = 1;
      i += ch.length;
      continue;
    }
    if (ch === '\t') {
      const next = Math.floor((state.contentCol - 1) / 8) * 8 + 8 + 1;
      if (next > cols) {
        state.contentRow = advanceRow(state.contentRow);
        content.breakRow();
        state.contentCol = 1;
      } else state.contentCol = next;
      i += ch.length;
      continue;
    }
    const cw = charWidth(cp);
    if (cw === 0) {
      i += ch.length;
      continue; // 组合符 / 零宽:不推进
    }
    if (state.contentCol + cw - 1 > cols) {
      // 当前行放不下:折行
      state.contentRow = advanceRow(state.contentRow);
      content.breakRow();
      state.contentCol = 1;
    }
    state.contentCol += cw;
    content.feedChar(ch);
    i += ch.length;
  }
  // 跨调用 pending-wrap 提交:循环末若 contentCol>cols(末字符恰好落在最后一列,终端 pending-wrap),
  // 必须在此提交换行——否则下一 chunk 的 cup(startRow, cols+1) 被终端 clamp 到 col=cols 且 CUP 清除
  // pending,下一可打印字符会覆盖上一行末字符(「新输出插到上文中间」bug);paintLiveAtCursor 也会
  // cup 到 cols+1 并 \x1B[2K 擦掉整行。提交后模拟与终端都停在 (下一行,1)、无 pending,等价 ink 的
  // 「新输出永远在底」。代价:chunk 恰在末列结束且下一 chunk 以 \n 开头时多一个空行(cosmetic,远好于覆盖)。
  // 模拟归一化在物理写 guard 之外(滚动态也要保 buffer 自洽);物理补的 \n 在 guard 之内(滚动态/暂停态不物理写)。
  const pendingWrap = state.contentCol > cols;
  if (pendingWrap) {
    content.breakRow();
    state.contentRow = advanceRow(state.contentRow);
    state.contentCol = 1;
  }
  // 滚动回看冻结:新内容入缓冲后 offset += delta(contentWrite 只增故 ≥0;md 路径可负),钳到 [0, maxOff],
  // viewport 窗口停原绝对行(不漂移到新工具消息)。无需 repaint——窗口未变(屏仍显原历史)。
  if (scrolled) {
    const delta = content.totalRows() - totalBefore;
    if (delta !== 0) {
      const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
      state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + delta, maxOff));
    }
  }
  // 物理写(回尾 offset=0):cup 写起点 + s + (pending 时补 \n 提交换行)+ (运行态 cup 回输入框)。
  // 打字中不再暂停物理写——单次 write 结尾 cup 回 runningCaretPos(输入框),IME 锚定不动(跟踪每次 write
  // 最终位置);旧设计 isStreamingPaused 暂停写致流式卡顿,现单次写归位已无需暂停。
  if (state.scrollOffset === 0) {
    let out = cup(startRow, startCol) + s;
    if (pendingWrap) out += '\n'; // 滚动区域底行触发 DECSTBM 上滚、中段 LF 下移到 (下一行,1)
    if (state.mode === 'running') {
      const p = runningCaretPos();
      out += cup(p.row, p.col);
    }
    stdout.write(out);
  }
}

/** 进入 markdown 流式段:标记段起点(layout 续写位 + content.beginSegment),清 accumulator。 */
function beginMdSegment(): void {
  state.segmentStartRow = state.contentRow;
  content.beginSegment();
  state.mdBuf = '';
  state.mdActive = true;
}

/** 提交 markdown 段:清 accumulator + content.commitSegment(后续非 md 写不再被 setLines 截断)。 */
function commitMd(): void {
  if (!state.mdActive) return;
  state.mdActive = false;
  state.mdBuf = '';
  content.commitSegment();
}

// ── Banner(启动横幅/模式切换横幅)固定顶部行 ──
// 与 contentWrite 的「续写式追加」不同:banner 自带模式行集合(MoCode logo + 信息行),
// 反复 writeBanner(同一启动会话内同一份 banner 反复画 — 启动后、换 model 后、刷新 snapshot 后)
// 应让 buffer 顶部始终是「最新的一份 banner」,而不是堆 5 份。
// rewriteBanner 在 banner 已建好时原地等长替换顶部 bannerH 行,viewport 自动从 rows[] 头读新版。
//
// bannerH = bannerLines(banner()) 的行数(目前 5:4 行 logo+info + 1 空行分隔)。如未来
// bannerString 变化,调用方需重调 writeBanner 重设 bannerH。

/**
 * 在 content 缓冲顶部建一份 banner;**首次**调用建好(bannerH = lines.length),**重复**调用
 * 等价 rewriteBanner(lines)(覆盖式刷新,供启动后再写 banner 也安全)。
 *
 * lines 必须与首次写入等长(否则 content.replaceHead 抛错)— 调用方应统一传 bannerLines(banner())。
 * 滚动回看冻结(scrollOffset+=delta / 改 offset 不变):行数不变 offset 不动 → 视图冻结,无须 repaint 风暴。
 * 仅当 scrollOffset === 0 时 repaintViewport 让新版 banner 立刻进 viewport 顶部。
 */
export function writeBanner(lines: string[]): void {
  if (state.bannerH === 0) {
    // 首次:buffer 通常空(启动最早时),用 setLines 灌入;若 buffer 非空(如 reseed)说明 banner
    // 已被前置写过,throw 阻止静默错位 — 调用方应先 reset banner 然后 writeBanner。
    if (state.mdActive) commitMd();
    const existed = content.totalRows();
    if (existed !== 0) {
      throw new Error(
        `writeBanner: 首次调用时 buffer 已有 ${existed} 行,需先 clearContent 再 writeBanner(否则会覆盖已有内容)`
      );
    }
    content.setLines(lines);
    state.bannerH = lines.length;
    // 续写位推进到 banner 之后:clearContent 把 contentRow 归到 1,writeBanner 灌入 bannerH 行
    // 但不动 contentRow → 首次 contentWrite 会从屏行 1 写出(覆盖 banner)。这里同步修正,
    // 让首条用户消息从 banner 下方开始(与 buffer 尾部对齐)。仅首次走这条,后续 rewriteBanner 不动续写位。
    state.contentRow = Math.min(state.bannerH + 1, getGeo().contentBottom);
    state.contentCol = 1;
    if (state.scrollOffset === 0) repaintViewport();
    return;
  }
  // 后续:等价 rewriteBanner
  rewriteBanner(lines);
}

/**
 * 把 banner 顶部 bannerH 行**等长替换**为新行;banner 后的内容(对话历史)位置不动。
 * 行数与首次 writeBanner 不一致 → 抛错(避免 banner 区错位);如必须改,先清空 content 后再 writeBanner。
 * 滚动回看冻结:行数不变,offset 不动。等 scrollOffset 回到 0 时 viewport 自动显新版 banner。
 */
export function rewriteBanner(lines: string[]): void {
  if (state.bannerH === 0) {
    // 没建过 banner:等价首次 writeBanner(允许首次调用直接进 rewriteBanner 的别名入口)
    writeBanner(lines);
    return;
  }
  if (lines.length !== state.bannerH) {
    throw new Error(
      `rewriteBanner: 行数 ${lines.length} ≠ 已建 bannerH ${state.bannerH}(调用方需统一行数)`
    );
  }
  content.replaceHead(0, lines);
  if (state.scrollOffset === 0) repaintViewport();
}

/** 测试 / 调试用:当前 banner 占多少行;0 表示未启用。 */
export function bannerHeight(): number {
  return state.bannerH;
}

/**
 * markdown 正文写(替代 contentWrite 用于 agent onText):累积 chunk 到 mdBuf,每 chunk 把整段
 * mdBuf 经 renderMarkdown 渲成自洽 ANSI 行,replace 缓冲段(content.setLines 截旧 + 写新),
 * repaintViewport 重画(仅尾 offset=0 且未暂停)。流式安全:未闭合 fence 照常 emit 进行中代码块;
 * renderMarkdown 内部 memo by text 使重复渲染命中缓存。非 TTY / 未激活:直接 stdout.write(与
 * contentWrite 一致,管道流式可见)。
 *
 * 续写位 = 段末下一行(段占 lines.length 行从 segmentStartRow 起);超可视区则滚动留 contentBottom。
 * 物理重画用 repaintViewport(全内容区,原子一次 write 无闪烁)— md 段是缓冲尾,viewport 显尾即显段。
 * 滚动回看(scrollOffset>0)只更新缓冲不物理写(回尾时显);打字中照常物理写——单次 write 结尾 cup 回输入框,IME 锚定不动。
 */
export function contentWriteMd(s: string): void {
  if (!state.active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  if (!state.mdActive) beginMdSegment();
  state.mdBuf += s;
  const g = getGeo();
  // 滚动回看冻结(同 contentWrite):scrollOffset>0 时 setLines 替换段会改缓冲行数,若 offset 不变,
  // 下次 scrollBy→repaintViewport 取漂移窗口、把流式正文画进历史视图。故 setLines 前后算 totalRows 差,
  // offset += delta(可负:setLines 重渲染可能缩行)冻住视图。md 段在尾,窗口在上方,冻结后不重叠。
  const scrolled = state.scrollOffset > 0;
  const totalBefore = scrolled ? content.totalRows() : 0;
  const lines = renderMarkdown(state.mdBuf, g.cols);
  content.setLines(lines, state.mdBuf);
  const segRows = lines.length;
  const available = g.contentBottom - state.segmentStartRow + 1;
  state.contentRow = segRows >= available ? g.contentBottom : state.segmentStartRow + segRows;
  state.contentCol = 1;
  if (scrolled) {
    const delta = content.totalRows() - totalBefore;
    if (delta !== 0) {
      const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
      state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + delta, maxOff));
    }
  }
  if (state.scrollOffset === 0) {
    repaintViewport(); // 单次 write 结尾 cup 回 runningCaretPos(运行态),IME 锚输入框;打字中不再暂停
    if (state.mode === 'running') {
      const p = runningCaretPos();
      stdout.write(cup(p.row, p.col));
    }
  }
}

/**
 * 把一段完整(非流式)assistant 文本渲染进独立 markdown 段(供 renderHistory /resume /
 * /rollback 回放)。与流式 contentWriteMd 的区别是一次完成 begin/set/commit，不累积 chunk；
 * 但同样保留原始 markdown source，因此窗口列宽变化后历史正文也能重新排版。
 */
export function contentWriteMdOnce(s: string): void {
  if (!state.active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  if (state.mdActive) commitMd();
  const g = getGeo();
  content.beginSegment();
  const lines = renderMarkdown(s, g.cols);
  content.setLines(lines, s);
  content.commitSegment();
  // setLines 直接提交了全部 markdown 物理行；补回一个未提交的空当前行，保证满屏时
  // 下一次 contentWrite 从正文下一行开始，而不是在 contentBottom 第 1 列覆盖正文末行。
  content.ensureCurrentRow();
  state.contentRow = Math.min(content.committedRows() + 1, g.contentBottom);
  state.contentCol = 1;
  if (state.scrollOffset === 0) repaintViewport();
}

/** 清空内容区(保留底栏):全屏清 + 重设区域 + 续写位归 (1,1) + 清缓冲 + 回尾。底栏由调用方随后重画。 */
export function clearContent(): void {
  if (!state.active) return;
  stdout.write('\x1B[1;1H\x1B[2J');
  setRegion(state.footerH);
  state.contentRow = 1;
  state.contentCol = 1;
  state.frameRow = 0;
  state.frameCol = 0;
  state.segmentStartRow = 1;
  state.scrollOffset = 0;
  state.scrollLockUntil = 0;
  state.mdActive = false;
  state.mdBuf = '';
  // 清内容缓冲时必须同步重置 banner 状态:否则后续 writeBanner() 会走 rewriteBanner 路径,
  // 在已空的 content 上调 replaceHead(0, lines) → startIdx(0) >= committed(0) → 抛错 → REPL 退出。
  // /theme、/clear、/resume 等命令 clearContent 后紧接 writeBanner 的场景均依赖此重置。
  state.bannerH = 0;
  // 欢迎引导块随 buffer 一起清掉(/clear / /resume 等路径),状态复位后可由 repl 重新写入。
  state.welcomeStart = -1;
  state.welcomeRows = 0;
  // 清内容区必须同时作废旧菜单擦除坐标:picker(/resume /rollback /theme)把菜单画在内容区底部,
  // 菜单行号缓存在 lastMenuStartRow/lastMenuRows;若不清零,后续 paintInput 会按旧坐标“擦菜单”,
  // 把刚 renderHistory/contentWrite 写好的内容(如“已续接会话”提示)清掉,导致用户要滚动一下才刷新。
  state.lastMenuStartRow = 0;
  state.lastMenuRows = 0;
  content.reset();
  notifyContentReset(); // batch 渲染器同步重置(batch 摘要行索引全部失效)
  stdout.write(esc.home);
}

/**
 * 撤销(rewind)内容区末尾 n 物理行 —— 供 "刚 echoInput 写下用户气泡、用户撤回"
 * 把气泡从可视区与 buffer 一起拿掉。content.rewind 弹出 buffer 末 n 行;layout 这边
 * 同步上溯 contentRow(contentTop 钳位,防下溢)、scrollOffset 钳到新 totalRows、
 * 最后 repaintViewport 重画可视区(running 态回 runningCaretPos,input 态回续写位)。
 *
 * 与 clearContent 不同:只擦最近一段、保留更早内容与 buffer;光标归内容区底,
 * 不是 (1,1)。常发生在 RUNNING 态的 pending 窗口内 recall —— recall 后调用方
 * 通常再 enterInputMode 切回 INPUT 视觉,光标由后续 paintInput 重画。
 */
export function rewindContent(rowsToRewind: number): void {
  if (!state.active || rowsToRewind <= 0) return;
  content.rewind(rowsToRewind);
  const g = getGeo();
  state.contentRow = Math.max(g.contentTop, state.contentRow - rowsToRewind);
  state.contentCol = 1;
  // 钳 scrollOffset:不能让 viewport 视点超出新 totalRows
  const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
  state.scrollOffset = Math.min(state.scrollOffset, maxOff);
  // 末段 frameRow/frameCol 是 spinner 的画位,撤回若跨过 frame 行也不必清——
  // repaintViewport 会按新 buffer 重画整片,旧 frame 自然被覆盖。
  repaintViewport();
}

// ── 欢迎引导块(新会话开场)──
// 开场写在内容区(banner 之下),教用户怎么开始;首次提交任何输入(消息或斜杠命令)前
// 由 dismissWelcomeBlock 整块从 buffer 撤掉——「一打开就能看见,开始干活就消失」。

/** 写欢迎引导块(每行自洽带色、行宽须 ≤ cols,contentWrite 状态机兜底折行);已在屏上则跳过。 */
export function writeWelcomeBlock(lines: string[]): void {
  if (!state.active || !ui.isTTY || lines.length === 0) return;
  if (state.welcomeRows > 0) return; // 已在屏上,不重复写
  state.welcomeStart = content.committedRows();
  contentWrite(lines.join('\n') + '\n');
  state.welcomeRows = content.committedRows() - state.welcomeStart;
}

/** 撤掉欢迎引导块:删 buffer 区间(若已被外部清空/裁掉则只复位状态)+ 续写位前移 + 钳位重画。 */
export function dismissWelcomeBlock(): void {
  if (state.welcomeRows <= 0) return;
  const start = state.welcomeStart;
  const n = state.welcomeRows;
  state.welcomeRows = 0;
  state.welcomeStart = -1;
  if (start < 0 || start >= content.committedRows()) return; // 块已被 clear/trim,无需删
  content.deleteFrom(start, n);
  const g = getGeo();
  state.contentRow = Math.max(g.contentTop, state.contentRow - n);
  state.contentCol = 1;
  const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
  state.scrollOffset = Math.min(state.scrollOffset, maxOff);
  repaintViewport();
}

/**
 * 在绝对行索引 after 后插入自洽行(详情展开用)。
 * 滚动回看冻结:scrollOffset>0 时 offset += delta 把窗口冻在原绝对行,
 * 与 contentWrite/contentWriteMd 同模式。插入后 repaintViewport 重画 viewport。
 *
 * 续写位(contentRow):若原写头在插入点之后,前移 lines.length,保持相对位置;
 * 若原写头 ≤ after,不变(新行在写头之后)。非 TTY 直接调 content.insertAfter。
 *
 * keepViewport:鼠标点击展开时 true(视口锚定原位,详情在下方展开,屏幕不跳);
 * 子 agent 实时嵌套渲染时传 false —— 那是"新内容"而非"回看展开",必须跟随屏底,
 * 否则每插一行就把视口冻住 1 行,子 agent 跑起来后主内容区看着像卡住不动。
 */
export function contentInsertAfter(after: number, lines: string[], keepViewport = true): void {
  if (!state.active || lines.length === 0) return;
  const g = getGeo();
  const totalBefore = content.totalRows();
  const scrolled = state.scrollOffset > 0;
  content.insertAfter(after, lines);
  const delta = content.totalRows() - totalBefore;
  if (delta === 0) return;
  // 流式 md 段活跃期间:插入点在段起点之前 → segmentStartRow 平移,
  // 否则 contentWriteMd 的续写位算错,展开行被下一个 setLines 砍掉。
  if (state.mdActive && after + 1 < state.segmentStartRow) {
    state.segmentStartRow += delta;
  }
  // 续写位:原写头绝对行 = viewport 起点 + (contentRow-1) [offset=0];偏移后才一致
  if (state.scrollOffset === 0 && state.contentRow > after + 1) {
    state.contentRow = Math.min(state.contentRow + delta, g.contentBottom);
  }
  // 滚动回看冻结(同 contentWrite)
  if (scrolled) {
    state.scrollOffset = Math.max(
      0,
      Math.min(state.scrollOffset + delta, Math.max(0, content.totalRows() - g.contentBottom)),
    );
  }
  // 展开工具信息时保持视口位置:当 scrollOffset===0(未滚动)且插入点在视口内时,
  // 计算 scrollOffset 让视口锚定在插入前的绝对行位置,展开内容在下面自然展开,
  // 而不是自动跳到展开内容底部(用户体验:点击摘要行,视口不动,详情在下方展开)。
  // 关键:插入点绝对行 = after;插入前视口尾行绝对行 = totalBefore - 1;
  // 插入后要让原视口尾行仍在屏底 → scrollOffset = 插入后新增的、在原视口尾行之后的行数。
  if (keepViewport && !scrolled && after < totalBefore) {
    // 插入点在原缓冲内(非追加到末尾),计算需要滚动的偏移量
    const insertedAfterViewport = after >= (totalBefore - g.contentBottom);
    if (insertedAfterViewport) {
      // 插入点在视口内:保持视口位置,scrollOffset = 插入行数(展开内容在视口下方)
      state.scrollOffset = Math.min(delta, Math.max(0, content.totalRows() - g.contentBottom));
    }
  }
  // 必须同步平移 batch 索引。若延迟到 dynamic import.then，下一条 mutation 可能已经
  // 按插入后的 buffer 创建；旧回调会再平移它一次，导致详情插到空行之后。
  shiftBatchesAfter(after, delta);
  repaintViewport();
}

/**
 * 从绝对行索引 startIdx 起删 n 行(折叠回退用)。
 * 滚动回看冻结同 insertAfter:offset -= delta,钳 ≥ 0。续写位若在删区后前移 delta。
 */
export function contentDeleteFrom(startIdx: number, n: number): void {
  if (!state.active || n <= 0) return;
  const totalBefore = content.totalRows();
  const scrolled = state.scrollOffset > 0;
  content.deleteFrom(startIdx, n);
  const delta = totalBefore - content.totalRows();
  if (delta === 0) return;
  // 流式 md 段活跃期间:删除区间全部在段起点之前 → segmentStartRow 回退,
  // 否则 contentWriteMd 的续写位算错,段内容错位。
  if (state.mdActive && startIdx + delta <= state.segmentStartRow) {
    state.segmentStartRow = Math.max(1, state.segmentStartRow - delta);
  }
  if (state.scrollOffset === 0 && state.contentRow > startIdx + 1) {
    state.contentRow = Math.max(1, state.contentRow - delta);
  }
  if (scrolled) {
    state.scrollOffset = Math.max(0, state.scrollOffset - delta);
  }
  // batch 摘要行索引平移(用 -delta 表示后段索引前移)，同插入路径必须同步。
  shiftBatchesAfter(startIdx, -delta);
  repaintViewport();
}

/** 当前内容物理行总数(含当前未提交行)。供 batch 渲染器在 endBatch 时定位摘要行索引。 */
export function totalRows(): number {
  return content.totalRows();
}

/** 缓冲尾部(已提交行)是否已经是空白行(去掉 ANSI 后无可见字符)。
 *  供 compact 等在 step 循环顶部写通知行前判断是否需要补空行分隔。 */
export function isLastContentRowBlank(): boolean {
  const committed = content.committedRows();
  if (committed === 0) return false;
  const line = content.lineAt(committed - 1);
  if (line === null) return false;
  return line.replace(/\x1b\[[0-9;]*m/g, '').trim().length === 0;
}

/** 正文→mutation 首摘要前，把尾部间距强制归一为一条视觉空行。 */
export function normalizeMutationBoundary(): void {
  if (!state.active || !ui.isTTY) return;
  if (state.mdActive) commitMd();
  const totalBefore = content.totalRows();
  content.normalizeTrailingBlankRows(1);
  const g = getGeo();
  const delta = content.totalRows() - totalBefore;
  if (state.scrollOffset > 0 && delta !== 0) {
    state.scrollOffset = Math.max(
      0,
      Math.min(state.scrollOffset + delta, Math.max(0, content.totalRows() - g.contentBottom)),
    );
  }
  state.contentRow = Math.min(content.committedRows() + 1, g.contentBottom);
  state.contentCol = 1;
  if (state.scrollOffset === 0) repaintViewport();
}

/** 命令/Agent 输出→下一条输入气泡前，统一保留恰好一条视觉空行。 */
export function normalizeInputBoundary(): void {
  normalizeMutationBoundary();
}

/** 原地刷新一条内容行（行数不变），用于运行中的工具 batch 更新计数。 */
export function contentReplaceLine(absIdx: number, line: string): void {
  if (!state.active) return;
  // 原地更新的 batch 摘要可能随追加工具而变长。缓冲区仍把它当作一行，但若直接
  // 交给终端超过 cols，终端会自动折行，造成视觉上多出空行且续写位与缓冲失步。
  // 在写回缓冲前按 ANSI 可见宽度截断，确保“一条逻辑行 = 一条物理行”。
  content.replaceLine(absIdx, truncateAnsi(line, getGeo().cols));
  repaintViewport();
}

/** 清空内容区时通知 batch 渲染器重置(摘要行映射与展开态)。 */
export function notifyContentReset(): void {
  // 必须同步清理：clearContent() 后调用方会立即 renderHistory() 重建 batch。
  // 若异步 reset，旧清理会在回放完成后反过来抹掉新摘要的点击映射。
  resetBatches();
}

/** 把物理行索引映射到一次 reflow 之后的新索引。段内锚点按段内相对进度映射，
 * 段后的索引整体平移；用于 scroll viewport 锚点和选区在 resize 后保持语义位置。 */
function remapLineForReflow(
  line: number,
  change: content.ReflowChange,
): number {
  const oldEnd = change.start + change.oldCount;
  if (line < change.start) return line;
  if (line >= oldEnd) return Math.max(0, line + change.delta);
  if (change.newCount <= 0) return Math.max(0, change.start - 1);
  if (change.oldCount <= 1) return change.start;
  const relative = (line - change.start) / Math.max(1, change.oldCount - 1);
  return change.start + Math.round(relative * Math.max(0, change.newCount - 1));
}

/** 终端尺寸变化后更新正文布局。列宽变化时重排 markdown；仅高度变化时只重算屏幕锚点。 */
function reflowContentForResize(cols: number, colsChanged: boolean): void {
  const oldTotal = content.totalRows();
  const oldViewportStart = viewportAbsStart();
  const oldViewportEnd = Math.max(oldViewportStart, oldTotal - state.scrollOffset - 1);
  let mappedViewportEnd = oldViewportEnd;
  const changes = colsChanged ? content.reflowMarkdown(cols, renderMarkdown) : [];
  for (const change of changes) {
    shiftBatchesForReflow(change.start, change.oldCount, change.newCount);
    mappedViewportEnd = remapLineForReflow(mappedViewportEnd, change);
    if (state.selection) {
      const remapEndpoint = (line: number, col: number): { line: number; col: number } => {
        const oldEnd = change.start + change.oldCount;
        if (change.oldLines.length > 0 && line >= change.start && line < oldEnd) {
          const mapped = remapWrappedPoint(
            change.oldLines,
            change.newLines,
            { line: line - change.start, col },
          );
          return { line: change.start + mapped.line, col: mapped.col };
        }
        return { line: remapLineForReflow(line, change), col };
      };
      const anchor = remapEndpoint(state.selection.anchorLine, state.selection.anchorCol);
      const end = remapEndpoint(state.selection.endLine, state.selection.endCol);
      state.selection.anchorLine = anchor.line;
      state.selection.anchorCol = anchor.col;
      state.selection.endLine = end.line;
      state.selection.endCol = end.col;
    }
  }
  const g = getGeo();
  const total = content.totalRows();
  if (state.scrollOffset > 0) {
    // 滚动回看时保持原窗口尾部的语义锚点，不因段行数变化跳到最新内容。
    state.scrollOffset = Math.max(0, Math.min(total - mappedViewportEnd - 1, Math.max(0, total - g.contentBottom)));
  }
  state.contentRow = Math.min(content.committedRows() + 1, g.contentBottom);
  const currentRaw = content.currentRowRaw();
  state.contentCol = currentRaw === null ? 1 : ansiDisplayWidth(currentRaw) + 1;
  const activeStart = content.activeSegmentStart();
  if (activeStart !== null) {
    // segmentStartRow 始终描述“回尾视图”中的段起点；即便用户正在滚动回看，
    // 后续流式 chunk 也应继续按尾部坐标推进，不能把历史 viewport 的 offset 算进来。
    const tailViewportStart = Math.max(0, total - g.contentBottom);
    state.segmentStartRow = Math.max(1, Math.min(g.contentBottom, activeStart - tailViewportStart + 1));
  }
}

// ── viewport 滚动回看(Phase 2)──

/** 是否处于滚动回看态(offset>0,内容区显历史)。prompt 据此在非滚动键时回尾。 */
export function isScrolled(): boolean {
  return state.scrollOffset > 0;
}

/** viewport 窗口起点绝对行索引(0-based,对齐 content.sliceFromEnd 的 start)。 */
function viewportAbsStart(): number {
  const g = getGeo();
  const total = content.totalRows();
  const end = Math.max(0, total - state.scrollOffset);
  return Math.max(0, end - g.contentBottom);
}

/** 屏行(1-based,内容区内)→ 绝对缓冲行索引(0-based)。 */
function screenRowToAbsLine(row: number): number {
  return viewportAbsStart() + (row - 1);
}

/** 选区归一化(anchor/end 按阅读顺序排序为 start/end)。无选区返 null。 */
function normalizeSelection(): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
  if (!state.selection) return null;
  const a = { line: state.selection.anchorLine, col: state.selection.anchorCol };
  const b = { line: state.selection.endLine, col: state.selection.endCol };
  const aFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
  return aFirst
    ? { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col }
    : { startLine: b.line, startCol: b.col, endLine: a.line, endCol: a.col };
}

/** 给自洽带色行的显示列区间 [colStart,colEnd) 套「统一亮黄底 + 黑字」。
 *  强制重设前/背景,无视原 SGR:md 字符常带 ui.dim / ui.cyan / ui.gray 等,
 *  仅靠 SGR 7 反转对比度极弱;改用显式「亮黄底 SGR 103 + 黑前景 SGR 30」,
 *  跨终端一致。退反白用 0 清 SGR,行末 active SGR 自然续接。
 *  关键:反白 active 期间**吃掉所有行内 SGR**(不让前景色干扰)——否则
 *  行内首个 \x1B[2m(dim)/\x1B[36m(cyan)/\x1B[1m(bold) 进选区后仍生效,
 *  前景被压回原色,整片亮黄底被切割、看着「花」;直穿则带 dim 等,对比不足。
 *  反白外 SGR 直穿,保留原色。 */
const SEL_OPEN = '\x1B[30;103m'; // 30:黑前景 | 103:亮黄背景
const SEL_OFF = '\x1B[0m';       // 全清 SGR,行末 active 状态续接

function highlightRange(line: string, colStart: number, colEnd: number): string {
  if (colEnd <= colStart) return line;
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  let w = 0;
  let out = '';
  let opened = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // SGR 段:反白内直接吃,不让行内前景色进选区;反白外直穿,保留原色。
      if (opened) continue;
      out += parts[i];
      continue;
    }
    for (const ch of parts[i]) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
      if (!opened && w >= colStart && w < colEnd) {
        out += SEL_OPEN;
        opened = true;
      }
      if (opened && w >= colEnd) {
        out += SEL_OFF;
        opened = false;
      }
      out += ch;
      w += cw;
    }
  }
  if (opened) out += SEL_OFF;
  return out;
}

/**
 * 重画内容区 viewport:按 scrollOffset 取缓冲尾窗,逐行 cup+clearline+rowtext 映射到屏 1..contentBottom。
 * offset=0 即尾窗(== 实时屏,resize / 回尾时用)。清行含 contentBottom——顺带擦 WT 边距漏影(状态行重复)。
 * 有活跃选区(鼠标拖拽中)时,对选中范围套反白——纯视觉,不影响缓冲内容。
 *
 * **滚动回看 sticky banner(输入框上方固定标题的姊妹需求)**:
 * 仅在 scrollOffset > 0 时,在 viewport 第 1 行顶部叠一行横幅,显示「当前 viewport 顶上
 * 那条用户消息」的预览。用户上滑翻历史时,横幅内容随滚动到的 user→agent 对应关系变化;
 * 滑到底(offset===0)自动消失(实时屏可见,无需 banner)。满宽 padding + 底色对比反色
 * 提示「↑ 这是上方滚走的内容」,不与内容区行内 SGR 冲突。
 */
export function repaintViewport(): void {
  if (!state.active) return;
  const g = getGeo();
  const h = g.contentBottom;
  const slice = content.sliceFromEnd(state.scrollOffset, h);
  const sel = normalizeSelection();
  // viewportAbsStart() 无选区时也用:sticky banner 必须按真实窗口头算,不能降级 0(否则 banner 永不出现)。
  const absStart = viewportAbsStart();
  // sticky banner:仅 scrollOffset>0 时显示;offset=0 即实时屏,user 气泡本来就在视口内,无需 banner。
  const bannerText = state.scrollOffset > 0
    ? content.lastUserMessageBefore(absStart)
    : null;
  const BANNER_ROW = 1; // 横幅占 viewport 第 1 行(会把原第 1 行内容遮住 —— 1 行换"我在看啥"的可读性,可接受)
  let p = '';
  for (let r = 1; r <= h; r++) {
    // 缓冲中的普通行（用户气泡、工具摘要等）仍按写入时宽度保存。窗口缩窄后若原样
    // 输出会触发终端 auto-wrap，打破“一条 buffer 行 = 一条屏幕物理行”。重画时统一
    // 钳到当前列宽：宽度恢复后原内容仍在 buffer 中，可重新完整显示。
    const rawLine = slice[r - 1] ?? '';
    let line = truncateAnsi(rawLine, g.cols);
    // 用户消息是在提交时按当时 cols 填满背景的普通物理行。放宽终端后，buffer 里的
    // 尾部 reset 仍停在旧列宽，若只重画就会留下截图中的灰条短一截。识别 userBg 行并
    // 在 reset 后重新开启同一背景补齐新宽度；不改 buffer，后续缩放仍可从原文重算。
    if (rawLine.includes(ui.userBg)) {
      line = padEndAnsiBackground(line, g.cols, ui.userBg, ui.reset);
    }
    if (bannerText && r === BANNER_ROW) {
      // banner 行:满宽 userBg + ❯ + 单行截断(多行 ⏎ 折叠)+ userBg 补到底 + 底线分隔短横
      const cols = g.cols;
      const oneLine = bannerText.replace(/\s*\n\s*/g, ' ⏎ ');
      const promptW = displayWidth(BANNER_PROMPT);
      const avail = Math.max(1, cols - promptW);
      const truncated = truncateDisplayHead(oneLine, avail);
      const padCount = Math.max(0, cols - promptW - displayWidth(truncated));
      line = `${ui.userBg}${BANNER_PROMPT}${truncated}${' '.repeat(padCount)}${ui.reset}`;
    } else if (sel) {
      const absLine = absStart + r - 1;
      if (absLine >= sel.startLine && absLine <= sel.endLine) {
        const lineW = ansiDisplayWidth(line);
        const colStart = absLine === sel.startLine ? sel.startCol : 0;
        const colEnd = absLine === sel.endLine ? sel.endCol : lineW;
        line = highlightRange(line, colStart, colEnd);
      }
    }
    p += cup(r, 1) + esc.clearLine + line;
  }
  // 光标:合并进同一 write(若拆成两次 stdout.write,行写完光标会暂留 contentRow/contentBottom,
  // 流式每 chunk 调一次 → contentBottom 频繁现块状光标白块;打字第一键赶上这瞬 IME 候选气泡锚到 contentBottom)。
  // 运行态(回尾 / 滚动均)归输入框 runningCaretPos(供 IME 锚定);INPUT 态回尾归续写位 / 滚动归内容区底。
  if (state.mode === 'running') {
    const c = runningCaretPos();
    p += cup(c.row, c.col);
  } else {
    p += cup(state.scrollOffset === 0 ? state.contentRow : g.contentBottom, state.scrollOffset === 0 ? state.contentCol : 1);
  }
  stdout.write(p);
}

/** 滚动 delta 行(正=往新、负=往旧);钳 [0, max(0, total-contentBottom)];变则重画 + 刷底栏(显指示、光标回输入框)。 */
export function scrollBy(delta: number): void {
  if (!state.active) return;
  if (Date.now() < state.scrollLockUntil) return; // 轮首滚动锁:吸收发消息前后 stdin 残留滚轮事件,保 agent 输出从底部开始
  const g = getGeo();
  const total = content.totalRows();
  const maxOff = Math.max(0, total - g.contentBottom);
  const off = Math.max(0, Math.min(state.scrollOffset + delta, maxOff));
  if (off === state.scrollOffset) return;
  // 进入滚动态前清掉 spinner 内联帧:滚动态由状态行心跳兜底,内联帧若残留会卡在历史视图某行。
  if (state.scrollOffset === 0 && off > 0 && state.frameRow) {
    stdout.write(cup(Math.min(state.frameRow, g.contentBottom), state.frameCol) + esc.clearLine);
    state.frameRow = 0;
    state.frameCol = 0;
  }
  state.scrollOffset = off;
  repaintViewport();
  repaint();
}

/**
 * 滚动一格「滚轮量」(WHEEL_LINES 行):dir=+1 看更旧(等同 ↑ / PgUp),dir=-1 看更新(等同 ↓ / PgDn)。
 * 鼠标滚轮与键盘裸 ↑/↓ 共用同一入口,保证两者行为与步长恒一致。
 */
export function scrollWheel(dir: number): void {
  scrollBy(dir > 0 ? WHEEL_LINES : -WHEEL_LINES);
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

/** 从归一化选区抠出纯文本(去 ANSI,按显示列裁切,行间 \n 拼接)。越界行跳过(缓冲被 trim 等边界情况)。 */
function extractSelectionText(sel: { startLine: number; startCol: number; endLine: number; endCol: number }): string {
  const out: string[] = [];
  for (let abs = sel.startLine; abs <= sel.endLine; abs++) {
    const raw = content.lineAt(abs);
    if (raw == null) continue;
    const plain = stripAnsi(raw);
    const lineW = displayWidth(plain);
    const colStart = abs === sel.startLine ? sel.startCol : 0;
    const colEnd = abs === sel.endLine ? sel.endCol : lineW;
    out.push(sliceByDisplayCol(plain, colStart, colEnd));
  }
  return out.join('\n');
}

/** 输入框选区归一化:按 (line, col) 字典序排成 start/end。无选区返 null。 */
function normalizeInputSelection(): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
  if (!state.inputSelection) return null;
  const a = state.inputSelection.anchor;
  const b = state.inputSelection.end;
  const aFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
  return aFirst
    ? { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col }
    : { startLine: b.line, startCol: b.col, endLine: a.line, endCol: a.col };
}

/** 从归一化输入框选区抠出纯文本(lines 上不带 ANSI,直接按 display_col 切)。越界行跳到该行末尾。 */
function extractInputSelectionText(sel: { startLine: number; startCol: number; endLine: number; endCol: number }): string {
  if (!state.lastView) return '';
  const out: string[] = [];
  for (let l = sel.startLine; l <= sel.endLine; l++) {
    const raw = state.lastView.lines[l];
    if (raw == null) continue;
    const lineW = displayWidth(raw);
    const colStart = l === sel.startLine ? sel.startCol : 0;
    const colEnd = l === sel.endLine ? sel.endCol : lineW;
    out.push(sliceByDisplayCol(raw, colStart, colEnd));
  }
  return out.join('\n');
}

/** 输入框 lastView 签名:lines 数 + 每行 display_w 累加;任何键改动 lines 即变化,用作 inputSelection 失效判据。 */
function inputViewSig(view: InputView | null | undefined): string {
  if (!view) return '';
  return view.lines.length + '|' + view.lines.map((l) => displayWidth(l).toString()).join(',');
}

/** 屏行是否落在底栏输入行范围内(paintInput 的 firstInputRow..firstInputRow+inputRowsAvail-1)。 */
function isInputRow(row: number): boolean {
  const g = getGeo();
  const firstInputRow = g.contentBottom + 3 + state.planRows;
  const inputRowsAvail = Math.max(0, g.footerH - 4 - state.planRows);
  return row >= firstInputRow && row < firstInputRow + inputRowsAvail;
}

/** 右键单击输入行(未拖动的 press→release):读剪贴板 + 回调 pasteHandler 贴入。异步但不阻塞其他事件。 */
function pasteIntoInput(): void {
  if (!state.pasteHandler) return;
  const handler = state.pasteHandler;
  readClipboard()
    .then((text) => {
      if (text && state.active) handler(text);
    })
    .catch(() => {});
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
 * 把屏(行,列)反推到 (lines 行号, 行内 display_col, flatIdx, 段内显示列),
 * 算法与 setInputCursorFromClick 抽出前等价——基于 lastView 的"折行 + 滚动窗"几何,
 * 与 paintInput 的 windowInputVis 同源(startVis 同锚),保证 press/drag 落点 = 画上高亮位置。
 * 越界点(空行)→ 落末行末段末。
 */
function inputScreenToInputPos(
  screenRow: number,
  screenCol: number
): { line: number; displayCol: number; flatIdx: number; inSegVis: number } | null {
  if (!state.lastView) return null;
  const g = getGeo();
  const promptW = displayWidth(state.lastView.prompt);
  const firstInputRow = g.contentBottom + 3 + state.planRows;
  const inputRowsAvail = Math.max(0, g.footerH - 4 - state.planRows);

  // 输入框可视区的 (visRow, visCol) 屏幕坐标 → 0-based。
  // 点到可视区末行之下(空白区)→ 落到最末可视行(光标归最后一段);isInputRow 已挡可视区之上的点击。
  const visRow = Math.max(
    0,
    Math.min(screenRow - firstInputRow, Math.max(0, inputRowsAvail - 1))
  );
  // 屏幕列 (1-based SGR) → 显示列 (0-based),再扣 prompt 宽;尾点容许越界 clip 到 >=0。
  const visCol = Math.max(0, screenCol - 1 - promptW);

  // 复刻 windowInputVis 的折行 + 滚动窗(输入态, lines 全量参与)。
  // lastView.lines 在 prompt 的 redraw() 中为 dispLines()(含 chip pre 行 / chip prefix 列);
  // chip 模式下点击 chip 区域也走同一算法,与 paintInput 的视协议(段接缝除外)一致。
  const cols = Math.max(1, g.cols - promptW);
  const lineVis: string[][] = state.lastView.lines.map((l) => wrapByDisplayWidth(l, cols));
  const flat: string[] = [];
  for (const lv of lineVis) for (const r of lv) flat.push(r);
  const totalVis = flat.length;
  const maxInputRows = Math.max(1, Math.floor(g.rows * 0.4));

  // 起窗偏移:用 lastView 当前光标位置作为锚(与 paintInput 同算法)。
  let curVisLine = 0;
  {
    const clRows = lineVis[state.lastView.cursorLine] ?? [''];
    let acc = 0;
    for (let i = 0; i < clRows.length; i++) {
      const rw = displayWidth(clRows[i]);
      if (state.lastView.cursorCol <= acc + rw) {
        curVisLine = i;
        break;
      }
      acc += rw;
      curVisLine = i;
    }
  }
  let curAbs = curVisLine;
  for (let i = 0; i < state.lastView.cursorLine; i++) curAbs += lineVis[i].length;
  const startVis =
    totalVis > maxInputRows
      ? Math.max(0, Math.min(curAbs - maxInputRows + 1, totalVis - maxInputRows))
      : 0;

  // 点到可视区末行之下(空行)→ 等价"光标在最末可视行的字符串末尾"。
  if (startVis + visRow >= totalVis) {
    const lastFlatIdx = totalVis - 1;
    // 把 lastFlatIdx 反推到 (line, segInLine)
    let lastLine = 0;
    let lastSegInLine = lastFlatIdx;
    while (lastLine < lineVis.length && lastSegInLine >= lineVis[lastLine].length) {
      lastSegInLine -= lineVis[lastLine].length;
      lastLine++;
    }
    if (lastLine >= lineVis.length) {
      lastLine = lineVis.length - 1;
      lastSegInLine = lineVis[lastLine].length - 1;
    }
    // lines[lastLine] 内 display_col = 前 segInLine 段 display_w + 末段 display_w
    let inLineDisplayCol = 0;
    for (let s = 0; s <= lastSegInLine; s++) inLineDisplayCol += displayWidth(lineVis[lastLine][s] ?? '');
    return {
      line: lastLine,
      displayCol: inLineDisplayCol,
      flatIdx: lastFlatIdx,
      inSegVis: displayWidth(flat[lastFlatIdx]), // 段末
    };
  }

  // flatIdx = 点击可视段在 flat 中的绝对索引(startVis + visRow)
  const flatIdx = startVis + visRow;
  // 把 flatIdx 反推到 (line, segInLine) — line 给 paintInput 用(同 lines[cursorLine] 行号),
  // segInLine 给 prompt 做 cl/cc 反推用。
  let line = 0;
  let segInLine = flatIdx;
  while (line < lineVis.length && segInLine >= lineVis[line].length) {
    segInLine -= lineVis[line].length;
    line++;
  }
  if (line >= lineVis.length) {
    line = lineVis.length - 1;
    segInLine = lineVis[line].length - 1;
  }
  // lines[line] 内 display_col = 前 segInLine 段 display_w 累加 + 段内显示列。
  let inLineDisplayCol = 0;
  for (let s = 0; s < segInLine; s++) inLineDisplayCol += displayWidth(lineVis[line][s] ?? '');
  const seg = flat[flatIdx];
  const segW = displayWidth(seg);
  const inSeg = Math.min(visCol, segW); // 段尾点击容许越界 clip 到段末
  return {
    line,
    displayCol: inLineDisplayCol + inSeg,
    flatIdx,
    inSegVis: inSeg,
  };
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

/** 回尾(offset=0);仅当原本滚动过才重画(避免每轮 enterRunningMode 闪烁)。 */
export function resetScroll(): void {
  if (state.scrollOffset === 0) return;
  state.scrollOffset = 0;
  repaintViewport();
  repaint();
}

/** 发消息轮首短时锁住滚动:吸收 stdin 残留滚轮事件(发消息前后的滚轮惯性 / OS 缓冲延迟到达),
 *  防 resetScroll 回尾后被 onRunningKey 接到的残留事件重新滚上去——致 agent 输出进缓冲、显示在历史区。
 *  锁只挡 scrollBy(滚轮 / PgUp-PgDn);不影响 contentWrite 写屏(offset=0 时照常物理写,agent 输出从底部开始)。
 *  默认 SCROLL_LOCK_MS 后自动解锁;enterInputMode(轮末)也清锁。用户轮中后段仍可上滑(满足"输出时能看历史")。 */
export function lockScrollToBottom(ms: number = SCROLL_LOCK_MS): void {
  state.scrollLockUntil = Date.now() + ms;
}

/** 解锁(轮末 enterInputMode / 测试用)。 */
export function unlockScroll(): void {
  state.scrollLockUntil = 0;
}

/** 轮首滚动锁是否生效(测试用)。 */
export function isScrollLocked(): boolean {
  return Date.now() < state.scrollLockUntil;
}

// ── 状态行(两行式:spinner 行 + model 行)──

const STATUS_SEP = '  ';
const STATUS_SEP_W = STATUS_SEP.length;

/** 通用两段式排版:左段左端对齐 + 空格填充 + 右段右端对齐。pad 至少 1 空格防粘连。 */
function twoColumn(leftStr: string, leftW: number, rightStr: string, rightW: number, cols: number): string {
  const pad = Math.max(1, cols - leftW - rightW);
  return `${leftStr}${' '.repeat(pad)}${rightStr}`;
}

/** 上线之上那行(spinner 行):左段 = spinner 帧 + 状态文字 + 走时(全部左对齐,紧跟不分离)。
 *  右段仅在滚动回看时显历史指示(右端对齐)。
 *  示例:
 *    INPUT:     ● 空闲
 *    思考中:    ⠹ 思考中… 0.5s
 *    运行心跳:  ⠋ 生成中 0.5s
 *    滚动回看:  ● 空闲                  历史 ↑3 (PgDn 回底)  */
function composeSpinnerLine(status: StatusBarData, cols: number): string {
  const spinning = state.mode === 'running' && state.runningFrame >= 0;
  const hasSpinner = !!status.spinnerFrame;
  const scrolled = state.scrollOffset > 0;

  // 走时(仅运行态)
  const elapsed = (state.mode === 'running' && state.turnStart != null)
    ? fmtElapsed(Date.now() - state.turnStart)
    : '';

  // ── 左段:帧 + 状态 + 走时,全部紧跟 ──
  let lead: string;
  let leadW: number;

  if (scrolled) {
    // 滚动回看:左段 = 符号(● 或 心跳帧) + 状态名 + (运行态)走时;右段 = 历史指示。
    // 跟非回看态严格对齐——RUNNING 态显示走时,INPUT 态不显示,避免滚动时信息降级。
    const symbol = spinning
      ? `${ui.bold}${ui.accent}${RUNNING_FRAMES[state.runningFrame]}${ui.reset}`
      : `${ui.accent}●${ui.reset}`;
    // spinning(运行态流式中 spinner 已停,靠 turnTimer 心跳):同非滚动 spinning 分支加
    // || '生成中' fallback——流式首 token 到即 spinner.stop(),若 stop() 回调未留状态字,
    // 此处兜底不再让 lead 只剩心跳帧字符(用户误读为"左侧蒸发了")。
    const label = spinning ? (status.status || '生成中') : status.status;
    const ePart = elapsed ? ` ${ui.dim}${elapsed}${ui.reset}` : '';
    lead = `${symbol} ${ui.dim}${label}${ui.reset}${ePart}`;
    leadW = 1 + 1 + displayWidth(label) + (elapsed ? 1 + displayWidth(elapsed) : 0);
  } else if (hasSpinner) {
    // spinner 激活(思考中/执行工具…):帧 + 状态 + 走时
    const ePart = elapsed ? ` ${ui.dim}${elapsed}${ui.reset}` : '';
    lead = `${ui.bold}${ui.accent}${status.spinnerFrame}${ui.reset} ${ui.dim}${status.status}${ui.reset}${ePart}`;
    leadW = 1 + 1 + displayWidth(status.status) + (elapsed ? 1 + displayWidth(elapsed) : 0);
  } else if (spinning) {
    // 运行态心跳帧(流式输出中 / 命令态如 /rollback /compact /resume):帧 + 状态文字(优先)或生成中(兜底) + 走时
    const label = status.status || '生成中';
    const ePart = elapsed ? ` ${ui.dim}${elapsed}${ui.reset}` : '';
    lead = `${ui.bold}${ui.accent}${RUNNING_FRAMES[state.runningFrame]}${ui.reset} ${ui.dim}${label}${ui.reset}${ePart}`;
    leadW = 1 + 1 + displayWidth(label) + (elapsed ? 1 + displayWidth(elapsed) : 0);
  } else {
    // INPUT 态:● + 状态文字(无走时)
    lead = `${ui.accent}●${ui.reset} ${ui.dim}${status.status}${ui.reset}`;
    leadW = 1 + 1 + displayWidth(status.status);
  }

  // ── 右段:仅滚动回看时显历史指示 ──
  let tail = '';
  let tailW = 0;
  if (scrolled) {
    tail = t('status.history', { count: state.scrollOffset });
    tailW = displayWidth(tail);
  }
  const rightStr = tail ? `${ui.yellow}${tail}${ui.reset}` : '';
  return twoColumn(lead, leadW, rightStr, tailW, cols);
}

/** 下线之下那行(model 行):左 = 模式标识 + 本轮 token chip;右 = context + cwd,右端对齐。
 *  活跃 plan chip 不再放这里,改放 spinner 行上方的「虚拟空行」(contentBottom+1,见 drawStatusBar),
 *  既不挤 model 行,又给输入区上方留出可视分隔带。 */
function composeModelLine(status: StatusBarData, cols: number): string {
  const ctx = status.contextBar; // 已带色
  const ctxW = ansiDisplayWidth(ctx);
  // 左段:模式标识 + 切换提示(灰)+ 本轮 token chip。token chip 仅展示总量,用 mid 灰,不抢主色。
  const modeTag = status.modeTag ?? '';
  const modeColor = modeTag === 'Plan' ? ui.yellow : ui.accent;
  const modePart = modeTag ? `${modeColor}${modeTag}${ui.reset}` : '';
  const modeW = modeTag ? displayWidth(modeTag) : 0;
  // 切换提示:告诉用户怎么切模式。灰(dim)降优先级,不与 modeTag 抢色;只在有 modeTag 时出现。
  const HINT = t('status.modeSwitch');
  const hintW = modeTag ? displayWidth(HINT) : 0;
  const hintPart = modeTag ? `${ui.dim}${HINT}${ui.reset}` : '';
  const tokChip = formatTurnTokenChip(status.lastTurnUsage);
  const tokW = displayWidth(stripAnsi(tokChip));
  // 合并左段:段间留 2 空格分隔。极窄时 hint 与 chip 都可能藏掉。
  // 优先级:modeTag(必) > chip(提示累计 token,有信息量)> hint(纯说明性,窄时最先省)。
  const sepMH = modePart && (hintPart || tokChip) ? '  ' : '';
  const sepHT = (hintPart && tokChip) ? '  ' : '';
  const leftStr = `${modePart}${sepMH}${hintPart}${sepHT}${tokChip}`;
  const leftW = modeW
    + (modePart && (hintPart || tokChip) ? sepMH.length : 0)
    + hintW
    + ((hintPart && tokChip) ? sepHT.length : 0)
    + tokW;
  // 右段:实时用量 chip(仅 RUNNING)+ ctx + sep + cwd,右端对齐。cwd 按预算截断,极窄(<6)隐藏。
  // 实时 chip 放 context 进度条左侧:本轮累计 ↑prompt ↓completion,流式实时增长。
  // 任一 chip 极宽时收紧 cwd(toolbar 列挤压场景),先从 cwd 砍、再隐藏 cwd、再按 hint→chip 顺序省。
  const liveChip = state.mode === 'running' && state.liveUsage ? formatLiveUsageChip(state.liveUsage) : '';
  const liveW = displayWidth(stripAnsi(liveChip));
  const liveSepW = liveChip ? STATUS_SEP_W : 0;
  const minGap = 2;
  const cwdBudget = cols - leftW - minGap - liveW - liveSepW - ctxW - STATUS_SEP_W - 1;
  const cwd = cwdBudget >= 6 ? truncateDisplay(status.cwd, cwdBudget) : '';
  const cwdW = displayWidth(cwd);
  const rightStr = `${liveChip}${liveChip ? STATUS_SEP : ''}${ctx}${STATUS_SEP}${ui.dim}${cwd}${ui.reset}`;
  const rightW = liveW + liveSepW + ctxW + STATUS_SEP_W + cwdW;
  // 极窄:逐步降级——先藏 hint,再藏 token chip,只剩 modeTag 与右段挤。
  // 这样 80 列宽终端下 hint 和 chip 都能稳住,只 <50 列才退化到只剩 modeTag。
  if (leftW + minGap + rightW > cols) {
    // 优先藏 hint(纯说明,信息密度最低):仅留 modePart + sep + tokChip
    if (modePart && tokChip && hintPart) {
      const leftStr2 = `${modePart}${sepMH}${tokChip}`;
      const leftW2 = modeW + sepMH.length + tokW;
      if (leftW2 + minGap + rightW <= cols) {
        return twoColumn(leftStr2, leftW2, rightStr, rightW, cols);
      }
    }
    // 再藏 token chip:仅留 modePart
    if (modePart && tokChip) {
      return twoColumn(modePart, modeW, rightStr, rightW, cols);
    }
  }
  return twoColumn(leftStr, leftW, rightStr, rightW, cols);
}

/** 把本轮 token 总量格式化成 chip 文本(纯字符串,带 ANSI 色)。无 usage 返空串。
 *  显示策略:chip 信息密度有限,只显示总量 + 一个 ↻ 标记表示有 cache 命中。
 *  详细分项(↑↓ 计费/↻ 缓存/reasoning)在 turn 末 summary 行展示,不在此处展开。 */
function formatTurnTokenChip(usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } | undefined): string {
  if (!usage || !usage.totalTokens) return '';
  const n = usage.totalTokens;
  const text = n < 1000 ? `${n}` : `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  const cached = usage.cachedTokens ?? 0;
  const cacheTag = cached > 0
    ? ` ↻ ${cached < 1000 ? cached : `${(cached / 1000).toFixed(cached >= 10000 ? 0 : 1)}k`}`
    : '';
  // chip 用 mid 灰(降优先级)— 模式仍是主色
  return `${ui.dim}${text} tokens${cacheTag}${ui.reset}`;
}

/** 运行态实时用量 chip(放 context 进度条左侧):↑计费prompt(裸-cached,与轮末摘要 (↑…) 同口径)
 *  ↓completion,cache 命中带 ↻ 标记;缩写与轮末摘要 / 左侧 turn chip 同款。
 *  流式期为估算值,每步末尾 usage chunk 到达后换实测;dim 灰降优先级,不与进度条阈值警示抢色。 */
function formatLiveUsageChip(u: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string {
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`);
  const cached = u.cachedTokens ?? 0;
  const billable = Math.max(0, u.promptTokens - cached);
  const cacheTag = cached > 0 ? ` ↻ ${fmt(cached)}` : '';
  return `${ui.dim}↑ ${fmt(billable)} ↓ ${fmt(u.completionTokens)}${cacheTag}${ui.reset}`;
}

/** spinner 行上方的「虚拟空行」(contentBottom+1)。
 *  - 有活跃 plan:显「plan: <summary> ▸ N. step」整行左对齐(yellow)
 *  - 无活跃 plan:空(保留原分隔视觉,避免内容贴输入区)
 *  - 过长(> cols):始终**截断保 1 行 + "…"**,不撑高脚栏、不拆 2 行——
 *    步进式任务标题/current step 通常是自然语言,即使切「 ▸ 」拆 2 行,第 2 行也大概率仍超长
 *    (实测「第三步:实现核心业务模块。…」本身就比 cols 长),拆完依然覆盖 spinner/输入区,得不偿失。
 *    截断 + "…" 一行内永远不溢出,脚栏恒 6 行,spinner/输入/下线/model 行偏移稳定。
 *  这行在 DECSTBM 滚动区外([1, contentBottom]),稳定不滚。 */
function composePlanLines(status: StatusBarData, cols: number): string[] {
  const plan = (status.planSummary ?? '').trim();
  if (!plan) {
    state.planRows = 1;
    return [];
  }
  const w = displayWidth(stripAnsi(plan));
  if (w <= cols) {
    state.planRows = 1;
    return [`${ui.yellow}${plan}${ui.reset}`];
  }
  // 溢出:截断为 1 行 + "…" 后缀(留 1 列空间给省略号)。
  state.planRows = 1;
  return [`${ui.yellow}${truncateDisplay(plan, Math.max(1, cols - 1))}…${ui.reset}`];
}

/** 画状态行(plan 行 + spinner 行 + model 行,三行)。RUNNING 态 spinner 频繁调。
 *  行号(footerH=6 当 plan 单行;footerH=7 当 plan 撑 2 行):
 *    plan 行     = contentBottom+1          (单行)
 *    plan 第 2 行 = contentBottom+2          (双行,可选)
 *    spinner 行  = contentBottom+1+planRows  (● 空闲 / ⠹ 思考中… / etc)
 *    上线        = contentBottom+2+planRows  (画在 paintInput)
 *    输入行      = contentBottom+3+planRows
 *    下线        = contentBottom+4+planRows
 *    model 行    = rows                       (屏底:auto + ctx + cwd) */
export function drawStatusBar(status?: StatusBarData): void {
  if (!state.active || !state.base) return;
  const s = status ?? { ...state.base, status: state.statusText, spinnerFrame: state.spinnerFrame };
  const g = getGeo();
  const planLines = composePlanLines(s, g.cols);
  const planRow1 = g.contentBottom + 1;
  const spinnerRow = g.contentBottom + 1 + state.planRows;
  const modelRow = g.rows; // 屏底:model 行
  // plan 可能占 1 或 2 行(过长自动撑开);spinner/model 行随之平移。
  // 一次写入:plan 1/2 行 + spinner 行 + model 行,末尾 cup 回续写位/输入框光标。
  let planBuf = '';
  for (let i = 0; i < planLines.length; i++) {
    planBuf += cup(planRow1 + i, 1) + esc.clearLine + planLines[i];
  }
  // 计划行从 2 行降到 1 行时,清掉残留的第 2 行(撑高后回退不留尾巴)。
  if (state.planRows === 1 && g.footerH > 6) {
    planBuf += cup(planRow1 + 1, 1) + esc.clearLine;
  }
  // plan 从非空变成空(已结算为 ## Done:/ notes 里无活跃 ## Plan: 段)时,清掉残留的 plan 行 1。
  // 否则上轮渲染的「plan: 标题 (N/M) ▸ 当前步」会卡在底栏「虚拟空行」位置直到下一次重启 REPL。
  if (planLines.length === 0) {
    planBuf += cup(planRow1, 1) + esc.clearLine;
  }
  let out = planBuf +
    cup(spinnerRow, 1) + esc.clearLine + composeSpinnerLine(s, g.cols) +
    cup(modelRow, 1) + esc.clearLine + composeModelLine(s, g.cols);
  if (state.mode === 'running') {
    // 运行态(回尾 / 滚动回看均):cup 回输入框光标位(供 IME 锚定)。
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  } else {
    out += cup(state.scrollOffset === 0 ? state.contentRow : g.contentBottom, state.scrollOffset === 0 ? state.contentCol : 1);
  }
  stdout.write(out);
}

/** 更新易变状态(状态文字 + spinner 帧)并重画状态行。spinner / agent 用。 */
export function setStatus(status: string, frame?: string): void {
  state.statusText = status;
  state.spinnerFrame = frame;
  drawStatusBar();
}

/**
 * 启走时刷新计时器:RUNNING 态每 80ms 重画状态行,使 composeStatus 重算 elapsed。
 * 必要性:spinner 在首 token 到达即 stop,思考/正文流式期间状态行不再经 spinner 刷新;
 * 若走时只挂 spinner onFrame,流式那几十秒会冻住。此计时器独立续刷,与 spinner 80ms 同速,重叠幂等无妨。
 * 非 TTY 不启(active=false 时 drawStatusBar 为 no-op)。
 */
function startTurnTimer(): void {
  if (!state.active) return;
  stopTurnTimer();
  state.runningFrame = 0; // 进入运行态:启动状态行 chip 心跳(首帧立即生效)
  state.turnTimer = setInterval(() => {
    state.runningFrame = (state.runningFrame + 1) % RUNNING_FRAMES.length; // 推进心跳帧,让前导符跳动
    drawStatusBar();
  }, 80);
  state.turnTimer.unref();
}

/** 停走时计时器。enterInputMode / exitAltScreen 调;intervention 面板进入时也调(防 drawStatusBar 80ms 心跳把光标拉到 runningCaretPos,覆盖 paintInput 的正确光标位)。 */
export function stopTurnTimer(): void {
  if (state.turnTimer) {
    clearInterval(state.turnTimer);
    state.turnTimer = null;
  }
}

/** 恢复走时计时器(若 RUNNING 态)。intervention 面板退出时调,恢复状态行走时心跳。 */
export function startTurnTimerIfRunning(): void {
  if (state.active && state.mode === 'running') startTurnTimer();
}

/**
 * 在续写位画一行瞬时活动文本(spinner 帧):不进缓冲、不推进续写位,逐行 clearLine 重画。
 * 仅 TTY + offset=0(实时尾)+ 非打字暂停态时物理写屏;滚动态跳过(由状态行 spinner 兜底,且避免覆盖 viewport 历史行)。
 * 配合 clearLiveAtCursor 在 spinner 停时清掉,随后 contentWrite 的结果即写在该行(spinner 不入历史缓冲)。
 *
 * 记 frameRow/frameCol = 实际画帧位置;clearLiveAtCursor 清"这行"而非当前续写位,防续写位漂移时清错行。
 * 续写位漂移时(运行期间被某次 contentWrite 推进,罕见但 557e678 后可能)先清旧 frameRow 再画新位,避免旧帧残留。
 * 打字暂停态(isStreamingPaused)spinner 不画帧——恢复 557e678 前的 spinner 隐形行为(只关 spinner,不动 contentWrite)。
 */
export function paintLiveAtCursor(text: string): void {
  if (!state.active || !ui.isTTY || state.scrollOffset !== 0 || isStreamingPaused()) {
    // 滚动态 / 暂停态:不画新帧。但若有旧帧残留(frameRow),必须清掉——
    // 否则旧 spinner 帧停在历史视图某行,用户看到「思考中」卡在消息堆里(根因)。
    // 滚动态由状态行心跳兜底显示运行状态,不需内联帧;清完后 frameRow 归零,回尾时下一帧自然重画。
    if (state.frameRow) {
      // resize 后 contentBottom 可能缩小:清旧帧时钳 frameRow 到当前可视区,避免 cup 到屏外行
      const g = getGeo();
      const fr = Math.min(state.frameRow, g.contentBottom);
      let out = cup(fr, state.frameCol) + esc.clearLine;
      if (state.mode === 'running') {
        const p = runningCaretPos();
        out += cup(p.row, p.col);
      }
      stdout.write(out);
      state.frameRow = 0;
      state.frameCol = 0;
    }
    return;
  }
  // resize 后 contentRow 可能过时(拖终端框):
  //  - 缩小:contentRow > 新 bottom → 钳到新 bottom
  //  - 放大:contentRow < 新 bottom 且回尾 → 推进到 min(total+1, bottom)(内容末尾或新区底)
  //    total+1 是合法「待写位」(breakRow 后光标在新空行);用 total 会把续写位拉回最后一行,
  //    首次 contentWrite 覆盖 banner(首条消息「插到 logo 下面」bug)。
  // 否则 cup 到旧行号→帧画在屏幕中间(旧 bottom 位置),而非内容末尾/最底部。
  const g = getGeo();
  const committed = content.committedRows();
  if (state.contentRow > g.contentBottom) state.contentRow = g.contentBottom;
  if (state.scrollOffset === 0 && state.contentRow < g.contentBottom) {
    // 用 committed+1 而非 total+1:breakRow 后 hasCurrent=true,totalRows 已含当前空行,+1 会多跳一行
    // (contentWrite 入口的同类逻辑已同步修正,见上方注释)。
    state.contentRow = Math.min(committed + 1, g.contentBottom);
  }
  let out = '';
  if (state.frameRow && (state.frameRow !== state.contentRow || state.frameCol !== state.contentCol)) {
    // 清旧帧同样钳到可视区(resize 后 frameRow 可能 > contentBottom)
    out += cup(Math.min(state.frameRow, g.contentBottom), state.frameCol) + esc.clearLine; // 续写位漂移:先清旧帧行,否则残留
  }
  out += cup(state.contentRow, state.contentCol) + esc.clearLine + text;
  if (state.mode === 'running') {
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  }
  stdout.write(out);
  state.frameRow = state.contentRow;
  state.frameCol = state.contentCol;
}

/** 清掉 paintLiveAtCursor 画过的那行瞬时活动文本。清"实际画过的位置"(frameRow),非当前续写位。
 *  不加 isStreamingPaused 守卫——stop 时必须无条件清(只写一次、结尾 cup 回输入框,不扰 IME);否则打字中 stop 会跳过清帧、制造泄漏。
 *  滚动态(scrollOffset≠0)也必须清残留帧——否则旧 spinner 帧卡在历史视图某行(「思考中在消息堆里」根因)。 */
export function clearLiveAtCursor(): void {
  if (!state.active || !ui.isTTY) return;
  if (!state.frameRow) return; // 没画过就不清(避免误清当前续写位内容)
  // 滚动态也清:旧帧不该残留。清"画过的行"(frameRow),回尾后该行由 repaintViewport 重画历史内容。
  // resize 后 contentBottom 可能缩小:frameRow 钳到可视区,避免 cup 到屏外行清错位置。
  const g = getGeo();
  let out = cup(Math.min(state.frameRow, g.contentBottom), state.frameCol) + esc.clearLine;
  if (state.mode === 'running') {
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  }
  stdout.write(out);
  state.frameRow = 0;
  state.frameCol = 0;
}

/** 推送 / 清空运行态实时 token 用量(agent core 流式推送;repl 轮末清 undefined)。
 *  不触发重画:RUNNING 态 turnTimer 80ms 心跳重画状态行,自然取到最新值。 */
export function setLiveUsage(u: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } | undefined): void {
  state.liveUsage = u;
}

/** 更新状态行基线(模型 / context / cwd / 模式标识 / 活跃 plan chip / 本轮 token chip)。repl 在轮次边界与切模式时调。 */
export function setStatusBase(b: {
  model: string;
  contextBar: string;
  cwd: string;
  modeTag?: string;
  planSummary?: string;
  lastTurnUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}): void {
  state.base = b;
}

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
