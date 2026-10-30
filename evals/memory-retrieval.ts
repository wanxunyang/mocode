// R15 检索基线与诚实报数:npm run eval:memory-retrieval
//
// 这个脚本存在的理由,是让「记忆检索好不好用」有一个可以被反驳的数字,
// 而不是靠手感。它测的是**纯检索**(BM25 排序),不测模型读不读得懂、
// 读懂了用不用——那两层在 R4 的端到端评测里,这里只钉住最底层的可复现部分。
//
// 两种语料:
//  默认(fixture)  evals/memory-retrieval/corpus.json,由真实库脱敏冻结的快照。
//                 任何人 clone 都能跑出同一组数字,可进 CI、可作为回归基线。
//   --live        直接读本机真实记忆库,用同一组查询看真实库的漂移。
//                 数字因人而异,故不入库、不进 CI。
//
// 为什么不用 searchEntries():它会 bump recallCount 并写脏集,等于评测顺手改了
// 被评测的数据。这里只复用 TextSearchIndex 与完全相同的字段权重,在内存里建索引。
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextSearchIndex, type TokenizeMode } from '../src/context/text-search.js';
import { MEMORY_SEARCH_MIN_EVIDENCE } from '../src/tools/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(HERE, 'memory-retrieval', 'corpus.json');
const QUERIES_PATH = path.join(HERE, 'memory-retrieval', 'queries.json');

/**
 * 字段权重必须与 store.ts:searchEntries 一致,否则测的不是生产排序。
 * 改那边就要同步这里——这是刻意的重复:让不一致当场表现为数字变化,
 * 而不是让评测悄悄漂移成另一个系统。
 */
const FIELD_WEIGHTS = { name: 10, id: 8, summary: 5, body: 1 };
const KS = [1, 3, 5] as const;

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

interface RunResult {
  probe: Probe;
  ranked: string[];
  /** 与 ranked 一一对应的 BM25 原始分。没有分数就无法讨论「该不该设相关性下限」。 */
  scores: number[];
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function loadFixture(): CorpusEntry[] {
  const doc = readJson<{ entries: CorpusEntry[] }>(CORPUS_PATH);
  return doc.entries;
}

/** 直读 JSONL,绕过 store.ts 的一切副作用(loadAll 也会读、searchEntries 会 bump)。 */
function loadJsonl(p: string, scope: string): CorpusEntry[] {
  if (!existsSync(p)) return [];
  const out: CorpusEntry[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as CorpusEntry & { status?: string };
      // 与生产默认检索池一致:只看 active。
      if (e.status && e.status !== 'active') continue;
      out.push({ ...e, scope: e.scope ?? scope });
    } catch {
      /* 单行坏掉不该让整次评测失败 */
    }
  }
  return out;
}

function loadLive(): CorpusEntry[] {
  const home = process.env.USERPROFILE || os.homedir();
  return [
    ...loadJsonl(path.join(process.cwd(), '.mocode', 'memory.jsonl'), 'project'),
    ...loadJsonl(path.join(home, '.mocode', 'memory.jsonl'), 'global'),
  ];
}

function buildIndex(entries: CorpusEntry[], mode: TokenizeMode, minEvidence = 0): TextSearchIndex {
  return new TextSearchIndex(
    entries.map((e) => ({
      id: e.id,
      fields: [
        { text: e.name, weight: FIELD_WEIGHTS.name },
        { text: e.id, weight: FIELD_WEIGHTS.id },
        { text: e.summary, weight: FIELD_WEIGHTS.summary },
        { text: e.body ?? '', weight: FIELD_WEIGHTS.body },
      ],
    })),
    { tokenizeMode: mode, minEvidenceMatched: minEvidence },
  );
}

function run(probes: Probe[], index: TextSearchIndex, poolSize: number): RunResult[] {
  const limit = Math.max(poolSize, 20);
  return probes.map((probe) => {
    const hits = index.search(probe.query, limit);
    return {
      probe,
      ranked: hits.map((h) => h.id),
      scores: hits.map((h) => h.score),
    };
  });
}

/** 覆盖率:期望集合里有多少落在了 top-k。多答案探针按比例算,不是非黑即白。 */
function recallAt(results: RunResult[], k: number): number {
  const scored = results.filter((r) => r.probe.expect.length > 0);
  if (scored.length === 0) return 0;
  let sum = 0;
  for (const r of scored) {
    const top = new Set(r.ranked.slice(0, k));
    const hit = r.probe.expect.filter((id) => top.has(id)).length;
    sum += hit / r.probe.expect.length;
  }
  return sum / scored.length;
}

