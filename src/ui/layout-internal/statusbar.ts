// L1 状态栏:两行式底栏(spinner 行 + model 行)的拼装与绘制、走时心跳。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { stdout } from 'node:process';
import { displayWidth, truncateDisplay, ansiDisplayWidth, fmtElapsed, fmtCompactTokens, stripAnsi } from '../render.js';
import { ui } from '../theme.js';
import * as content from '../content.js';
import { t } from '../../i18n/index.js';
import type { StatusBarData, PlanStepView } from '../layout-types.js';
import { state } from './state.js';
import { esc, cup, getGeo, setRegion, runningCaretPos, isStreamingPaused } from './screen.js';

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

  // 排队下一跳:紧跟「● 状态(+走时)」右侧显示,运行中持续可见,当前任务结束即自动发送。
  const queued = queuedChip();
  if (queued) {
    lead += `  ${queued.str}`;
    leadW += 2 + queued.w;
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
  // modeHint 可覆盖(空串=不显示):没有模式切换的入口(supervisor)不该提示一个按了没反应的键。
  const HINT = status.modeHint ?? t('status.modeSwitch');
  const hintW = modeTag ? displayWidth(HINT) : 0;
  const hintPart = modeTag ? `${ui.dim}${HINT}${ui.reset}` : '';
  // P3 effort chip:非 auto 时显示,与 modeTag 同级色(运行时状态),优先级在 hint 之上。
  const effortTag = status.effort ?? '';
  // 闪电标识按强度递增:low=1 / medium=2 / high=3,off=0;⚡ 宽度在 charWidth 按 2 格算,
  // 与终端一致,不会再与右侧内容重叠产生残影。标签(low/medium/high)紧随其后明示档位。
  const boltCount = effortTag === 'low' ? 1 : effortTag === 'medium' ? 2 : effortTag === 'high' ? 3 : 0;
  const bolts = '⚡'.repeat(boltCount);
  const effortPart = effortTag ? `${modeColor}${bolts}${effortTag}${ui.reset}` : '';
  const effortW = effortTag ? displayWidth(bolts) + displayWidth(effortTag) : 0;
  const sepME = modePart && effortPart ? STATUS_SEP : '';
  const tokChip = formatTurnTokenChip(status.lastTurnUsage);
  const tokW = displayWidth(stripAnsi(tokChip));
  // 合并左段:段间留 2 空格分隔。极窄时 hint 与 chip 都可能藏掉。
  // 优先级:modeTag(必) > chip(提示累计 token,有信息量)> hint(纯说明性,窄时最先省)。
  const sepMH = (modePart || effortPart) && (hintPart || tokChip) ? '  ' : '';
  const sepHT = hintPart && tokChip ? '  ' : '';
  const leftStr = `${modePart}${sepME}${effortPart}${sepMH}${hintPart}${sepHT}${tokChip}`;
  const leftW =
    modeW +
    (sepME ? sepME.length : 0) +
    effortW +
    ((modePart || effortPart) && (hintPart || tokChip) ? sepMH.length : 0) +
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
      const leftStr2 = `${modePart}${sepME}${effortPart}${effortPart ? STATUS_SEP : ''}${tokChip}`;
      const leftW2 = modeW + (sepME ? sepME.length : 0) + effortW + (effortPart ? STATUS_SEP_W : 0) + tokW;
      if (leftW2 + minGap + rightW <= cols) {
        return twoColumn(leftStr2, leftW2, rightStr, rightW, cols);
      }
    }
    // 再藏 token chip:仅留 modePart
    if ((modePart || effortPart) && tokChip) {
      return twoColumn(
        `${modePart}${sepME}${effortPart}`,
        modeW + (sepME ? sepME.length : 0) + effortW,
        rightStr,
        rightW,
        cols,
      );
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
  const text = fmtCompactTokens(n);
  const cached = usage.cachedTokens ?? 0;
  const cacheTag = cached > 0 ? ` ↻ ${fmtCompactTokens(cached)}` : '';
  // chip 用 mid 灰(降优先级)— 模式仍是主色
  return `${ui.dim}${text} tokens${cacheTag}${ui.reset}`;
}

/** 运行态实时用量 chip(放 context 进度条左侧):↑计费prompt(裸-cached,与轮末摘要 (↑…) 同口径)
 *  ↓completion,cache 命中带 ↻ 标记;缩写与轮末摘要 / 左侧 turn chip 同款。
 *  流式期为估算值,每步末尾 usage chunk 到达后换实测;dim 灰降优先级,不与进度条阈值警示抢色。 */
