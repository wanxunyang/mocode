// Mood 求值调度器:维护"当前活跃连接生命周期内的 state 事件缓冲" + "上次推送结果",
// 提供 reset/recordState/evaluate 三个方法供 main.ts 在合适时机调用。
// 不 import electron——只依赖 mood.ts(纯函数判定)与 quips.ts(文案选择),
// 使这部分逻辑可以脱离真实 Electron 运行时被单元测试覆盖(main.ts 顶层的
// electron import 与模块加载期 ipcMain.on/handle 副作用会导致该文件无法在测试里被直接 import)。

import { deriveMood, type MoodEvent, type MoodKind } from './mood.js';
import { pickQuip } from './quips.js';
import type { PetState } from './protocol.js';

/** 文案刷新间隔:mood 保持不变且非 null 时,每隔此时长重新挑一条新文案推送(design.md 默认假设)。 */
export const QUIP_REFRESH_MS = 15_000;

export interface MoodEvaluation {
  mood: MoodKind | null;
  quip?: string;
}

export interface MoodTracker {
  /** 清空事件缓冲(新连接成为活跃连接时 / 活跃连接断开时调用)。不重置"上次已推送 mood"记录——
   *  下一次 evaluate 仍按"与上次推送结果比较"的规则运作,避免会话切换瞬间产生不必要的重复推送。 */
  reset(): void;
  /** 追加一条 state 事件到缓冲(仅应在消息来自活跃连接且校验通过时调用)。 */
  recordState(state: PetState, ts?: number): void;
  /** 对当前事件缓冲求值一次,返回是否需要推送给渲染进程(见下方规则),不需要推送时返回 null。 */
  evaluate(now?: number, skinQuips?: Partial<Record<MoodKind, string[]>>): MoodEvaluation | null;
}

/**
 * 创建一个独立的 MoodTracker 实例。用工厂函数而非模块级共享状态,
 * 便于单测里每个用例创建互不干扰的实例。
 */
export function createMoodTracker(): MoodTracker {
  const events: MoodEvent[] = [];
  let lastPushedMood: MoodKind | null = null;
  let lastQuipPushedAt = -Infinity;

  function reset(): void {
    events.length = 0;
  }

  function recordState(state: PetState, ts: number = Date.now()): void {
    events.push({ state, ts });
  }

  function evaluate(
    now: number = Date.now(),
    skinQuips?: Partial<Record<MoodKind, string[]>>,
  ): MoodEvaluation | null {
    const mood = deriveMood(events, now);

    if (mood !== lastPushedMood) {
      lastPushedMood = mood;
      if (mood === null) {
        return { mood: null };
      }
      lastQuipPushedAt = now;
      return { mood, quip: pickQuip(mood, skinQuips) };
    }

    if (mood !== null && now - lastQuipPushedAt >= QUIP_REFRESH_MS) {
      lastQuipPushedAt = now;
      return { mood, quip: pickQuip(mood, skinQuips) };
    }

    return null;
  }

  return { reset, recordState, evaluate };
}
