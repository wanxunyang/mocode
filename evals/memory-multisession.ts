// R4.2 多会话评测 + R4.3 消融对照:npm run eval:memory-multisession
//
// 这个脚本存在的理由:「记忆在第二个会话里真的把上个会话学到的东西带过来了吗」,
// 这件事不能靠读代码相信,只能靠一个一个可判定的场景。
//
// 与 evals/memory-retrieval.ts 的分工:
//   memory-retrieval 只测**排序**(BM25 单通道,纯函数);
//   本脚本测**通道是否送达**——写入之后,第二个会话里 context 里到底有没有那段字。
//   所以它必须走生产的读路径(proactiveHint / listEntries / buildEpisodeSection),
//   而不是重新实现一遍匹配。
//
// 为什么不用真实模型:判分要可复跑、可进 CI、可对照。模型是否"采纳"了提醒是另一层
// (R13 的 memory-compact-handoff 用真模型测那一层),这一层只钉住"送到了没有"。
// 送到了没被采纳是提示词问题,没送到是通道问题 —— 把两者混在一起就分不清了。
//
// 五种题型(R4.2 的验收清单):
//   约束延续 A  上个会话记下的用户约束,这轮会被前摄弹出 / 出现在索引里
//   坑复现   B  踩过的坑在同类操作前出现;锚定文件的记忆在读该文件时回注
//   过期事实 C  代码变了 → 记忆必须带 STALE-CODE,而不是当作新鲜事实喂回去
//   冲突更新 D  同一件事有新旧两条 → 默认检索只能给新的,旧的带着 SUPERSEDED 标记
//   噪声抗性 E  无关操作/无关查询不得命中(否则提醒系统会被忽略)
//
// 消融(R4.3):--all 会把 off / current / ablate:<feature> 各跑一遍,输出同一组探针的
// 通过数对照表。每个探针声明它依赖哪些通道,于是还能测出「开关是否真的管住了它」——
// 一个探针在关掉某通道后仍然通过,说明那个通道对它其实不起作用(或开关没接上)。
//
// 隔离:临时 HOME + 临时 cwd + sandboxRoot,绝不读写真实记忆库。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setSandboxRoot } from '../src/sandbox/root.js';
import {
  saveEntry,
  searchEntries,
  supersedeEntry,
  forgetEntry,
  listEntries,
  buildMemoryIndexSection,
  __resetPendingRecallForTests,
} from '../src/memory/store.js';
import {
  proactiveHint,
  isProactiveEnabled,
  __resetProactiveForTests,
  __resetProactiveCountersForTests,
} from '../src/memory/proactive.js';
import { recordSessionEpisode, buildEpisodeSection } from '../src/memory/episodic.js';
import { __resetAnchorCacheForTests } from '../src/memory/anchor.js';

// ── 隔离 ──────────────────────────────────────────────────────────────────

