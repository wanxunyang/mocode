// createMoodTracker() 的"连接切换/断开清空 events"单元测试。
// events 是模块闻包私有变量,测试无法直接读取,只能通过行为观察验证 reset() 是否真的
// 清空了内部事件缓冲——利用 deriveMood 里 tired/bored/urging/flustered 判定依赖
// "事件缓冲"这一特性:先喂够触发某个 mood 的事件,evaluate 确认命中,再 reset() 后
// 立即 evaluate(几乎同一时刻),若 mood 变回 null 则说明 events 已被真正清空
// (deriveMood 对空数组必然返回 null)。
//
// 覆盖 tasks.md 4.1:
//   场景1:新连接建立覆盖旧连接(main.ts onConnection 里的 reset() 时机)
//   场景2:活跃连接断开(main.ts onDisconnect 里的 reset() 时机)
//   场景3:reset 后重新 recordState 走出全新判定,不受 reset 前残留事件干扰
//
// 运行:npx tsx packages/pet-app/src/mood-tracker.test.ts

import { createMoodTracker } from './mood-tracker.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

// ── 场景1:新连接建立覆盖旧连接 → reset() 清空 events ──────────────────────
{
  const tracker = createMoodTracker();

  // 10s 窗口(默认 toolWindowMs=10000)内连续 5 次 tool_call(默认 toolCount=5)→ flustered。
  tracker.recordState('tool_call', 1000);
  tracker.recordState('tool_call', 2000);
  tracker.recordState('tool_call', 3000);
  tracker.recordState('tool_call', 4000);
  tracker.recordState('tool_call', 5000);

  const r1 = tracker.evaluate(6000);
  assert(
    r1 !== null && r1.mood === 'flustered',
    '场景1步骤1:10s 内 5 次 tool_call → evaluate 判定为 flustered',
  );

  tracker.reset();

  // 几乎同一时刻再 evaluate,若 events 真被清空,deriveMood 对空数组必返回 null,
  // 且上次推送是 'flustered' → null 属于变化,应推送 {mood: null}。
  const r2 = tracker.evaluate(6001);
  assert(
    r2 !== null && r2.mood === null,
    '场景1步骤2:reset() 后立即 evaluate → mood 变为 null(证明 events 已清空)',
  );

  // ── 场景3(复用场景1已 reset 过的 tracker):reset 后重新 recordState 走出全新判定 ──
  tracker.recordState('waiting_human', 10000);
  const r3 = tracker.evaluate(10000 + 30000); // 默认 urgingMs=30000
  assert(
    r3 !== null && r3.mood === 'urging',
    '场景3:reset 后重新 recordState(waiting_human)→ evaluate 判定为 urging(不受 reset 前残留 tool_call 事件干扰)',
  );
}

// ── 场景2:活跃连接断开 → reset() 清空 events ────────────────────────────
{
  const tracker = createMoodTracker();

  // idle 保持 300000ms(默认 boredMs=300000)→ bored。
  tracker.recordState('idle', 0);

  const r1 = tracker.evaluate(300_000);
  assert(
    r1 !== null && r1.mood === 'bored',
    '场景2步骤1:idle 保持 boredMs(300000ms)→ evaluate 判定为 bored',
  );

  tracker.reset();

  const r2 = tracker.evaluate(300_001);
  assert(
    r2 !== null && r2.mood === null,
    '场景2步骤2:reset() 后立即 evaluate → mood 变为 null(证明 events 已清空,不残留 bored 判定)',
  );
}

console.log(`\nOK: ${passed} passed, 0 failed`);
