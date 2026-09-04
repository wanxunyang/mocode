// L1 状态栏:两行式底栏(spinner 行 + model 行)的拼装与绘制、走时心跳。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { stdout } from 'node:process';
import { displayWidth, truncateDisplay, ansiDisplayWidth, fmtElapsed, stripAnsi } from '../render.js';
import { ui } from '../theme.js';
import * as content from '../content.js';
import { t } from '../../i18n/index.js';
import type { StatusBarData } from '../layout-types.js';
import { state } from './state.js';
import { esc, cup, getGeo, runningCaretPos, isStreamingPaused } from './screen.js';

const RUNNING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
export function composeSpinnerLine(status: StatusBarData, cols: number): string {
  const spinning = state.mode === 'running' && state.runningFrame >= 0;
  const hasSpinner = !!status.spinnerFrame;
  const scrolled = state.scrollOffset > 0;

  // 走时(仅运行态)
  const elapsed = state.mode === 'running' && state.turnStart != null ? fmtElapsed(Date.now() - state.turnStart) : '';

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
    const label = spinning ? status.status || '生成中' : status.status;
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
export function composeModelLine(status: StatusBarData, cols: number): string {
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
  const sepHT = hintPart && tokChip ? '  ' : '';
  const leftStr = `${modePart}${sepMH}${hintPart}${sepHT}${tokChip}`;
  const leftW =
    modeW +
    (modePart && (hintPart || tokChip) ? sepMH.length : 0) +
    hintW +
    (hintPart && tokChip ? sepHT.length : 0) +
    tokW;
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
function formatTurnTokenChip(
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } | undefined,
): string {
  if (!usage || !usage.totalTokens) return '';
  const n = usage.totalTokens;
  const text = n < 1000 ? `${n}` : `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  const cached = usage.cachedTokens ?? 0;
  const cacheTag =
    cached > 0 ? ` ↻ ${cached < 1000 ? cached : `${(cached / 1000).toFixed(cached >= 10000 ? 0 : 1)}k`}` : '';
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
export function composePlanLines(status: StatusBarData, cols: number): string[] {
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
  let out =
    planBuf +
    cup(spinnerRow, 1) +
    esc.clearLine +
    composeSpinnerLine(s, g.cols) +
    cup(modelRow, 1) +
    esc.clearLine +
    composeModelLine(s, g.cols);
  if (state.mode === 'running') {
    // 运行态(回尾 / 滚动回看均):cup 回输入框光标位(供 IME 锚定)。
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  } else {
    out += cup(
      state.scrollOffset === 0 ? state.contentRow : g.contentBottom,
      state.scrollOffset === 0 ? state.contentCol : 1,
    );
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
export function startTurnTimer(): void {
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
export function setLiveUsage(
  u: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } | undefined,
): void {
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