const root = mkdtempSync(path.join(os.tmpdir(), 'mocode-eval-ms-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(path.join(proj, 'src', 'llm'), { recursive: true });
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
const prevCwd = process.cwd();
const prevRoot = setSandboxRoot(proj);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(proj);

function cleanup(): void {
  setSandboxRoot(prevRoot);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevProfile;
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
}

function writeSource(rel: string, text: string): void {
  const abs = path.join(proj, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** 清模块级缓存(索引 / 冷却 / 计数)。共享进程里切通道必须做,否则上一模式的命中会串味。 */
function resetCaches(): void {
  __resetProactiveForTests();
  __resetProactiveCountersForTests();
  __resetAnchorCacheForTests();
  __resetPendingRecallForTests();
}

// ── 通道与模式 ────────────────────────────────────────────────────────────

/** 探针可以依赖的通道。`memory` = 记忆总开关;其余为各子通道。 */
type Feature = 'memory' | 'proactive' | 'episodic';

interface Mode {
  label: string;
  features: ReadonlySet<Feature>;
}

const ALL: Feature[] = ['memory', 'proactive', 'episodic'];
const ALL_SET = new Set<Feature>(ALL);

const MODES: Mode[] = [
  { label: 'off(无记忆)', features: new Set<Feature>() },
  { label: 'current(当前版本)', features: ALL_SET },
  { label: 'ablate:proactive(关前摄)', features: new Set<Feature>(['memory', 'episodic']) },
  { label: 'ablate:episodic(关情节)', features: new Set<Feature>(['memory', 'proactive']) },
];

function applyMode(mode: Mode): void {
  const on = (f: Feature): boolean => mode.features.has(f);
  process.env.MEMORY_ENABLED = on('memory') ? 'true' : 'false';
  process.env.MOCODE_MEMORY_PROACTIVE = on('proactive') ? '1' : '0';
  process.env.MOCODE_MEMORY_EPISODIC = on('episodic') ? '1' : '0';
  resetCaches();
}

/**
 * 探针必须按**生产同样的门控**调用,否则消融测不出任何东西。
 *
 * 这一条是评测脚本自己的 bug 教出来的:最初所有探针都写 `proactiveHint(..., true, ...)`,
 * 于是关掉前摄后探针照样通过,`--all` 表里整列显示「与预期不一致 5/13」。
 * 那不是开关坏了,是评测绕过了开关 —— 一个永远通过的分母,测什么都是绿的。
 */
const memoryOn = (): boolean => process.env.MEMORY_ENABLED === 'true';
/** 生产门控:tool-dispatcher.ts:67 就是这两个条件的与。 */
const proactiveOn = (): boolean => memoryOn() && isProactiveEnabled();

/** 记忆关闭时搜索工具根本不可见,对应的探针应判「不适用」而不是硬跑。 */
function requireMemory(): ProbeResult | null {
  return memoryOn() ? null : no('记忆已关闭,该通道不可用(预期)');
}

// ── 语料:模拟"上个会话"留下的记忆 ────────────────────────────────────────

const SCHEMA_FILE = 'src/llm/tool-schema.ts';

/** 第一条坑记忆:带 trigger,靠前摄通道出现。 */
let pitfallTriggerId = '';
/** 第二条坑记忆:只锚定文件,没有 trigger(reference 型 → 进不了 trigger 索引)。 */
let anchorOnlyId = '';
/** 约束记忆:用户的硬性要求。 */
let constraintId = '';
/** 冲突更新用:同主题的新旧两条。 */
let oldDeployId = '';
let newDeployId = '';
/** 过期事实用:锚定后代码被改。 */
let staleAnchorId = '';
/** 派生条目:源被归档后必须带 stale。 */
let derivedId = '';

function seedMemory(): void {
  writeSource(SCHEMA_FILE, 'export function buildToolSchema(t: Tool) {\n  return { ...t };\n}\n');
  writeSource('src/llm/deploy.ts', 'export const PORT = 8080;\n');

  const pit = saveEntry({
    type: 'pitfall',
    name: 'dashscope 工具 schema',
    summary: '给 dashscope 发工具 schema 时,uniqueItems 会让整个请求 400',
    body: 'dashscope compatible-mode 收到 uniqueItems 会返回 InternalError.Algo,必须在 tool-schema.ts 递归剔除。',
    trigger: '构造工具 schema 且后端是 dashscope 时',
    action: '递归剔除 uniqueItems 再发',
    scope: 'project',
  });
  if (pit.ok) pitfallTriggerId = pit.id;

  // reference 型 + 只有锚点:验证 R3.6 的弱通道(wantsTrigger 不认 reference)
  const anchored = saveEntry({
    type: 'reference',
    name: 'tool-schema 是叶子模块',
    summary: 'tool-schema.ts 独立成叶子模块,用来断开 index 与 anthropic 的循环依赖',
    body: '不要在 tool-schema.ts 里 import llm/index.ts。',
    anchors: [{ path: SCHEMA_FILE }],
    scope: 'project',
  });
  if (anchored.ok) anchorOnlyId = anchored.id;

  const con = saveEntry({
    type: 'feedback',
    name: '回复语言用中文',
    summary: '用户要求全程中文回复,最终结论也必须是中文',
    body: '即使代码注释是英文,面向用户的解释一律中文。',
    trigger: '需要解释原理、给出方案或做方案对比时',
    action: '用中文组织回答',
    scope: 'global',
  });
  if (con.ok) constraintId = con.id;

  const oldDeploy = saveEntry({
    type: 'fact',
    name: '部署端口 8080',
    summary: '生产部署端口是 8080',
    body: 'mocode 生产环境监听 8080。',
    scope: 'project',
  });
  if (oldDeploy.ok) oldDeployId = oldDeploy.id;
  const newDeploy = saveEntry({
    type: 'fact',
    name: '部署端口 9090',
    summary: '生产部署端口改为 9090(原 8080 已废弃)',
    body: '运维在 10 月统一切到 9090,8080 只保留给本地调试。',
    scope: 'project',
  });
  if (newDeploy.ok) {
    newDeployId = newDeploy.id;
    supersedeEntry(oldDeployId, newDeployId, '端口变更');
  }

  // 过期事实:锚定 deploy.ts 的 PORT 常量
  const staleAnchor = saveEntry({
    type: 'reference',
    name: '部署端口常量',
    summary: 'deploy.ts 里 PORT 是 8080',
    body: 'PORT 常量定义在 deploy.ts,监听时直接用。',
    anchors: [{ path: 'src/llm/deploy.ts', symbol: 'PORT' }],
    scope: 'project',
  });
  if (staleAnchor.ok) staleAnchorId = staleAnchor.id;
  // 模拟"代码后来变了"
  writeSource('src/llm/deploy.ts', 'export const PORT = 9090;\n');

  // 派生条目:源先建,再归纳
  const src = saveEntry({
    type: 'fact',
    name: 'memory_store 用 JSONL',
    summary: '记忆库是一行一条 JSON',
    body: 'store.ts 用 JSONL + tmp/rename 原子写。',
    scope: 'project',
  });
  if (src.ok) {
    const der = saveEntry({
      type: 'decision',
      name: '记忆存储结论',
      summary: '记忆的持久化格式选 JSONL 而非 sqlite',
      body: '理由:单机单用户、可 diff、无需迁移。',
      derivedFrom: [src.id],
      scope: 'project',
    });
    if (der.ok) derivedId = der.id;
    // 源被归档 → 派生条目必须读时 sha 出 stale
    forgetEntry(src.id, 'archive');
  }

  // 噪声条目:存在但与本轮所有探针无关。它不是断言对象,而是为了让"无关查询"
  // 真的面对一个非空库 —— 空库上测噪声抗性等于什么都没测。
  saveEntry({
    type: 'pitfall',
    name: 'xlsx 导出丢样式',
    summary: '用 xlsx 库读带公式的表格会丢样式',
    body: '改用 exceljs。',
    trigger: '读取带公式的 xlsx 文件时',
    action: '换 exceljs',
    scope: 'project',
  });

  // 一个"上个会话"的情节
  recordSessionEpisode({
    sessionId: 'sess-A',
    queries: ['把 tool schema 的 uniqueItems 剔掉'],
    changedFiles: [SCHEMA_FILE],
  });
  resetCaches();
}

// ── 探针 ──────────────────────────────────────────────────────────────────

interface ProbeResult {
  pass: boolean;
  detail: string;
}

interface Probe {
  id: string;
  category: 'A 约束延续' | 'B 坑复现' | 'C 过期事实' | 'D 冲突更新' | 'E 噪声抗性';
  /** 这条探针要成立,必须打开哪些通道。空数组 = 与记忆无关,任何模式都该通过。 */
  requires: Feature[];
  what: string;
  run: () => ProbeResult;
}

const ok = (detail: string): ProbeResult => ({ pass: true, detail });
const no = (detail: string): ProbeResult => ({ pass: false, detail });

const has = (hay: string, needle: string): boolean => hay.includes(needle);

const PROBES: Probe[] = [
  // ── A 约束延续 ─────────────────────────────────────────────────────────
  {
    id: 'A1',
    category: 'A 约束延续',
    requires: ['memory', 'proactive'],
    what: '上个会话记下的硬约束,在"要比较方案"时被前摄弹出',
    run: () => {
      // 语境要写成一个用户真会说的话:与 trigger 有多于一个实词重合。
      // 只靠「方案」一个词够不到 MIN_MATCHED_TOKENS=2——这不是通道坏了,是 R3 的
      // 刻意的门槛(单实词命中太松),所以探针必须用真实措辞来测,而不是把阈值调松。
      if (!proactiveOn()) return no('前摄通道已关闭,不再注入(预期)');
      const text = proactiveHint(
        'write_file',
        { path: 'src/a.ts' },
        true,
        '这个功能有两种实现方案,你帮我解释一下区别并对比优劣',
      );
      return has(text, constraintId) ? ok('已弹出约束条目') : no(`未弹出(得到 ${text.slice(0, 80) || '(空)'})`);
    },
  },
  {
    id: 'A2',
    category: 'A 约束延续',
    requires: ['memory'],
    what: '约束在增强信息索引里可见(模型不必先搜索才知道它存在)',
    run: () => {
      if (!memoryOn()) return no('记忆已关闭,索引不可用(预期)');
      const section = buildMemoryIndexSection(memoryOn());
      return has(section, constraintId) ? ok('索引含该条目') : no('索引未含该条目');
    },
  },

  // ── B 坑复现 ───────────────────────────────────────────────────────────
  {
    id: 'B1',
    category: 'B 坑复现',
    requires: ['memory', 'proactive'],
    what: '同类操作(构造 schema)触发坑记忆的 trigger',
    run: () => {
      if (!proactiveOn()) return no('前摄通道已关闭,不再注入(预期)');
      const text = proactiveHint(
        'write_file',
        { path: 'src/llm/anthropic.ts' },
        true,
        '给 dashscope 构造工具 schema,把 uniqueItems 带上试试',
      );
      return has(text, pitfallTriggerId) ? ok('坑已被前摄弹出') : no(`未弹出(得到 ${text.slice(0, 80) || '(空)'})`);
    },
  },
  {
    id: 'B2',
    category: 'B 坑复现',
    requires: ['memory', 'proactive'],
    what: '只有锚点、没有 trigger 的 reference 记忆,在要改那个文件时出现(R3.6 弱通道)',
    run: () => {
      if (!proactiveOn()) return no('前摄通道已关闭,锚点弱通道随之关闭(预期)');
      const text = proactiveHint('edit_file', { path: SCHEMA_FILE }, true, '顺手补个注释');
      return has(text, anchorOnlyId) ? ok('锚点通道命中') : no(`未命中(得到 ${text.slice(0, 80) || '(空)'})`);
    },
  },
  {
    id: 'B3',
    category: 'B 坑复现',
    // 只依赖 memory:这条断言的是「前摄**不要**对 read_file 重复注入」,
    // 关掉前摄时它自然成立(与 B2 依赖 proactive 相反)。
    requires: ['memory'],
    what: '读文件时,该文件上的记忆在 tool 结果尾部回注(R2.4 与 B2 是两条独立送达路径)',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      const hits = listEntries({ status: 'active' }).filter((e) => e.id === anchorOnlyId);
      if (hits.length === 0) return no('条目不在 active 列表');
      if (!proactiveOn()) return ok('前摄关闭,不可能重复注入');
      const text = proactiveHint('read_file', { path: SCHEMA_FILE }, true, '读一下');
      // read_file 被刻意排除出前摄通道(避免与回注重复),所以这里断言"前摄不弹";
      // 回注本身由 read-file.ts 的 memoryHintFor 负责,单测在 tests/memory-anchor.test.ts。
      return text === ''
        ? ok('前摄未重复注入(回注由 read_file 自己负责)')
        : no(`前摄对 read_file 也注入了,会与回注重复: ${text.slice(0, 60)}`);
    },
  },

  // ── C 过期事实 ─────────────────────────────────────────────────────────
  {
    id: 'C1',
    category: 'C 过期事实',
    requires: ['memory'],
    what: '锚定代码被改后,列表读路径标记 anchorStale(读时判定,不写库)',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      const item = listEntries({ status: 'active' }).find((e) => e.id === staleAnchorId);
      if (!item) return no('条目不在 active 列表');
      return item.anchorStale === true ? ok('已标记 anchorStale') : no('未标记,过期事实会被当新鲜事实喂回去');
    },
  },
  {
    id: 'C2',
    category: 'C 过期事实',
    requires: ['memory', 'proactive'],
    what: '同一处代码再被操作时,前摄提醒必须带 STALE-CODE 而不是照抄旧内容',
    run: () => {
      if (!proactiveOn()) return no('前摄通道已关闭,不再注入(预期)');
      const text = proactiveHint('edit_file', { path: 'src/llm/deploy.ts' }, true, '把端口逻辑整理一下');
      if (!has(text, staleAnchorId)) return no('未命中该锚点记忆');
      return has(text, 'STALE-CODE') ? ok('带 STALE-CODE 标记') : no('命中了但没有过期标记');
    },
  },
  {
    id: 'C3',
    category: 'C 过期事实',
    requires: ['memory'],
    what: '派生条目在源被归档后判 stale(R14 级联失效)',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      const item = listEntries({ status: 'active' }).find((e) => e.id === derivedId);
      if (!item) return no('派生条目不在 active 列表');
      return item.stale === true ? ok('已标记 stale') : no('未标记:结论的根据没了却仍被当作可用');
    },
  },

  // ── D 冲突更新 ─────────────────────────────────────────────────────────
  {
    id: 'D1',
    category: 'D 冲突更新',
    requires: ['memory'],
    what: '默认检索只给新结论,旧结论不会挤掉它',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      const hits = searchEntries('部署端口', { limit: 3 });
      if (hits.length === 0) return no('返回空');
      const first = hits[0]?.id;
      if (first !== newDeployId) return no(`首位是 ${first},应为新条目 ${newDeployId}`);
      return hits.some((h) => h.id === oldDeployId) ? no('旧的(superseded)仍出现在默认检索里') : ok('只给新结论');
    },
  },
  {
    id: 'D2',
    category: 'D 冲突更新',
    requires: ['memory'],
    what: '显式查全状态时,active 稳定排在非 active 之前(R14.3 的排序修正)',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      const hits = searchEntries('部署端口', { status: 'any', limit: 5 });
      if (hits.length < 2) return no(`只返回 ${hits.length} 条,无法比较新旧`);
      const firstNonActive = hits.findIndex((h) => h.status !== 'active');
      const lastActive = hits.reduce((acc, h, i) => (h.status === 'active' ? i : acc), -1);
      if (firstNonActive < 0) return ok('全部 active,没有冲突条目');
      return lastActive < firstNonActive ? ok('active 全部排在非 active 之前') : no('非 active 排在 active 前面');
    },
  },

  // ── E 噪声抗性 ─────────────────────────────────────────────────────────
  {
    id: 'E1',
    category: 'E 噪声抗性',
    requires: [],
    what: '无关操作不触发任何提醒(否则提醒会被当作噪音忽略)',
    run: () => {
      if (!proactiveOn()) return ok('前摄关闭,不可能注入');
      const text = proactiveHint('write_file', { path: 'docs/readme.md' }, true, '整理一下项目说明的目录');
      return text === '' ? ok('未注入') : no(`无关场景注入了一条: ${text.slice(0, 80)}`);
    },
  },
  {
    id: 'E2',
    category: 'E 噪声抗性',
    // 依赖 memory:它测的是**检索**不做无重合召回,记忆关闭时这条通道整个不存在,
    // 不该判"通过"(否则 off 模式会白捡一票,消融表虚高)。
    requires: ['memory'],
    what: '与库内任何条目都无 token 重合的查询应返回空,而不是"最不相干的一条"',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      const hits = searchEntries('zzzqqqxyz', { limit: 3 });
      return hits.length === 0 ? ok('返回空') : no(`误召回 ${hits.length} 条: ${hits.map((h) => h.id).join(', ')}`);
    },
  },

  // ── F 情节延续(挂在 R6)────────────────────────────────────────────────
  {
    id: 'F1',
    category: 'A 约束延续',
    requires: ['memory', 'episodic'],
    what: '上个会话的情节在这轮启动时可见(最近 N 条小节)',
    run: () => {
      const gate = requireMemory();
      if (gate) return gate;
      if (process.env.MOCODE_MEMORY_EPISODIC === '0') return no('情节通道已关闭,小节不再注入(预期)');
      const section = buildEpisodeSection(memoryOn());
      if (!has(section, '## Recent sessions')) return no('无情节小节');
      return has(section, 'sess') || has(section, '[episode') ? ok('情节小节非空') : no('小节存在但没有内容');
    },
  },
];

