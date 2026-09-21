// session/gui-actions.ts - GUI 动作台账(L2)的存储与格式化。
//
// 与 notes.md 平级的**独立文件** `gui-actions.log`,每步一个 computer 动作追加一行,
// 只保留最近 N 条。它回答的是"我做过什么 / 做到哪",与视觉窗口(最新几帧)互补:
// 像素是空间轴(旧图快速贬值),台账是时间轴(第 3 步点过什么、哪次没生效,10 步后仍有价值)。
//
// 为什么是独立文件而不是写进 notes.md:notes.md 的 mtime 在本仓是**被监听的信号**
// (tool-turn.ts 前后比对 getNotesMtime(),变了就清零 stepsSincePlanTouch),台账每步都写
// 会让 plan nag 永不触发;且 note_append 走 ResourceLockManager 的 session-notepad 串行锁,
// 每步争锁没必要。详见 design-notes/vision-window.md §10.3。
//
// 契约:
//   - 写入失败**静默**:台账是可观测性,绝不能反过来影响 computer 动作的结果;
//   - 顺序为追加语义,行首序号单调递增且在滚动裁剪后保持不变(§10.8 风险 3);
//   - 语义纪律:记"意图 + 观察",不记"已达成"——"no visible change" 不升级成"成功"。

import fs from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';
import { getCurrentSessionId } from './state.js';

/** 台账文件名:与 notes.md 同目录(会话目录)。 */
export const GUI_ACTIONS_FILENAME = 'gui-actions.log';

/** 台账上界:只保留最近 N 条。24 ≈ 一个表单级任务的动作量,且与注入 token 预算匹配。 */
export const GUI_ACTIONS_MAX_ENTRIES = 24;

/** 一行台账的意图列宽(含对齐空格);超长不裁剪,仅退化为一个空格分隔。 */
const INTENT_COLUMN = 26;

/** 单条观察/错误文本上限:异常 output(栈、巨大 HTML)不该把一个 Monitor 动作撑成一屏。 */
const DETAIL_LIMIT = 80;

/** 注入时的段标题。 */
const SECTION_HEADING = '## GUI actions (most recent last; from the live action ledger)';

/**
 * 注入时的纪律说明。§10.5 的硬约束:台账永远不能覆盖像素。
 * 本实现不给条目加显式状态位(用户决策:沿用既有措辞),由这段说明统一给出冲突时的解法——
 * 台账说"点过了"而屏幕没变化 → 以屏幕为准,该动作视为 attempted, unverified。
 */
const DISCIPLINE_LINE =
  'These lines record intent + observation, never confirmed success: if the current screenshot disagrees with a line, the screenshot wins and that line counts as attempted but unverified.';

/** 当前会话 gui-actions.log 的绝对路径;无会话时返 null。 */
export function getGuiActionsFilePath(sessionId = getCurrentSessionId()): string | null {
  if (!sessionId) return null;
  const root = getSandboxRoot() ?? process.cwd();
  return path.join(root, '.mocode', 'sessions', sessionId, GUI_ACTIONS_FILENAME);
}

