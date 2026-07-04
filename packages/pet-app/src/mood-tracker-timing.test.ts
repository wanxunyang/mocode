// createMoodTracker().evaluate() 的"立即求值"与"定时刷新文案"时序单测。
// 覆盖 mood-tracker.ts 的四条分支(见该文件 evaluate 内部逻辑):
//   1) mood 从 null → 非 null(“进入”新 mood):立即返回 {mood, quip}(不等 ticker)。
//   2) mood 不变且非 null,未到 QUIP_REFRESH_MS(15000ms):返回 null(不重复推送)。
//   3) mood 不变且非 null,达到 QUIP_REFRESH_MS(>=):返回新的 {mood(不变), quip(新文案)}。
//   4) mood 从非 null → null(“退出”mood):立即返回 {mood: null}(不等 ticker);
//      之后 mood 仍为 null 与上次一致 → 直接 return null(mood 为 null 时不进入文案刷新判断分支)。
// pickQuip 内部用 Math.random() 挑文案,内容不可预测,只断言"是否有新结果"与 mood/quip 类型。
// 运行:npx tsx packages/pet-app/src/mood-tracker-timing.test.ts

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

// ── 场景1:mood “进入”立即产生推送(不必等 ticker)───────────────────────
// 注:flustered 判定是"滑动窗口"(见 mood.ts countInWindow,toolWindowMs 默认 10000ms),
// 不是"状态持续不变"型判定(那类是 tired/urging/bored,用 currentStateSince,天然会随时间推移
// 一直保持成立)。若只记 5 条 ts=0..4000 的 tool_call,窗口会在 now 推进过程中把早期事件滑出去
// (例如 now=10001 时窗口 [1,10001] 只剩 4 条,已跌破阈值 5,mood 会提前变回 null,
// 与场景2/3"mood 在 4000~19001 期间应保持 flustered 不变"的前提矛盾)。
// 因此这里持续每隔 1000ms 记一条 tool_call 直到 ts=19000,以确保 flustered 的滑动窗口在
// 整个测试所需的时间跨度内始终 ≥5 条,从而让 mood 保持不变、只测"文案刷新"这一件事。
const tracker = createMoodTracker();
for (let t = 0; t <= 19000; t += 1000) {
  tracker.recordState('tool_call', t);
}

{
  const r = tracker.evaluate(4000);
  assert(
    r !== null && r.mood === 'flustered' && typeof r.quip === 'string',
    '场景1: 5 次 tool_call(10s 窗口内达阈值)→ evaluate 立即返回 {mood: "flustered", quip: string}',
  );
}

// ── 场景2:mood 保持不变,未到 QUIP_REFRESH_MS(15000ms)→ 应返回 null ──────
{
  const r = tracker.evaluate(4001);
  assert(
    r === null,
    '场景2a: mood 不变(仍 flustered),仅过 1ms(远小于 15000ms)→ evaluate 返回 null',
  );
}
{
  const r = tracker.evaluate(4000 + 15000 - 1); // 18999
  assert(
    r === null,
    '场景2b: mood 不变,距上次推文案差 1ms 未到 15000ms 刷新阈值 → evaluate 返回 null',
  );
}

// ── 场景3:mood 不变但达到 QUIP_REFRESH_MS(>=)→ 应重新推送新文案 ──────────
{
  const r = tracker.evaluate(4000 + 15000); // 19000,刚好达到刷新阈值(>=)
  assert(
    r !== null && r.mood === 'flustered' && typeof r.quip === 'string',
    '场景3a: mood 不变,刚好达到 15000ms 刷新阈值(>=)→ evaluate 返回新的 {mood: "flustered", quip: string}',
  );
}
{
  const r = tracker.evaluate(19001);
  assert(
    r === null,
    '场景3b: 刚刚才刷新过文案,立即再 evaluate(仅过 1ms)→ 返回 null',
  );
}

// ── 场景4:mood 消失时也应立即推送一次 {mood: null},不等定时器 ────────────
const tracker2 = createMoodTracker();
tracker2.recordState('error', 0);
tracker2.recordState('error', 100);

{
  const r = tracker2.evaluate(100);
  assert(
    r !== null && r.mood === 'frustrated',
    '场景4a: 60s 窗口内 2 次 error(达阈值)→ evaluate 返回 {mood: "frustrated", ...}',
  );
}
{
  const r = tracker2.evaluate(100 + 60001); // 两次 error 事件均已滑出 60000ms 窗口
  assert(
    r !== null && r.mood === null,
    '场景4b: error 事件滑出窗口,mood 从 frustrated 变为 null → evaluate 立即返回 {mood: null}(不等定时器)',
  );
}
{
  const r = tracker2.evaluate(100 + 60002);
  assert(
    r === null,
    '场景4c: mood 仍为 null(与上次推送一致)→ evaluate 直接返回 null(mood 为 null 时不检查文案刷新)',
  );
}

console.log(`\nOK: ${passed} passed, 0 failed`);