/** MRR:第一个正确结果名次的倒数;没命中记 0。 */
function mrr(results: RunResult[]): number {
  const scored = results.filter((r) => r.probe.expect.length > 0);
  if (scored.length === 0) return 0;
  let sum = 0;
  for (const r of scored) {
    const idx = r.ranked.findIndex((id) => r.probe.expect.includes(id));
    if (idx >= 0) sum += 1 / (idx + 1);
  }
  return sum / scored.length;
}

/** 负例误报率:本该零命中的查询实际返回了非空结果的比例。 */
function falsePositiveRate(results: RunResult[]): { rate: number; hits: string[] } {
  const negs = results.filter((r) => r.probe.kind === 'negative');
  if (negs.length === 0) return { rate: 0, hits: [] };
  const hits: string[] = [];
  for (const r of negs) {
    if (r.ranked.length > 0) hits.push(`${r.probe.id}「${r.probe.query}」→ ${r.ranked.slice(0, 2).join(', ')}`);
  }
  return { rate: hits.length / negs.length, hits };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function evaluate(
  entries: CorpusEntry[],
  probes: Probe[],
  mode: TokenizeMode,
  minEvidence = 0,
): {
  results: RunResult[];
  r: Record<number, number>;
  m: number;
  fp: { rate: number; hits: string[] };
} {
  const index = buildIndex(entries, mode, minEvidence);
  const results = run(probes, index, entries.length);
  const r = Object.fromEntries(KS.map((k) => [k, recallAt(results, k)])) as Record<number, number>;
  return { results, r, m: mrr(results), fp: falsePositiveRate(results) };
}

/** 按 kind 分组,看是哪一类查询拉低了整体——整体数字不解释就没法改进。 */
function byKind(results: RunResult[]): string {
  const kinds = [...new Set(results.map((r) => r.probe.kind))].filter((k) => k !== 'negative');
  return kinds
    .map((kind) => {
      const sub = results.filter((r) => r.probe.kind === kind);
      const top1 = sub.filter((r) => {
        const first = r.ranked[0];
        return first !== undefined && r.probe.expect.includes(first);
      }).length;
      return `${kind} ${top1}/${sub.length}`;
    })
    .join('  ');
}

const live = process.argv.includes('--live');
const entries = live ? loadLive() : loadFixture();
const probes = readJson<{ queries: Probe[] }>(QUERIES_PATH).queries;

if (entries.length === 0) {
  console.log(live ? 'skip: 真实记忆库为空' : `skip: 找不到语料 ${CORPUS_PATH}`);
  process.exit(0);
}

// 语料与探针的期望值必须对得上,否则测的是幻觉。
const ids = new Set(entries.map((e) => e.id));
const dangling = probes.flatMap((p) => p.expect.filter((id) => !ids.has(id)));
if (!live && dangling.length > 0) {
  console.log(`ERROR: 探针期望了语料里不存在的 id: ${[...new Set(dangling)].join(', ')}`);
  process.exit(1);
}

const modeLabel: Record<TokenizeMode, string> = {
  both: 'unigram+bigram(生产)',
  bigram: '仅 bigram',
  unigram: '仅 unigram',
};

console.log(`R15 检索基线 语料=${live ? '真实库(--live)' : 'fixture'} ${entries.length} 条, 探针 ${probes.length} 条`);
console.log('');

const modes: TokenizeMode[] = ['both', 'bigram', 'unigram'];
const table: { mode: TokenizeMode; r: Record<number, number>; m: number; fp: number }[] = [];
for (const mode of modes) {
  const { r, m, fp } = evaluate(entries, probes, mode);
  table.push({ mode, r, m, fp: fp.rate });
}

console.log('## R15.2 分词消融(同一语料、同一探针,均**不加**相关性下限)');
console.log('| 分词 | recall@1 | recall@3 | recall@5 | MRR | 负例误报 |');
console.log('|---|---|---|---|---|---|');
for (const row of table) {
  const mark = row.mode === 'both' ? ' **←**' : '';
  console.log(
    `| ${modeLabel[row.mode]}${mark} | ${pct(row.r[1])} | ${pct(row.r[3])} | ${pct(row.r[5])} | ${row.m.toFixed(3)} | ${pct(row.fp)} |`,
  );
}
console.log('');
console.log('注:本表刻意不加下限,以便单独观察分词本身的影响。生产跑的是下面 R15.5 那一组。');
console.log('');

// ── R15.5 相关性下限对照 ───────────────────────────────────────────────────
// 为什么单独一张表:分词与下限是**两个独立旋钮**,混在一张表里会看不出收益归谁。
// 这里固定分词为生产的 both,只扫下限强度 E(要求命中的证据词元数)。
const floors = [0, 1, 2, 3];
console.log('## R15.5 相关性下限对照(unigram+bigram,扫证据词元下限 E)');
console.log('| E | recall@1 | recall@3 | recall@5 | MRR | 负例误报 |');
console.log('|---|---|---|---|---|---|');
for (const e of floors) {
  const r = evaluate(entries, probes, 'both', e);
  const mark = e === MEMORY_SEARCH_MIN_EVIDENCE ? ' **←生产**' : '';
  console.log(
    `| ${e}${mark} | ${pct(r.r[1])} | ${pct(r.r[3])} | ${pct(r.r[5])} | ${r.m.toFixed(3)} | ${pct(r.fp.rate)} |`,
  );
}
console.log('');

const prod = evaluate(entries, probes, 'both', MEMORY_SEARCH_MIN_EVIDENCE);
console.log(`## R15.1 生产配置(both + 下限 E=${MEMORY_SEARCH_MIN_EVIDENCE})的分项`);
console.log(`有效探针(排除负例): ${probes.filter((p) => p.kind !== 'negative').length} 条`);
console.log(`按类型 recall@1: ${byKind(prod.results)}`);

const misses = prod.results.filter((r) => {
  if (r.probe.kind === 'negative') return false;
  const top = new Set(r.ranked.slice(0, 3));
  return !r.probe.expect.some((id) => top.has(id));
});
console.log(`recall@3 未命中: ${misses.length} 条`);
for (const m of misses) {
  console.log(
    `  ✗ ${m.probe.id}「${m.probe.query}」 期望 ${m.probe.expect.join(',')} 实得 ${m.ranked.slice(0, 3).join(',') || '(空)'}`,
  );
}

// recall@1 未命中要单独列:它和 @3 的差值就是「答案在,但没排第一」的具体名单,
// 这类探针往往正是加阈值时会最先被牺牲的——先看清它们,才知道代价付给了谁。
const miss1 = prod.results.filter((r) => {
  if (r.probe.kind === 'negative') return false;
  const first = r.ranked[0];
  return first === undefined || !r.probe.expect.includes(first);
});
console.log(`recall@1 未命中: ${miss1.length} 条`);
for (const m of miss1) {
  const rank = m.ranked.findIndex((id) => m.probe.expect.includes(id));
  console.log(
    `  ✗ ${m.probe.id}「${m.probe.query}」 期望 ${m.probe.expect.join(',')} 实际名次 ${rank < 0 ? '未命中' : rank + 1} (top3: ${m.ranked.slice(0, 3).join(',')})`,
  );
}

if (prod.fp.hits.length > 0) {
  console.log('');
  console.log('负例被误召回(这些查询本不该匹配任何记忆):');
  for (const h of prod.fp.hits) console.log(`  ! ${h}`);
}

// 关于「为什么不直接卡一个分数阈值」——这里只留结论,不留扫描逻辑。
//
// 下限生效前,同一套探针给过两组最优分数阈值:fixture(17 条)31.94、真实库(31 条)40.60。
// BM25 分数随语料规模(N)与 idf 漂移,写死任何一个都会在另一套数据上失效,而记忆库
// 在真实使用中会从几十条长到上百条。所以下限用的是**与规模无关**的量:命中了几个
// 证据词元。上面的 R15.5 表就是这条规则的完整对照。
//
// 为什么不取 E=1:它在同一份数据上 recall@1 反而更高(100%,因为剔掉了一条零证据命中
// 的干扰项),但两条负例靠单个泛化词漏了进来(「需要」df=3、「一直」df=1)。语料只有
// 17 条时 df 不具区分度,任何「按词的特异性过滤」都调不动它们——这是小语料的固有限制,
// 不是规则本身的可调参数。取 E=2 换 0% 误报,代价是 1 条词面重合极弱的探针(pro-2)
// 从 recall@3 掉出,已如实记在该表的数字里。

console.log('');
console.log(
  `结论: recall@1=${pct(prod.r[1])} recall@3=${pct(prod.r[3])} recall@5=${pct(prod.r[5])} MRR=${prod.m.toFixed(3)} 负例误报=${pct(prod.fp.rate)}`,
);
