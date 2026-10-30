/**
 * R15 检索基线的回归测试。
 *
 * 这里**不测数字**——recall 的具体数值随语料与探针变化,把 "recall@1 必须 ≥98%"
 * 写进单测,只会让每次合理的数据调整都变成改断言。这里钉住的是三件更容易腐坏的事:
 *
 *  1. **fixture 自身的完整性**:探针期望的 id 必须真在语料里,否则评测算的是幻觉;
 *  2. **分词口径**:`both` 必须仍是 unigram+bigram(生产行为不能被消融实验改掉),
 *     且建索引与查询必须同档——不同档会静默变成全零命中;
 *  3. **语料的隐私边界**:这份 fixture 要入库、开源,任何个人信息漏进来都是事故,
 *     所以用关键字做一次硬断言。
 *
 * 评测脚本本身(`evals/memory-retrieval.ts`)跑真实数字,不进 `npm test`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextSearchIndex, tokenize, type TokenizeMode } from '../src/context/text-search.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 从 dist-tests/tests/ 与 tests/ 两种位置都能找到仓库根。 */
function repoRoot(): string {
  for (const candidate of [path.resolve(HERE, '..', '..'), path.resolve(HERE, '..'), process.cwd()]) {
    if (existsSync(path.join(candidate, 'evals', 'memory-retrieval', 'corpus.json'))) return candidate;
  }
  throw new Error('找不到仓库根(找不到 evals/memory-retrieval/corpus.json)');
}

const ROOT = repoRoot();
const CORPUS_PATH = path.join(ROOT, 'evals', 'memory-retrieval', 'corpus.json');
const QUERIES_PATH = path.join(ROOT, 'evals', 'memory-retrieval', 'queries.json');

interface CorpusEntry {
  id: string;
  scope: string;
  type: string;
  name: string;
  summary: string;
  body: string;
}
interface Probe {
  id: string;
  kind: string;
  query: string;
  expect: string[];
}

const corpus = (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { entries: CorpusEntry[] }).entries;
const probes = (JSON.parse(readFileSync(QUERIES_PATH, 'utf8')) as { queries: Probe[] }).queries;

// ── 1. fixture 完整性 ───────────────────────────────────────────────────────

test('R15 fixture:条目 id 唯一,且不含被取代/归档条目', () => {
  const ids = corpus.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一,否则 recall 的命中判定会重复计数');
  for (const e of corpus) {
    assert.ok(e.id && e.name && e.summary, `条目字段不完整: ${e.id}`);
    // 语料只放 active:归档条目不该进基线池,否则测的是「能不能召回过期事实」。
    assert.ok(!('status' in e) || (e as { status?: string }).status !== 'archived', `${e.id} 是归档条`);
  }
});

test('R15 fixture:探针数量达标且 id 唯一', () => {
  assert.ok(probes.length >= 50, `R15.1 要求 ≥50 条探针,实际 ${probes.length}`);
  const ids = probes.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '探针 id 必须唯一,否则报告里无法定位失败项');
  for (const p of probes) {
    assert.ok(p.query.trim().length > 0, `探针 ${p.id} 查询为空`);
    assert.ok(p.kind.length > 0, `探针 ${p.id} 缺 kind`);
  }
});

test('R15 fixture:每条探针的期望 id 都真实存在于语料(否则测的是幻觉)', () => {
  const ids = new Set(corpus.map((e) => e.id));
  const dangling = probes.flatMap((p) => p.expect.filter((id) => !ids.has(id)));
  assert.deepEqual(dangling, [], `期望了不存在的 id: ${[...new Set(dangling)].join(', ')}`);
});

test('R15 fixture:负例不带期望值,正例必须带', () => {
  for (const p of probes) {
    if (p.kind === 'negative') assert.equal(p.expect.length, 0, `负例 ${p.id} 不该有期望值`);
    else assert.ok(p.expect.length > 0, `正例 ${p.id} 必须有期望值`);
  }
  // 负例是「不相关就该空手而归」的唯一证据,少于 3 条就说明这维度没被测。
  assert.ok(probes.filter((p) => p.kind === 'negative').length >= 3, '负例至少 3 条');
});

test('R15 fixture:语料覆盖多个查询类型,避免只测一种问法', () => {
  const kinds = new Set(probes.map((p) => p.kind));
  for (const required of ['cjk', 'english', 'exact', 'negative']) {
    assert.ok(kinds.has(required), `缺少 ${required} 类探针`);
  }
});

// ── 2. 隐私边界(这份 fixture 要入库、开源)────────────────────────────────

