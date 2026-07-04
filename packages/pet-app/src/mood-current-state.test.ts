// currentStateSince 边界场景单测(mood.ts 内部辅助函数,已临时加 export 以便测试)。
// 覆盖:空数组、单条事件、末尾多条同状态、末尾单条状态与前一条不同、
//   中间有切换但末尾又切回同状态(不应误判 since)。
// 运行:npx tsx packages/pet-app/src/mood-current-state.test.ts

import { currentStateSince, type MoodEvent } from './mood.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

// 1) 空数组 → null
{
  const r = currentStateSince([]);
  assert(r === null, '空数组 → 返回 null');
}

// 2) 单条事件 → { state, since } 就是该条自身
{
  const events: MoodEvent[] = [{ state: 'idle', ts: 100 }];
  const r = currentStateSince(events);
  assert(
    r !== null && r.state === 'idle' && r.since === 100,
    "单条事件 [{state:'idle',ts:100}] → {state:'idle', since:100}",
  );
}

// 3) 末尾多条同状态 → since 是这段连续区间里最早那条的 ts
{
  const events: MoodEvent[] = [
    { state: 'thinking', ts: 100 },
    { state: 'thinking', ts: 200 },
    { state: 'thinking', ts: 300 },
  ];
  const r = currentStateSince(events);
  assert(
    r !== null && r.state === 'thinking' && r.since === 100,
    "末尾多条同状态(thinking x3, ts:100/200/300) → since:100(最早那条,不是300)",
  );
}

// 4) 末尾单条状态与前一条不同 → since 就是该条自身的 ts,不把前一条算进去
{
  const events: MoodEvent[] = [
    { state: 'idle', ts: 100 },
    { state: 'thinking', ts: 200 },
  ];
  const r = currentStateSince(events);
  assert(
    r !== null && r.state === 'thinking' && r.since === 200,
    "末尾状态与前一条不同([idle@100, thinking@200]) → {state:'thinking', since:200}",
  );
}

// 5) 中间有切换但末尾又切回同一状态 → 只看末尾连续同状态的最新一段,不被更早处同状态干扰
{
  const events: MoodEvent[] = [
    { state: 'idle', ts: 100 },
    { state: 'thinking', ts: 200 },
    { state: 'idle', ts: 300 },
  ];
  const r = currentStateSince(events);
  assert(
    r !== null && r.state === 'idle' && r.since === 300,
    "末尾切回同状态但中间有切换([idle@100, thinking@200, idle@300]) → {state:'idle', since:300}(不误判为100)",
  );
}

console.log(`\nOK: ${passed} passed, 0 failed`);