function truncateDetail(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}…` : flat;
}

/** `left_click at (512, 300)` → `left_click (512, 300)`;`typed 18 characters` → `type 18 chars`。 */
function normalizeIntent(summary: string): string {
  let text = summary.replace(/\s+/g, ' ').trim();
  // 顺序敏感:先处理带自身句式的动作,最后才是泛化的 "<action> at (x, y)"。
  text = text.replace(/^moved cursor to (\(.*\))$/, 'mouse_move $1');
  text = text.replace(/^typed ([\d.]+) characters$/, 'type $1 chars');
  text = text.replace(/^pressed key combo (".*")$/, 'key $1');
  text = text.replace(/^dragged from (\([^)]*\)) to (\([^)]*\))$/, 'drag $1 -> $2');
  text = text.replace(/^scrolled (\w+) by ([\d.]+) at (\(.*\))$/, 'scroll $1 $2 $3');
  text = text.replace(/^waited ([\d.]+)ms$/, 'wait $1ms');
  text = text.replace(/^cursor at physical \([^)]*\) = normalized (\(.*\))$/, 'cursor_position $1');
  text = text.replace(/^(\w+) at (\(.*\))$/, '$1 $2');
  return text;
}

export interface GuiActionEntry {
  /** 意图,如 `left_click (512, 300)` / `type 18 chars` / `key "ctrl+s"`。 */
  intent: string;
  /** 观察结果,如 `re-captured` / `no visible change, diff 1.20%`。 */
  observation: string;
}

/**
 * 把 computer 工具的 output 解析成一条台账的"意图 + 观察"。
 *
 * 素材是 `src/tools/builtins/computer.ts` 已有的输出文本(existing per-action summary +
 * 差分命中/回灌后缀),因此不需要新开采集通道。解析不出意图时返 null(调用方跳过)。
 */
export function parseComputerOutput(output: string): GuiActionEntry | null {
  const text = (output ?? '').trim();
  if (!text) return null;

  if (text.startsWith('computer action failed:')) {
    return { intent: 'failed', observation: `error: ${truncateDetail(text.slice('computer action failed:'.length))}` };
  }
  if (text.startsWith('Zoomed into region ')) {
    // zoom 会作废差分基准(computer.ts 置 lastFrame = null),因此必带新图、且只含局部区域。
    return { intent: 'zoom', observation: 're-captured (zoomed region only)' };
  }
  if (text.startsWith('Screenshot captured (')) {
    return { intent: 'screenshot', observation: 're-captured' };
  }

  const diffMatch = /\.\s*No visible change on screen \(frame diff ([\d.]+)%/.exec(text);
  if (diffMatch) {
    // 「no visible change」即"未达成"的现成措辞:保留原措辞,不升级成任何成功断言(§10.5)。
    return {
      intent: normalizeIntent(text.slice(0, diffMatch.index)),
      observation: `no visible change, diff ${diffMatch[1]}%`,
    };
  }
  const recapture = /\.\s*Screen re-captured \(/.exec(text);
  if (recapture) {
    return { intent: normalizeIntent(text.slice(0, recapture.index)), observation: 're-captured' };
  }
  return null;
}

/** 渲染一行台账;序号用于跨 compact / 跨裁剪保持"第几步"的可追溯性。 */
export function formatGuiActionLine(seq: number, entry: GuiActionEntry): string {
  const pad = ' '.repeat(Math.max(1, INTENT_COLUMN - entry.intent.length));
  return `${seq}. ${entry.intent}${pad}→ ${entry.observation}`;
}

/** 读台账原文行(已含序号);文件缺失/不可读返空数组。 */
export function readGuiActionEntries(sessionId = getCurrentSessionId()): string[] {
  const filePath = getGuiActionsFilePath(sessionId);
  if (!filePath) return [];
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/** 从既有行里取序号:滚动裁剪后序号必须继续递增,不能因为丢行而回退。 */
function nextSequence(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^(\d+)\.\s/.exec(lines[i]);
    if (match) return Number(match[1]) + 1;
  }
  return 1;
}

/**
 * 追加一条 computer 动作到台账。**失败静默**:写盘失败(只读目录 / ENOTDIR / 权限)不影响
 * 动作本身,台账是可观测性而非功能依赖。
 *
 * @returns 写入后的行数(失败时为 0)。
 */
export function appendGuiAction(output: string, sessionId = getCurrentSessionId()): number {
  const entry = parseComputerOutput(output);
  if (!entry) return 0;
  const filePath = getGuiActionsFilePath(sessionId);
  if (!filePath) return 0;
  try {
    const previous = readGuiActionEntries(sessionId);
    const line = formatGuiActionLine(nextSequence(previous), entry);
    const kept = [...previous, line].slice(-GUI_ACTIONS_MAX_ENTRIES);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${kept.join('\n')}\n`, 'utf8');
    return kept.length;
  } catch {
    // 台账不可写不得影响 computer 动作:这里是唯一允许吞掉错误的地方。
    return 0;
  }
}

/**
 * 构造注入用的台账段(供 {@link buildSessionStateReminder} 拼进尾部 ephemeral system 消息)。
 * 空台账返 ''(零开销,调用方此时不追加任何消息)。
 */
export function buildGuiActionsSection(sessionId = getCurrentSessionId()): string {
  const entries = readGuiActionEntries(sessionId);
  if (entries.length === 0) return '';
  return [SECTION_HEADING, ...entries, DISCIPLINE_LINE].join('\n');
}

/** 供 /cu status 展示的条数:0 表示该会话还没有任何 computer 动作入账。 */
export function countGuiActions(sessionId = getCurrentSessionId()): number {
  return readGuiActionEntries(sessionId).length;
}
