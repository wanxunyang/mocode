// 单测:pickQuip 的回退逻辑(皮肤池覆盖 / 未覆盖 / 空数组 / 未传皮肤池)
// 覆盖 5 种 MoodKind,并验证多次随机调用不会跑出候选池范围。
// + pickStateQuip 的命中 / 跳过逻辑(独立于 mood 系统,见 quips.ts 顶部注释)。
// 运行:npx tsx packages/pet-app/src/quips.test.ts

import { pickQuip, pickStateQuip, UNIVERSAL_QUIPS } from './quips.js';
import type { MoodKind } from './mood.js';
import type { PetState } from './protocol.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

const ALL_MOODS: MoodKind[] = ['frustrated', 'flustered', 'urging', 'tired', 'bored'];

// ── 1) 皮肤池覆盖该 mood(单条)→ 必然返回皮肤池里的那条 ──────────────────
{
  const skinQuips = { tired: ['猫猫要趴一下…'] };
  const r = pickQuip('tired', skinQuips);
  assert(r === '猫猫要趴一下…', `皮肤池覆盖 tired(单条)→ 返回皮肤池文案(实际:"${r}")`);
}

// ── 1b) 皮肤池覆盖该 mood(多条)→ 返回值必在皮肤池数组内 ─────────────────
{
  const skinList = ['猫猫要趴一下…', '电量告急,先眯一会'];
  const skinQuips = { tired: skinList };
  for (let i = 0; i < 20; i++) {
    const r = pickQuip('tired', skinQuips);
    assert(skinList.includes(r), `皮肤池覆盖 tired(多条)→ 返回值 ∈ 皮肤池(实际:"${r}")`);
  }
}

// ── 2) 皮肤池未覆盖该 mood(skinQuips 里没有 tired 这个 key)→ 回退通用池 ──
{
  const skinQuips = { bored: ['无所事事'] };
  const r = pickQuip('tired', skinQuips);
  assert(
    UNIVERSAL_QUIPS.tired.includes(r),
    `皮肤池未覆盖 tired → 回退 UNIVERSAL_QUIPS.tired(实际:"${r}")`
  );
}

// ── 3) 皮肤池对应 mood 是空数组 → 视为未覆盖,回退通用池 ─────────────────
{
  const skinQuips = { tired: [] as string[] };
  const r = pickQuip('tired', skinQuips);
  assert(
    UNIVERSAL_QUIPS.tired.includes(r),
    `皮肤池 tired 为空数组 → 回退 UNIVERSAL_QUIPS.tired(实际:"${r}")`
  );
}

// ── 4) 未传皮肤池 → 回退通用池 ──────────────────────────────────────────
{
  const r = pickQuip('tired');
  assert(
    UNIVERSAL_QUIPS.tired.includes(r),
    `未传皮肤池(tired)→ 回退 UNIVERSAL_QUIPS.tired(实际:"${r}")`
  );
}

// ── 5) 5 种 MoodKind 各跑一次"未传皮肤池"场景 → 都能返回该 mood 池里的某一条 ──
for (const mood of ALL_MOODS) {
  const r = pickQuip(mood);
  assert(
    typeof r === 'string' && UNIVERSAL_QUIPS[mood].includes(r),
    `未传皮肤池(${mood})→ 返回值 ∈ UNIVERSAL_QUIPS.${mood}(实际:"${r}")`
  );
}

// ── 6) 多次调用同一场景(20 次 pickQuip('tired'))→ 每次都不跑出通用池范围 ──
for (let i = 0; i < 20; i++) {
  const r = pickQuip('tired');
  assert(
    UNIVERSAL_QUIPS.tired.includes(r),
    `第 ${i + 1} 次调用 pickQuip('tired')→ 返回值 ∈ UNIVERSAL_QUIPS.tired(实际:"${r}")`
  );
}

// ── 7) pickStateQuip:皮肤池覆盖该 state(单条)→ 必然返回那条 ───────────────
{
  const stateQuips = { done: ['Twinkle! 任务完成 ✨'] };
  const r = pickStateQuip('done', stateQuips);
  assert(r === 'Twinkle! 任务完成 ✨', `pickStateQuip 皮肤池覆盖 done(单条)→ 返回皮肤池文案(实际:"${r}")`);
}

// ── 8) pickStateQuip:皮肤池覆盖该 state(多条)→ 20 次随机都在候选池内 ───────
{
  const list = ['Twinkle! 任务完成 ✨', '✦ DONE ✦', '任务收工'];
  const stateQuips = { done: list };
  for (let i = 0; i < 20; i++) {
    const r = pickStateQuip('done', stateQuips);
    assert(list.includes(r ?? ''), `pickStateQuip done(多条)→ 返回值 ∈ 皮肤池(实际:"${r}")`);
  }
}

// ── 9) pickStateQuip:皮肤池未配置该 state → 返回 null ─────────────────────
{
  const stateQuips = { aborted: ['再见'] };
  const r = pickStateQuip('done', stateQuips);
  assert(r === null, `pickStateQuip 皮肤池未配置 done → 返回 null(实际:${JSON.stringify(r)})`);
}

// ── 10) pickStateQuip:皮肤池该 state 是空数组 → 返回 null(视为未配置) ───
{
  const stateQuips: Partial<Record<PetState, string[]>> = { done: [] };
  const r = pickStateQuip('done', stateQuips);
  assert(r === null, `pickStateQuip done 为空数组 → 返回 null(实际:${JSON.stringify(r)})`);
}

// ── 11) pickStateQuip:未传 stateQuips → 返回 null ────────────────────────
{
  const r = pickStateQuip('error');
  assert(r === null, `pickStateQuip 未传 stateQuips → 返回 null(实际:${JSON.stringify(r)})`);
}

// ── 12) pickStateQuip:8 种 PetState 全部可作为 key 命中,未命中返回 null ────
{
  const ALL_STATES: PetState[] = ['idle', 'thinking', 'speaking', 'tool_call', 'done', 'aborted', 'error', 'waiting_human'];
  for (const state of ALL_STATES) {
    const r = pickStateQuip(state);
    assert(r === null, `pickStateQuip('${state}') 在空配置下 → 返回 null(实际:${JSON.stringify(r)})`);
  }
}

console.log(`\nOK: ${passed} passed, 0 failed`);
