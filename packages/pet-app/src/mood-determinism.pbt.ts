// PBT: Property 2 (Mood 确定性,纯函数) —— packages/pet-app/src/mood.ts 的 deriveMood。
// 覆盖 tasks.md 任务 2.2 / design.md Property 2:
//   给定任意 (events, now, thresholds) 输入,连续多次调用 deriveMood 返回值恒定
//   (无隐藏可变状态,纯函数),且调用过程不修改传入的 events 数组(无副作用)。
// 运行:npx tsx packages/pet-app/src/mood-determinism.pbt.ts (在 f:\mocode 根目录下)

import fc from 'fast-check';
import { deriveMood, DEFAULT_MOOD_THRESHOLDS, type MoodEvent, type MoodThresholds } from './mood.js';
import { PET_STATES } from './protocol.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

// 任意单条 MoodEvent:state 从 8 个合法 PetState 里选,ts 为非负整数。
const moodEventArb: fc.Arbitrary<MoodEvent> = fc.record({
  state: fc.constantFrom(...PET_STATES),
  ts: fc.integer({ min: 0, max: 10_000_000 }),
});

// 任意 MoodEvent[]:生成后按 ts 升序排序,满足 deriveMood 的前置条件(events 按 ts 非降序排列)。
const moodEventsArb: fc.Arbitrary<MoodEvent[]> = fc
  .array(moodEventArb, { maxLength: 40 })
  .map((events) => [...events].sort((a, b) => a.ts - b.ts));

// 任意正整数(用于自定义阈值的 7 个字段)。
const positiveIntArb = fc.integer({ min: 1, max: 1_000_000 });

// 任意 MoodThresholds:一半概率直接用 DEFAULT_MOOD_THRESHOLDS,一半概率用随机生成的自定义阈值。
const thresholdsArb: fc.Arbitrary<MoodThresholds> = fc.oneof(
  fc.constant(DEFAULT_MOOD_THRESHOLDS),
  fc.record({
    tiredMs: positiveIntArb,
    boredMs: positiveIntArb,
    urgingMs: positiveIntArb,
    errorWindowMs: positiveIntArb,
    errorCount: positiveIntArb,
    toolWindowMs: positiveIntArb,
    toolCount: positiveIntArb,
  }),
);

async function main(): Promise<void> {
  // Property 2: 对任意 (events, now, thresholds),多次调用 deriveMood 返回值恒定,且不修改 events。
  try {
    fc.assert(
      fc.property(moodEventsArb, fc.integer({ min: 0, max: 10_000_000 }), thresholdsArb, (events, now, thresholds) => {
        const before = JSON.stringify(events);

        const r1 = deriveMood(events, now, thresholds);
        const r2 = deriveMood(events, now, thresholds);
        const r3 = deriveMood(events, now, thresholds);

        const after = JSON.stringify(events);

        // 返回值恒定(===,mood 是字符串或 null,可直接比较)。
        if (!(r1 === r2 && r2 === r3)) return false;
        // events 数组未被修改(无副作用)。
        if (before !== after) return false;

        return true;
      }),
      { numRuns: 500 },
    );
    assert(true, 'Property 2 (Mood 确定性): 500 次随机样本,deriveMood 多次调用返回值恒定且不修改 events');
  } catch (e) {
    console.error('✗ Property 2 (Mood 确定性) 失败:');
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  console.log(`\nOK: ${passed} passed, 0 failed`);
  process.exit(0);
}

main();