// ── 运行 ──────────────────────────────────────────────────────────────────

interface ModeReport {
  mode: Mode;
  pass: number;
  total: number;
  /** 与「按通道依赖预测的结果」一致的数量。不一致说明开关没管住它,或依赖声明写错了。 */
  agreed: number;
  mismatches: string[];
  results: Array<{ probe: Probe; pass: boolean; detail: string; expected: boolean }>;
}

function expectedFor(probe: Probe, mode: Mode): boolean {
  return probe.requires.every((f) => mode.features.has(f));
}

function runMode(mode: Mode): ModeReport {
  applyMode(mode);
  const results: ModeReport['results'] = [];
  const mismatches: string[] = [];
  let pass = 0;
  for (const probe of PROBES) {
    // 每条探针前清冷却:否则同一进程里第一条命中后,后面的同条目探针会被 fired 挡住,
    // 测出来的是"冷却是否生效"而不是"通道是否送达"。
    resetCaches();
    applyMode(mode);
    let r: ProbeResult;
    try {
      r = probe.run();
    } catch (e) {
      r = no(`抛错: ${(e as Error).message}`);
    }
    const expected = expectedFor(probe, mode);
    if (r.pass) pass++;
    results.push({ probe, pass: r.pass, detail: r.detail, expected });
    if (r.pass !== expected) {
      mismatches.push(`${probe.id} 期望${expected ? '通过' : '不通过'},实际${r.pass ? '通过' : '不通过'}`);
    }
  }
  return { mode, pass, total: PROBES.length, agreed: PROBES.length - mismatches.length, mismatches, results };
}

