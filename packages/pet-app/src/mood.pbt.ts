// PBT(属性测试):deriveMood 的"Mood 优先级排他性"(spec: desktop-pet 任务 2.1,Property 1)。
//   性质:若 deriveMood(events, now) 返回非 null 的 kind K,则 MOOD_PRIORITY 中排在 K 之前的
//   所有 kind,用 matchesMood 单独判定都必须为 false——否则 deriveMood 就该返回那个更高优先级的
//   kind 而不是 K(deriveMood 内部本就是按 MOOD_PRIORITY 顺序 first-match,这里做交叉验证)。
// 用 fast-check 生成任意 MoodEvent[](按 ts 排序)与 now,跑 500 次样本。
// 运行:npx tsx packages/pet-app/src/mood.pbt.ts

import fc from 'fast-check';
import type { PetState } from './protocol.js';
import { DEFAULT_MOOD_THRESHOLDS, MOOD_PRIORITY, deriveMood, matchesMood } from './mood.js';
import type { MoodEvent } from './mood.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
};

const petStateArb: fc.Arbitrary<PetState> = fc.constantFrom(
  'idle',
  'thinking',
  'speaking',
  'tool_call',
  'done',
  'aborted',
  'error',
  'waiting_human',
);

const moodEventArb: fc.Arbitrary<MoodEvent> = fc.record({
  state: petStateArb,
  ts: fc.nat({ max: 1_000_000 }),
});

// 生成 events(未排序)+ 一个 offset,now = 最后一条事件的 ts(排序后)+ offset。
// offset 范围覆盖负值(now 落在历史事件之前/之间)到较大正值(触发 tired/bored/urging 的时长判定),
// 以增加命中各优先级分支的概率。
const sampleArb = fc
  .tuple(fc.array(moodEventArb, { maxLength: 30 }), fc.integer({ min: -1000, max: 500_000 }))
  .map(([rawEvents, offset]) => {
    const events = [...rawEvents].sort((a, b) => a.ts - b.ts);
    const now = events.length > 0 ? events[events.length - 1].ts + offset : Math.max(0, offset);
    return { events, now };
  });

(async () => {
  fc.assert(
    fc.property(sampleArb, ({ events, now }) => {
      const result = deriveMood(events, now, DEFAULT_MOOD_THRESHOLDS);
      if (result === null) return true; // 全不命中,排他性天然满足

      const idx = MOOD_PRIORITY.indexOf(result);
      for (let i = 0; i < idx; i++) {
        const higherKind = MOOD_PRIORITY[i];
        if (matchesMood(higherKind, events, now, DEFAULT_MOOD_THRESHOLDS)) {
          return false; // 排在 result 之前的 kind 也命中了 → 违反排他性
        }
      }
      return true;
    }),
    { numRuns: 500 },
  );
  assert(true, 'Property 1 (Mood 优先级排他性):deriveMood 返回的 kind 之前无更高优先级命中(500 次样本)');

  console.log(`\nOK: ${passed} passed, 0 failed`);
  process.exit(0);
})().catch((err) => {
  console.error('✗ PBT 执行异常:', err);
  process.exit(1);
});
