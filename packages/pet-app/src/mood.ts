// 桌宠 Mood(衍生情绪)引擎:纯函数,输入 state 事件历史 + 当前时间,输出当前应呈现的情绪。
// 设计意图(见 design.md "Mood 引擎"):
//   - 不进入 WS 协议——完全是 Server(pet-app)侧基于已收到 state 消息的本地再加工,
//     不新增/修改任何 Client ↔ Server 消息类型,mocode 主包侧无需感知 Mood 概念。
//   - 不改变 PetState 广播——mood 与 state 是叠加关系(渲染进程用独立的 mood-<kind> class),
//     本文件不修改、不影响现有 state class 切换逻辑。
//   - 无状态纯函数:不持有任何模块级可变状态,不做 I/O,同输入必同输出,便于单测与 PBT。

import type { PetState } from './protocol.js';

/** 衍生情绪种类(固定 5 种,互斥展示)。 */
export type MoodKind = 'frustrated' | 'flustered' | 'urging' | 'tired' | 'bored';

/** 记录一次收到的 state 消息(仅取本设计判定所需的两个字段)。 */
export interface MoodEvent {
  state: PetState;
  ts: number; // Date.now(),事件到达时间
}

export interface MoodThresholds {
  tiredMs: number; // thinking/tool_call 连续保持不变超过此时长 → tired
  boredMs: number; // idle 连续保持不变超过此时长 → bored
  urgingMs: number; // waiting_human 连续保持不变超过此时长 → urging
  errorWindowMs: number; // frustrated 判定的滑动窗口宽度
  errorCount: number; // 窗口内 error 事件数达到此阈值 → frustrated
  toolWindowMs: number; // flustered 判定的滑动窗口宽度
  toolCount: number; // 窗口内 tool_call 事件数达到此阈值 → flustered
}

/** 读取一个正数环境变量,非法/缺失时回退默认值(与 main.ts petPort() 的校验写法一致)。 */
function envNumber(name: string, defaultValue: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** 默认阈值(均为假设,可通过环境变量覆盖,见 design.md 默认值表)。 */
export const DEFAULT_MOOD_THRESHOLDS: MoodThresholds = {
  tiredMs: envNumber('MOCODE_PET_MOOD_TIRED_MS', 60_000),
  boredMs: envNumber('MOCODE_PET_MOOD_BORED_MS', 300_000),
  urgingMs: envNumber('MOCODE_PET_MOOD_URGING_MS', 30_000),
  errorWindowMs: envNumber('MOCODE_PET_MOOD_ERROR_WINDOW_MS', 60_000),
  errorCount: envNumber('MOCODE_PET_MOOD_ERROR_COUNT', 2),
  toolWindowMs: envNumber('MOCODE_PET_MOOD_TOOL_WINDOW_MS', 10_000),
  toolCount: envNumber('MOCODE_PET_MOOD_TOOL_COUNT', 5),
};

/** 固定优先级(高→低),同一时刻只呈现其中最高优先级的一种(Requirement 1.7)。 */
export const MOOD_PRIORITY: readonly MoodKind[] = [
  'frustrated',
  'flustered',
  'urging',
  'tired',
  'bored',
];

/**
 * 辅助纯函数:找出"当前状态"及其"从何时开始保持不变"(用于 tired/bored/urging 的时长判定)。
 * 后置条件:events 为空返回 null;否则返回 events 中最后一个事件的 state,
 *   以及从末尾往前扫描、状态连续相同的最早一条事件的 ts。
 */
export function currentStateSince(events: MoodEvent[]): { state: PetState; since: number } | null {
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  let since = last.ts;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].state !== last.state) break;
    since = events[i].ts;
  }
  return { state: last.state, since };
}

/**
 * 纯函数:给定完整事件历史(按到达顺序,ts 非降序)与当前时间,推导当前应呈现的 MoodKind。
 * 前置条件:events 按 ts 非降序排列。
 * 后置条件:
 *   - 返回值 ∈ MoodKind ∪ {null}。
 *   - 若返回非 null 的 kind K,则 MOOD_PRIORITY 中排在 K 之前的所有 kind 的判定条件均不成立
 *     (优先级排他性,Property 1)。
 * 不依赖调用历史之外的隐藏状态,任意次调用同输入同输出(确定性,Property 2)。
 */
export function deriveMood(
  events: MoodEvent[],
  now: number,
  thresholds: MoodThresholds = DEFAULT_MOOD_THRESHOLDS,
): MoodKind | null {
  for (const kind of MOOD_PRIORITY) {
    if (matchesMood(kind, events, now, thresholds)) return kind;
  }
  return null;
}

/**
 * 按单个 MoodKind 的判定条件检查是否命中(见 design.md 判定逻辑表)。
 * 导出供测试(PBT)交叉验证 deriveMood 的优先级排他性,不改变 deriveMood 既有公开行为。
 */
export function matchesMood(kind: MoodKind, events: MoodEvent[], now: number, thresholds: MoodThresholds): boolean {
  switch (kind) {
    case 'frustrated':
      return countInWindow(events, now, thresholds.errorWindowMs, 'error') >= thresholds.errorCount;
    case 'flustered':
      return countInWindow(events, now, thresholds.toolWindowMs, 'tool_call') >= thresholds.toolCount;
    case 'urging': {
      const cur = currentStateSince(events);
      return cur !== null && cur.state === 'waiting_human' && now - cur.since >= thresholds.urgingMs;
    }
    case 'tired': {
      const cur = currentStateSince(events);
      return (
        cur !== null &&
        (cur.state === 'thinking' || cur.state === 'tool_call') &&
        now - cur.since >= thresholds.tiredMs
      );
    }
    case 'bored': {
      const cur = currentStateSince(events);
      return cur !== null && cur.state === 'idle' && now - cur.since >= thresholds.boredMs;
    }
    default:
      return false;
  }
}

/** 统计 events 中 ts ∈ [now - windowMs, now] 且 state 匹配的条数。 */
function countInWindow(events: MoodEvent[], now: number, windowMs: number, state: PetState): number {
  const from = now - windowMs;
  let count = 0;
  for (const e of events) {
    if (e.state === state && e.ts >= from && e.ts <= now) count++;
  }
  return count;
}
