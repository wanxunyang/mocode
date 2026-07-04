// 单测:pickQuip 的回退逻辑(皮肤池覆盖 / 未覆盖 / 空数组 / 未传皮肤池)。
// 覆盖 5 种 MoodKind,并验证多次随机调用不会跑出候选池范围。
// 运行:npx tsx packages/pet-app/src/quips.test.ts

import { pickQuip, UNIVERSAL_QUIPS } from './quips.js';
import type { MoodKind } from './mood.js';

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

console.log(`\nOK: ${passed} passed, 0 failed`);