function formatLiveUsageChip(u: { promptTokens: number; completionTokens: number; cachedTokens?: number }): string {
  const fmt = fmtCompactTokens;
  const cached = u.cachedTokens ?? 0;
  const billable = Math.max(0, u.promptTokens - cached);
  const cacheTag = cached > 0 ? ` ↻ ${fmt(cached)}` : '';
  return `${ui.dim}↑ ${fmt(billable)} ↓ ${fmt(u.completionTokens)}${cacheTag}${ui.reset}`;
}

/** plan chip 步骤行的缩进(箭头 1 + 空格 1,步骤行对齐到摘要标题之后两列)。 */
const PLAN_STEP_INDENT = '  ';

/** 判断屏幕行是否落在 plan chip 占用的脚栏行(contentBottom+1 .. +planRows)。鼠标命中用。 */
export function isPlanRow(screenRow: number): boolean {
  if (!state.active || !state.base?.planSummary) return false;
  const g = getGeo();
  return screenRow >= g.contentBottom + 1 && screenRow <= g.contentBottom + state.planRows;
}

/** 按显示宽度贪心折行(优先在空格断,宽字符/CJK 整字不拆)。plan 步骤详情用;纯展示,不处理 ANSI。 */
function wrapDisplayText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  let lastSpace = -1; // line 内最后一个空格的 code-unit 下标
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    if (line && displayWidth(line) + displayWidth(ch) > width) {
      if (lastSpace > 0) {
        out.push(line.slice(0, lastSpace));
        line = line.slice(lastSpace + 1);
      } else {
        out.push(line);
        line = '';
      }
      lastSpace = -1;
    }
    if (ch === ' ') {
      if (line) {
        lastSpace = line.length;
        line += ch;
      }
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * spinner 行上方的「虚拟空行」(contentBottom+1)。
 *  - 有活跃 plan 且折叠:显「▸ plan: <summary> (N/M) ▸ 当前步」整行(yellow),过长截 1 行 + "…"
 *  - 有活跃 plan 且展开(点击标题行切换):首行「▾ plan: <标题> (N/M)」,下面逐行列全部步骤
 *    「✓ N. label」(完成,dim green)/「▸ N. label」(当前,accent)/「· N. label」(待办,dim);
 *    步骤带 detail 时行尾加 ▸ 提示可点,点击该步在下方缩进展开详情(dim,按宽折行),再点收起。
 *    总行数按脚栏剩余高度(maxRows)钳制,放不下时末行显「… 还有 K 步」。
 *  - 无活跃 plan:空(保留原分隔视觉,避免内容贴输入区)
 *  脚栏高度 = 5 + 输入行 + (planRows-1),spinner/输入/下线/model 行偏移稳定。
 *  这组行在 DECSTBM 滚动区外([1, contentBottom]),稳定不滚。
 *  副作用:重建 state.planRowStep(行→步骤号映射,鼠标点击路由用)。
 * @param maxRows plan 区域允许占用的最大行数;不传时按屏幕高度保守钳(只防顶到屏顶)。
 */
export function composePlanLines(status: StatusBarData, cols: number, maxRows?: number): string[] {
  const plan = (status.planSummary ?? '').trim();
  if (!plan) {
    state.planRows = 1;
    state.planExpanded = false;
    state.planStateKey = undefined;
    state.planRowStep = [];
    return [];
  }
  // plan 身份变化(新计划 / 结算后新计划):自动收起展开态并清空步骤详情展开集,
  // 避免把旧计划的多行展开套到新计划上。
  if (status.planKey !== state.planStateKey) {
    state.planStateKey = status.planKey;
    state.planExpanded = false;
    state.planOpenSteps.clear();
  }
  const collapsedLine = (caret: string): string => {
    const w = displayWidth(stripAnsi(plan)) + 2; // 箭头 + 空格
    // 颜色必须套在 plan 文本上且在 caret 之后:caret 自带 reset,若 yellow 放在
    // caret 前面会被它清掉,plan 文本就裸奔成默认白(展开态首行尤明显)。
    if (w <= cols) return `${caret} ${ui.yellow}${plan}${ui.reset}`;
    return `${caret} ${ui.yellow}${truncateDisplay(plan, Math.max(1, cols - 3))}…${ui.reset}`;
  };
  if (!state.planExpanded) {
    state.planRows = 1;
    state.planRowStep = [null];
    return [collapsedLine(`${ui.dim}▸${ui.reset}`)];
  }
  // ── 展开态:标题行 + 每步一行 + 点开的步骤渲染详情(钳高)──
  const steps = status.planSteps ?? [];
  // 不传 maxRows(drawStatusBar 路径):按屏幕高度保守钳,至少 2 行(标题 + 1 步);
  // 传了(paintInput 路径,已知脚栏预算):精确钳,保证不覆盖 spinner/输入区。
  const cap = Math.max(2, maxRows ?? Math.max(2, getGeo().rows - 5 - state.inputRows));
  const header = collapsedLine(`${ui.accent}▾${ui.reset}`);
  const lines = [header];
  state.planRowStep = [null];
  // 详情详情宽 = 减去详情缩进 4 列;先算好每个点开步骤的详情折行,供预算裁剪。
  const detailIndent = '    ';
  const detailOf = new Map<number, string[]>();
  for (const s of steps) {
    if (s.detail && state.planOpenSteps.has(s.no)) {
      detailOf.set(
        s.no,
        wrapDisplayText(s.detail, Math.max(8, cols - displayWidth(detailIndent))).map(
          (l) => `${detailIndent}${ui.dim}${l}${ui.reset}`,
        ),
      );
    }
  }
  // 有步骤被裁掉时,末行要留给「… 还有 K 步」指示:先按「全部装得下」试探,
  // 装不下则预扣 1 行给指示,再走一遍裁剪(保证 planRows ≤ cap)。
  let budget = cap - 1;
  const fits = (b: number): { visible: typeof steps; hidden: number } => {
    let left = b;
    const vis: typeof steps = [];
    let hidden = 0;
    for (const s of steps) {
      const need = 1 + (detailOf.get(s.no)?.length ?? 0);
      if (need <= left) {
        vis.push(s);
        left -= need;
      } else {
        hidden = steps.length - vis.length;
        break;
      }
    }
    return { visible: vis, hidden };
  };
  let { visible, hidden } = fits(budget);
  if (hidden > 0 && visible.length > 0) {
    // 预扣指示行后重裁;若连一个步骤都装不下(极端矮终端),放弃指示行保步骤。
    const retry = fits(budget - 1);
    if (retry.visible.length > 0) {
      visible = retry.visible;
      hidden = retry.hidden;
      budget -= 1;
    }
  }
  for (const s of visible) {
    const mark = s.done ? `${ui.green}✓${ui.reset}` : s.current ? `${ui.accent}▸${ui.reset}` : `${ui.dim}·${ui.reset}`;
    // 前缀 = 缩进2 + 标记1 + 空格1 + "N. "(编号位数 + 2);label 吃掉剩余列,保证整行不 wrap。
    const prefixW = displayWidth(PLAN_STEP_INDENT) + 1 + 1 + String(s.no).length + 2;
    const open = detailOf.has(s.no);
    const hasDetail = s.detail != null && s.detail !== '';
    // 行尾可展开提示:有详情未展开 ▸ / 已展开 ▾(与标题行的箭头语义一致)。
    const endCaret = !hasDetail ? '' : open ? ` ${ui.dim}▾${ui.reset}` : ` ${ui.dim}▸${ui.reset}`;
    const labelW = Math.max(1, cols - prefixW - (hasDetail ? 2 : 0));
    const label = truncateDisplay(s.label, labelW);
    const color = s.done ? ui.dim : s.current ? ui.yellow : ui.dim;
    lines.push(`${PLAN_STEP_INDENT}${mark} ${color}${s.no}. ${label}${ui.reset}${endCaret}`);
    state.planRowStep.push(s.no);
    const d = detailOf.get(s.no);
    if (d) {
      lines.push(...d);
      for (let i = 0; i < d.length; i++) state.planRowStep.push(s.no); // 点详情行=再点收起
    }
  }
  if (hidden > 0) {
    lines.push(`${PLAN_STEP_INDENT}${ui.dim}… ${t('status.planMoreSteps', { count: hidden })}${ui.reset}`);
    state.planRowStep.push(null); // 指示行不可点
  }
  // 极端情况下 steps 为空(数据缺失):只有标题行,仍能点击收起。
  state.planRows = Math.max(1, lines.length);
  return lines;
}

/** plan 区域高度变化(展开/收起/结算)后的全幅重排回调,由 core.ts 注入
 *  (paintInput 同步重设 DECSTBM + 重画脚栏):statusbar 不能静态 import input-paint(循环依赖),
 *  也不能用动态 import——异步窗口内 80ms 心跳会按新 planRows + 旧 footerH 画错行。 */
let planRelayout: (() => void) | null = null;
export function setPlanRelayoutHandler(fn: (() => void) | null): void {
  planRelayout = fn;
}

/** 切换 plan chip 展开/收起(鼠标点击标题行)。无活跃 plan / 无步骤数据时 no-op。
 *  经注入的同步回调重设区域并重画整个脚栏;回调缺失时退化为 drawStatusBar。
 *  收起时保留 planOpenSteps(重新展开还原各步详情展开状态),换计划才清空。 */
export function togglePlanExpanded(): void {
  if (!state.active || !state.base?.planSummary) return;
  if (!state.planExpanded && !(state.base.planSteps && state.base.planSteps.length > 0)) return;
  state.planExpanded = !state.planExpanded;
  if (state.lastView && planRelayout) planRelayout();
  else drawStatusBar();
}

/** 切换单个步骤的详情展开/收起(鼠标点击步骤行/详情行)。无详情数据时 no-op。 */
export function togglePlanDetail(stepNo: number): void {
  if (!state.active || !state.planExpanded) return;
  const step = state.base?.planSteps?.find((s) => s.no === stepNo);
  if (!step?.detail) return; // 无详情可看,点了也不给反应
  if (state.planOpenSteps.has(stepNo)) state.planOpenSteps.delete(stepNo);
  else state.planOpenSteps.add(stepNo);
  if (state.lastView && planRelayout) planRelayout();
  else drawStatusBar();
}

/** 画状态行(plan 行 + spinner 行 + model 行)。RUNNING 态 spinner 频繁调。
 *  行号(footerH=5+inputRows+planRows-1):
 *    plan 行 1..N = contentBottom+1 .. +planRows (折叠 1 行;展开 = 标题 + 步骤行)
 *    spinner 行  = contentBottom+1+planRows  (● 空闲 / ⠹ 思考中… / etc)
 *    上线        = contentBottom+2+planRows  (画在 paintInput)
 *    输入行      = contentBottom+3+planRows
 *    下线        = contentBottom+4+planRows
 *    model 行    = rows                       (屏底:auto + ctx + cwd) */
export function drawStatusBar(status?: StatusBarData): void {
  if (!state.active || !state.base) return;
  // 覆盖层(composer)打开中照常刷底栏:弹窗只占内容区(2..contentBottom-1),底栏行在其外不冲突;
  // 仅末尾光标归位改为弹窗自报位(见下),防 80ms 心跳把弹窗光标拽到底栏输入框。
  const s = status ?? { ...state.base, status: state.statusText, spinnerFrame: state.spinnerFrame };
  const g0 = getGeo();
  const planLines = composePlanLines(s, g0.cols);
  // planRows 与当前 footerH 不符(plan 在运行中被结算/换新,composePlanLines 自动收起展开态等):
  // 心跳路径不会走 paintInput 的 setRegion,这里重设区域并交回调全幅重排(含被吃掉/归还的内容末行),
  // 不能只画 spinner/model——旧上分隔线、输入行会残留在新行位。
  const needFooterH = 5 + state.inputRows + (state.planRows - 1);
  if (needFooterH !== g0.footerH) {
    setRegion(needFooterH);
    planRelayout?.();
    return;
  }
  const g = getGeo();
  const planRow1 = g.contentBottom + 1;
  const spinnerRow = g.contentBottom + 1 + state.planRows;
  const modelRow = g.rows; // 屏底:model 行
  // 一次写入:plan 各行 + spinner 行 + model 行,末尾 cup 回续写位/输入框光标。
  let planBuf = '';
  for (let i = 0; i < planLines.length; i++) {
    planBuf += cup(planRow1 + i, 1) + esc.clearLine + planLines[i];
  }
  // 上轮 plan 占的行数比本轮多(步骤变少,展开态被钳短):清掉本轮不再使用的残留行,不留尾巴。
  for (let r = planRow1 + planLines.length; r < spinnerRow; r++) {
    planBuf += cup(r, 1) + esc.clearLine;
  }
  // plan 从非空变成空(已结算为 ## Done:/ notes 里无活跃 ## Plan: 段)时,清掉残留的 plan 行 1。
  // 否则上轮渲染的「plan: 标题 (N/M) ▸ 当前步」会卡在底栏「虚拟空行」位置直到下一次重启 REPL。
  if (planLines.length === 0) {
    // 无 plan 但有待发附件:同一行位置画附件脚栏(不进内容缓冲,见 setPendingAttachChips)。
    planBuf += cup(planRow1, 1) + esc.clearLine + composePendingAttachLine(g.cols);
  }
  let out =
    planBuf +
    cup(spinnerRow, 1) +
    esc.clearLine +
    composeSpinnerLine(s, g.cols) +
    cup(modelRow, 1) +
    esc.clearLine +
    composeModelLine(s, g.cols);
  if (state.overlayActive) {
    // 覆盖层打开中:光标还给弹窗自报位(未报/光标滚出可视区时不归位,由弹窗下次 paint 自行定位)
    if (state.overlayCaret) out += cup(state.overlayCaret.row, state.overlayCaret.col);
  } else if (state.mode === 'running') {
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
 * 更新待发附件脚栏行(repl 的 pendingAttachments 真相源 → 脚栏虚拟空行)。
 * 只写 state,不主动重画——调用方随后的 paintInput/drawStatusBar 自然带上。
 * @param chips    已带色 chip(可含降采样 badge),多个两空格分隔
 * @param warning  已带色的行级警告(如非视觉模型预警),拼在 chip 末尾
 */
export function setPendingAttachChips(chips: string[], warning = ''): void {
  state.pendingAttachChips = chips;
  state.pendingAttachWarning = warning;
}

/**
 * 拼待发附件脚栏行(chips + 行级警告),整体截到列宽;无附件返回空串。
 * paintInput 与 drawStatusBar 共用,保证两条重画路径输出一致。
 */
export function composePendingAttachLine(cols: number): string {
  if (state.pendingAttachChips.length === 0) return '';
  const warning = state.pendingAttachWarning ? `  ${state.pendingAttachWarning}` : '';
  return truncateDisplay(`${ui.dim}${state.pendingAttachChips.join('  ')}${ui.reset}${warning}`, Math.max(1, cols));
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
  if (state.overlayActive) return; // 覆盖层(composer)打开中:不画帧(否则 80ms 心跳覆盖弹窗、抢光标)
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
  if (state.overlayActive) {
    // 覆盖层打开中:帧不在缓冲里,关闭后 repaintViewport 整幅重画自然抹掉;此处不写屏,只清记录
    state.frameRow = 0;
    state.frameCol = 0;
    return;
  }
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

/**
 * 设置/清除运行态已排队消息 chip(显示在 `● 状态` 右侧)。
 * text = 队首(第一条/下一条待自动发送)预览,多条排队时保持展示第一条不变;
 * count = 排队总条数(>1 显示「×N」)。立即重画一次保证入队瞬间可见;之后 80ms 心跳会自然带上。
 */
export function setQueuedTurn(text: string | undefined, mode?: string, count = 1): void {
  state.queuedText = text;
  state.queuedMode = mode;
  state.queuedCount = count;
  drawStatusBar();
}

/** 排队 chip:▸ 排队[ ×N] · <第一条首行…>（Plan)。只拼左段,宽度另计(不含 ANSI)。 */
function queuedChip(): { str: string; w: number } | null {
  const raw = state.queuedText;
  if (!raw) return null;
  const firstLine = raw.split('\n')[0] ?? '';
  const preview = truncateDisplay(firstLine.trim(), 32);
  const modeTag = state.queuedMode === 'plan' ? t('status.queuePlanTag') : '';
  const label = state.queuedCount > 1 ? t('status.queuedCount', { count: state.queuedCount }) : t('status.queued');
  const plain = `${label} ${preview}${modeTag}`;
  const str = `${ui.yellow}▸ ${plain}${ui.reset}`;
  return { str, w: 2 + displayWidth(plain) };
}

/** 更新状态行基线(模型 / context / cwd / 模式标识 / 活跃 plan chip / 本轮 token chip)。repl 在轮次边界与切模式时调。 */
export function setStatusBase(b: {
  model: string;
  contextBar: string;
  cwd: string;
  modeTag?: string;
  /** 覆盖 modeTag 右侧的切换提示；空串=不显示（没有模式切换的入口用）。 */
  modeHint?: string;
  effort?: string;
  planSummary?: string;
  planKey?: string;
  planSteps?: PlanStepView[];
  lastTurnUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}): void {
  state.base = b;
}
