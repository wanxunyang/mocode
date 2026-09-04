// L2 滚动与 viewport:回看偏移 / 重画可视区 / 滚轮 / 轮首滚动锁。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { stdout } from 'node:process';
import { displayWidth, truncateDisplayHead, truncateAnsi, ansiDisplayWidth, padEndAnsiBackground } from '../render.js';
import { ui } from '../theme.js';
import * as content from '../content.js';
import { state } from './state.js';
import { esc, cup, getGeo, runningCaretPos } from './screen.js';
import { normalizeSelection, highlightRange } from './selection.js';
import { repaint } from './input-paint.js';

// ── 纯常量(可变运行态在 state.ts)──
const SCROLL_LOCK_MS = 400; // 锁时长:覆盖 OS 缓冲残留 + 常规滚轮惯性;LLM TTFB 多 >200ms,不影响轮中后段滚动

/** Sticky banner 的 ❯ 前缀(同 repl 的 PROMPT;常量统一视觉)。 */
const BANNER_PROMPT = '❯ ';

export const WHEEL_LINES = 3; // 滚轮每格滚动行数

// ── viewport 滚动回看(Phase 2)──

/** 是否处于滚动回看态(offset>0,内容区显历史)。prompt 据此在非滚动键时回尾。 */
export function isScrolled(): boolean {
  return state.scrollOffset > 0;
}

/** viewport 窗口起点绝对行索引(0-based,对齐 content.sliceFromEnd 的 start)。 */
export function viewportAbsStart(): number {
  const g = getGeo();
  const total = content.totalRows();
  const end = Math.max(0, total - state.scrollOffset);
  return Math.max(0, end - g.contentBottom);
}

/** 屏行(1-based,内容区内)→ 绝对缓冲行索引(0-based)。 */
export function screenRowToAbsLine(row: number): number {
  return viewportAbsStart() + (row - 1);
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