test('R15 fixture:不得含个人信息(真实库里的个人条目必须被剔除)', () => {
  const raw = readFileSync(CORPUS_PATH, 'utf8') + readFileSync(QUERIES_PATH, 'utf8');
  const forbidden: [string, RegExp][] = [
    ['本机用户名', /20251/],
    ['雇主', /红熊|hongxiong/i],
    ['个人职业事实', /烟台|月薪|跳槽|薪资|工资|杭州|公寓/],
    ['个人器材', /A7C2|索尼|ilce-7cm2/i],
    ['对用户的称呼', /万(?!能|一|物|字|s)/],
  ];
  for (const [label, re] of forbidden) {
    const hit = raw.match(new RegExp(re.source, 'gi'));
    assert.equal(hit, null, `语料含${label}: ${[...new Set(hit ?? [])].slice(0, 3).join(', ')}`);
  }
});

// ── 3. 分词口径 ─────────────────────────────────────────────────────────────

test('tokenize 默认仍是 unigram+bigram(生产行为不能被消融实验改掉)', () => {
  // 「记忆」→ 逐字产出:记、记忆(unigram 后紧跟该位置起的 bigram)、忆
  assert.deepEqual(tokenize('记忆'), ['记', '记忆', '忆']);
  assert.deepEqual(tokenize('记忆'), tokenize('记忆', 'both'), '省略 mode 必须等价于 both');
});

test('tokenize 三档的包含关系:bigram ⊂ both,unigram ⊂ both', () => {
  const text = '上下文压缩 pipeline 三层';
  const both = tokenize(text, 'both');
  const bigram = tokenize(text, 'bigram');
  const unigram = tokenize(text, 'unigram');
  for (const t of bigram) assert.ok(both.includes(t), `bigram 的 ${t} 不在 both 里`);
  for (const t of unigram) assert.ok(both.includes(t), `unigram 的 ${t} 不在 both 里`);
  // 两档的并集应还原 both(仅对纯 CJK 段成立,ASCII 段三档相同)。
  assert.deepEqual([...new Set([...bigram, ...unigram])].sort(), [...new Set(both)].sort());
});

test('tokenize 的 ascii 段不受 mode 影响(英文查询三档等价)', () => {
  // 只取纯 ASCII 查询:CJK 部分必然随 mode 变,混进来就测不到这句断言本身。
  for (const mode of ['both', 'bigram', 'unigram'] as TokenizeMode[]) {
    assert.deepEqual(tokenize('expected_hash conflict', mode), ['expected', 'hash', 'conflict'], mode);
  }
});

test('tokenize 单字 CJK 在 bigram 档下为空(unigram 才是噪声来源)', () => {
  assert.deepEqual(tokenize('肉', 'bigram'), [], '单字在 bigram 档无可组合的邻居');
  assert.deepEqual(tokenize('肉', 'unigram'), ['肉']);
});

// ── 4. TextSearchIndex 的兼容与同档约束 ────────────────────────────────────

const docs = [
  {
    id: 'a',
    fields: [
      { text: '上下文压缩 pipeline', weight: 10 },
      { text: 'body a', weight: 1 },
    ],
  },
  {
    id: 'b',
    fields: [
      { text: 'relevance pruner', weight: 10 },
      { text: 'body b', weight: 1 },
    ],
  },
];

test('TextSearchIndex 旧的位置参数构造 (k1, b) 仍然可用', () => {
  // 这条是给已有调用方的护栏:改签名时不能把传数字的老代码弄坏。
  const legacy = new TextSearchIndex(docs, 1.5, 0.75);
  assert.equal(legacy.search('pruner')[0]?.id, 'b');

  const viaOpts = new TextSearchIndex(docs, { k1: 1.5, b: 0.75 });
  assert.equal(viaOpts.search('pruner')[0]?.id, 'b');
  // 两种写法在默认分词下必须给出相同的排序结果。
  assert.deepEqual(
    legacy.search('上下文 pipeline').map((h) => h.id),
    viaOpts.search('上下文 pipeline').map((h) => h.id),
  );
});

test('TextSearchIndex 建索引与查询同档:换档后仍能自洽命中', () => {
  // 若索引按 both 建、查询按 bigram 查,查询词里会混进索引中不存在的 token;
  // 反向则会丢掉单字命中。这里只验证「同档可用」这一半,另一半由评测脚本的量测回答。
  for (const mode of ['both', 'bigram'] as TokenizeMode[]) {
    const idx = new TextSearchIndex(docs, { tokenizeMode: mode });
    assert.equal(idx.search('pruner', 1)[0]?.id, 'b', `${mode} 档下英文查询应命中`);
  }
  const uni = new TextSearchIndex(docs, { tokenizeMode: 'unigram' });
  assert.equal(uni.search('压', 1)[0]?.id, 'a', 'unigram 档下单字应能命中');
  const bi = new TextSearchIndex(docs, { tokenizeMode: 'bigram' });
  assert.equal(bi.search('压', 1).length, 0, 'bigram 档下单字查询无词可查,应空手而归');
});