function printReport(rep: ModeReport, verbose: boolean): void {
  const pct = (x: number): string => `${x}/${rep.total}`;
  console.log(`\n## ${rep.mode.label}  通过 ${pct(rep.pass)}  与预期一致 ${pct(rep.agreed)}`);
  if (rep.mismatches.length > 0) {
    console.log(`  与通道依赖不一致(${rep.mismatches.length}):`);
    for (const m of rep.mismatches) console.log(`    · ${m}`);
  }
  if (!verbose) return;
  let category = '';
  for (const r of rep.results) {
    if (r.probe.category !== category) {
      category = r.probe.category;
      console.log(`\n### ${category}`);
    }
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.probe.id} ${r.probe.what}`);
    if (!r.pass || r.detail) console.log(`      ${r.detail}`);
  }
}

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const verbose = argv.includes('-v') || argv.includes('--verbose');

console.log('R4.2 多会话记忆评测(确定性,无 LLM)');
console.log(`语料:临时工作区 ${proj}`);
console.log(`探针:${PROBES.length} 条 / 5 类题型`);

try {
  seedMemory();
  const modes = all ? MODES : [MODES.find((m) => m.label.startsWith('current'))!];
  const reports = modes.map((m) => runMode(m));
  for (const rep of reports) printReport(rep, verbose || reports.length === 1);

  if (all) {
    console.log('\n## R4.3 消融对照(同一组探针)');
    console.log('| 模式 | 通过 | 与通道依赖一致 |');
    console.log('|---|---|---|');
    for (const rep of reports) {
      const mark = rep.mode.label.startsWith('current') ? ' **←**' : '';
      console.log(`| ${rep.mode.label}${mark} | ${rep.pass}/${rep.total} | ${rep.agreed}/${rep.total} |`);
    }
    console.log('\n读法:通过数下降 = 该通道承载了探针;与预期不一致 = 开关没真的管住它,或探针的依赖声明写错了。');
  }

  const current = reports[reports.length - 1];
  const failed = current.results.filter((r) => r.expected && !r.pass);
  if (failed.length > 0) {
    console.log(
      `\nERROR: current 模式下有 ${failed.length} 条应通过的探针未通过: ${failed.map((f) => f.probe.id).join(', ')}`,
    );
    cleanup();
    process.exit(1);
  }
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(`评测异常: ${(e as Error).stack ?? e}`);
  cleanup();
  process.exit(2);
}
