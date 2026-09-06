// L3 内容写入:续写位状态机 / markdown 流式段 / banner / 欢迎块 / resize 重排。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { stdout } from 'node:process';
import { charWidth, truncateAnsi, ansiDisplayWidth, remapWrappedPoint } from '../render.js';
import { ui } from '../theme.js';
import * as content from '../content.js';
import { reset as resetBatches, shiftBatchesAfter, shiftBatchesForReflow } from '../batch.js';
import { renderMarkdown } from '../markdown.js';
import { state } from './state.js';
import { esc, cup, getGeo, setRegion, runningCaretPos } from './screen.js';
import { viewportAbsStart, repaintViewport } from './scroll.js';

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
        `writeBanner: 首次调用时 buffer 已有 ${existed} 行,需先 clearContent 再 writeBanner(否则会覆盖已有内容)`,
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
    throw new Error(`rewriteBanner: 行数 ${lines.length} ≠ 已建 bannerH ${state.bannerH}(调用方需统一行数)`);
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
    const insertedAfterViewport = after >= totalBefore - g.contentBottom;
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
  // 空缓冲(turn 首工具且此前无任何内容)不归一:normalizeTrailingBlankRows 会凭空
  // push 一条空行,导致屏顶多一条空白(首条摘要前多一空行)。
  if (content.committedRows() === 0 && content.currentRowRaw() === null) return;
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
function remapLineForReflow(line: number, change: content.ReflowChange): number {
  const oldEnd = change.start + change.oldCount;
  if (line < change.start) return line;
  if (line >= oldEnd) return Math.max(0, line + change.delta);
  if (change.newCount <= 0) return Math.max(0, change.start - 1);
  if (change.oldCount <= 1) return change.start;
  const relative = (line - change.start) / Math.max(1, change.oldCount - 1);
  return change.start + Math.round(relative * Math.max(0, change.newCount - 1));
}

/** 终端尺寸变化后更新正文布局。列宽变化时重排 markdown；仅高度变化时只重算屏幕锚点。 */
export function reflowContentForResize(cols: number, colsChanged: boolean): void {
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
          const mapped = remapWrappedPoint(change.oldLines, change.newLines, { line: line - change.start, col });
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