test('TextSearchIndex 无有效查询词时返回空数组(调用方自行决定回退)', () => {
  const idx = new TextSearchIndex(docs);
  assert.deepEqual(idx.search('!!'), []);
  assert.deepEqual(idx.search(''), []);
});

// ── 5. 相关性下限(R15.5)────────────────────────────────────────────────────
//
// 这组测试钉的是**语义**,不是数字:下限的核心主张是「有 token 重合 ≠ 相关」,
// 而 BM25 本身只排序、不判定相关性。具体阈值(E=2)由评测脚本对照决定,
// 改阈值不该让这里变红,改语义才该。

/** 两个文档:a 有 CJK 词 '上下文/压缩' 与英文词 pipeline;b 只有 relevance pruner。 */
const floorDocs = [
  {
    id: 'a',
    fields: [
      { text: '上下文压缩 pipeline', weight: 10 },
      { text: 'body a', weight: 1 },
    ],
  },
  {
    id: 'b',
    fields: [
      { text: 'relevance pruner', weight: 10 },
      { text: 'body b', weight: 1 },
    ],
  },
];

test('下限:无关查询空手而归(无任何词元重合时与下限无关,但这是下限要保护的行为)', () => {
  const idx = new TextSearchIndex(floorDocs, { minEvidenceMatched: 2 });
  assert.deepEqual(idx.search('红烧肉怎么炖'), []);
  assert.deepEqual(idx.search('kubernetes pod restart'), []);
});

test('下限:只重合一个证据词元的文档被判为不相关', () => {
  const idx = new TextSearchIndex(floorDocs, { minEvidenceMatched: 2 });
  // 查询有两个证据词元(上下、pruner),但每个文档各只命中一个 → 两个都该被挡。
  assert.deepEqual(
    idx.search('上下 pruner').map((h) => h.id),
    [],
    '各命中 1 个证据词元 < 下限 2',
  );
  // 不设下限时同样的查询会两个都返回,这正是缺陷本身。
  const noFloor = new TextSearchIndex(floorDocs);
  assert.deepEqual(
    noFloor
      .search('上下 pruner')
      .map((h) => h.id)
      .sort(),
    ['a', 'b'],
  );
});

test('下限:查询的证据词元不足下限时按实际数量降级,而不是一律过滤', () => {
  const idx = new TextSearchIndex(floorDocs, { minEvidenceMatched: 2 });
  // 'pruner' 只有一个证据词元 → need = min(2,1) = 1。若写成固定 2,英文单词查询全废。
  assert.deepEqual(
    idx.search('pruner').map((h) => h.id),
    ['b'],
  );
  assert.deepEqual(
    idx.search('pipeline').map((h) => h.id),
    ['a'],
  );
});

test('下限:单个汉字不算证据,因此单字查询不触发过滤', () => {
  const idx = new TextSearchIndex(floorDocs, { minEvidenceMatched: 2 });
  // tokenize('压') = ['压'],证据词元数 0 → 不过滤(否则短查询整片变空)。
  // 单个汉字也正是不该被当作「相关证据」的东西:它几乎必然出现在某条记忆正文里。
  assert.deepEqual(
    idx.search('压').map((h) => h.id),
    ['a'],
  );
});

test('下限:被过滤的文档不占 limit 名额(过滤发生在截断之前)', () => {
  // hi 只在 name 重字段命中 1 个证据词元,分数却高于 lo(lo 的词埋在长 body 里、得分低)。
  // 若实现先按 limit 截断再过滤,limit=1 会取到 hi 再把它滤掉 → 空结果;
  // 正确行为是先过滤再截断,名额让给真正相关的 lo。
  const mk = (id: string, name: string, body: string) => ({
    id,
    fields: [
      { text: name, weight: 10 },
      { text: body, weight: 1 },
    ],
  });
  const docs2 = [mk('hi', 'alpha', ''), mk('lo', '', `alpha beta ${'y '.repeat(40)}`)];
  assert.deepEqual(
    new TextSearchIndex(docs2).search('alpha beta', 1).map((h) => h.id),
    ['hi'],
    '对照:无下限时 hi 分数更高,占住唯一名额',
  );
  assert.deepEqual(
    new TextSearchIndex(docs2, { minEvidenceMatched: 2 }).search('alpha beta', 1).map((h) => h.id),
    ['lo'],
    'hi 只有 1 个证据词元应被滤掉,名额让给 lo',
  );
});

test('下限:0 与省略等价(默认不过滤,老调用方行为不变)', () => {
  const withZero = new TextSearchIndex(floorDocs, { minEvidenceMatched: 0 });
  const omitted = new TextSearchIndex(floorDocs);
  for (const q of ['上下文', 'pruner', '上下 pruner', '压']) {
    assert.deepEqual(
      withZero.search(q).map((h) => h.id),
      omitted.search(q).map((h) => h.id),
      q,
    );
  }
});
