/**
 * R11 情节巩固(episode → 语义)。
 *
 * 钉的是四件事(对应 design-notes/memory/memory.md §R11):
 *  1. R11.2 触发条件是**确定性的**:同主题 ≥3 条且跨 ≥2 个会话;单会话内的续集不巩固,
 *     两条也不巩固(过早抽象会把一次性的上下文固化成规则);
 *  2. R11.1 / R11.3 落库后语义条目带 `derivedFrom` 指向源情节,源情节带 `derivedInto`
 *     指回语义条目——双向链是 R14 级联失效与 R11 重复归纳防护共同的前提;
 *  3. R11.1 的「降权」= 已巩固情节走 3 天衰减(而非 7 天),但**不改 status**;
 *  4. 失败路径一条都不写:模型 skip、解析失败、开关关闭、无候选,库必须原样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import {
  applyConsolidation,
  findConsolidationGroups,
  isConsolidationEnabled,
  recordSessionEpisode,
} from '../src/memory/episodic.js';
import { saveEntry, loadAll, gcMemories, updateEntry } from '../src/memory/store.js';
import { __resetPendingRecallForTests } from '../src/memory/store.js';
import {
  __resetConsolidateThrottleForTests,
  kickoffConsolidation,
  runConsolidation,
  drainMemoryBackground,
  parseConsolidationPlan,
} from '../src/memory/reflect.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    // home / proj 必须分离:同目录会让 loadAll 把同一文件当 global 与 project 读两遍。
    const root = mkdtempSync(join(tmpdir(), 'mocode-consolidate-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    const epiEnv = process.env.MOCODE_MEMORY_EPISODIC;
    const conEnv = process.env.MOCODE_MEMORY_CONSOLIDATE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    process.env.MEMORY_ENABLED = 'true';
    delete process.env.MOCODE_MEMORY_EPISODIC;
    delete process.env.MOCODE_MEMORY_CONSOLIDATE;
    try {
      await fn();
    } finally {
      __setChatCreateImpl(null);
      __resetConsolidateThrottleForTests();
      __resetPendingRecallForTests();
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      if (epiEnv === undefined) delete process.env.MOCODE_MEMORY_EPISODIC;
      else process.env.MOCODE_MEMORY_EPISODIC = epiEnv;
      if (conEnv === undefined) delete process.env.MOCODE_MEMORY_CONSOLIDATE;
      else process.env.MOCODE_MEMORY_CONSOLIDATE = conEnv;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function sse(content: string | null): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
  };
}

const DRAFT = JSON.stringify({
  skip: false,
  type: 'pitfall',
  name: 'dashscope tool schema strips uniqueItems',
  summary: '给 dashscope compatible-mode 的工具 schema 必须递归剔除 uniqueItems',
  body: 'dashscope compatible-mode 遇到 schema 里的 uniqueItems 会整请求 400。\n在 tool-schema.ts 递归剔除。',
  trigger: '构造工具 schema 且后端是 dashscope compatible-mode 时',
  action: '跑一遍 strip，确认 schema 里没有 uniqueItems',
});

/** 造一条同主题情节:三个会话、同一个文件、同一类请求(措辞不同,避免 dedupKey 合并)。 */
function seedTheme(sessions = ['s-a', 's-b', 's-c']): string[] {
  const ids: string[] = [];
  const phrasings = [
    '修一下 tool schema 在 dashscope 下的兼容性问题,报 400',
    'dashscope 又拒了 tool schema,查一下是不是 uniqueItems',
    '再确认一遍 tool schema 的 dashscope 兼容性,顺手补测试',
  ];
  sessions.forEach((s, i) => {
    const r = recordSessionEpisode({
      sessionId: s,
      queries: [phrasings[i % phrasings.length]!],
      changedFiles: ['src/llm/tool-schema.ts'],
    });
    assert.ok(r.ok, `前置:情节 ${s} 应写入成功`);
    ids.push(r.id);
  });
  return ids;
}

const episodes = () => loadAll().filter((e) => e.type === 'episode');

const projectFile = (): string => join(process.cwd(), '.mocode', 'memory.jsonl');

/** 回拨时间(直接改 JSONL,模拟时间流逝)。 */
function backdate(ids: readonly string[], days: number): void {
  const file = projectFile();
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const iso = new Date(Date.now() - days * 86400000).toISOString();
  const out = lines.map((l) => {
    const e = JSON.parse(l) as Record<string, unknown>;
    if (!ids.includes(String(e.id))) return l;
    e.createdAt = iso;
    e.updatedAt = iso;
    e.lastRecalledAt = null;
    return JSON.stringify(e);
  });
  writeFileSync(file, out.join('\n') + '\n', 'utf8');
}

// ── R11.2 确定性分组 ──────────────────────────────────────────────────────

test(
  'findConsolidationGroups:3 条同主题情节跨 3 个会话 → 成一组',
  isolated(() => {
    const ids = seedTheme();
    const groups = findConsolidationGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.members.length, 3);
    assert.equal(groups[0]!.sessions, 3);
    assert.deepEqual([...groups[0]!.members.map((m) => m.entry.id)].sort(), [...ids].sort());
    // 共享文件是主题锚点,要给模型看
    assert.deepEqual(groups[0]!.sharedFiles, ['src/llm/tool-schema.ts']);
    // 序列化里每条成员都带 id 与请求
    assert.ok(groups[0]!.input.includes('(session s-a)'));
    assert.ok(groups[0]!.input.includes('tool schema'));
  }),
);

test(
  'findConsolidationGroups:只有 2 条 → 不巩固(过早抽象会把偶然固化成规则)',
  isolated(() => {
    seedTheme(['s-a', 's-b']);
    assert.equal(findConsolidationGroups().length, 0);
  }),
);

test(
  'findConsolidationGroups:3 条但同属一个会话 → 不巩固(那是续集,不是模式)',
  isolated(() => {
    // 不能走 recordSessionEpisode(它对同会话幂等),直接写库模拟「同会话多条情节」。
    // body 必须各不相同:saveEntry 的 dedupKey 按 summary+body 算,内容相同会只留一条。
    for (const n of [1, 2, 3]) {
      const r = saveEntry({
        type: 'episode',
        name: `episode chunk ${n}`,
        summary: `1 个请求;改动 1 个文件 (chunk ${n})`,
        body: `## 请求\n- 修 tool schema 兼容性 第 ${n} 轮\n\n## 改动\n- src/llm/tool-schema.ts`,
        scope: 'project',
        source: { session: 'one-session' },
      });
      assert.ok(r.ok);
    }
    assert.equal(episodes().length, 3);
    assert.equal(findConsolidationGroups().length, 0, '跨会话数不足 2 时不得巩固');
  }),
);

test(
  'findConsolidationGroups:文件不同但请求词元重合够多 → 仍成组',
  isolated(() => {
    const queries = '修一下 tool schema 在 dashscope 下的兼容性问题';
    for (const [s, f] of [
      ['s-a', 'src/llm/tool-schema.ts'],
      ['s-b', 'src/llm/anthropic.ts'],
      ['s-c', 'src/llm/vertex.ts'],
    ] as const) {
      recordSessionEpisode({ sessionId: s, queries: [queries], changedFiles: [f] });
    }
    const groups = findConsolidationGroups();
    assert.equal(groups.length, 1, '词元重合应当弥补文件不同');
    assert.ok(groups[0]!.sharedTokens.length > 0, '词元重合时 sharedTokens 应作为主题锚点');
  }),
);

test(
  'findConsolidationGroups:无关情节聚不成组(全是无关的独立请求)',
  isolated(() => {
    recordSessionEpisode({ sessionId: 's-a', queries: ['整理 README 目录结构'], changedFiles: ['README.md'] });
    recordSessionEpisode({ sessionId: 's-b', queries: ['升级 pnpm lockfile 版本'], changedFiles: ['pnpm-lock.yaml'] });
    recordSessionEpisode({ sessionId: 's-c', queries: ['调整终端主题配色'], changedFiles: ['src/ui/theme.ts'] });
    assert.equal(findConsolidationGroups().length, 0);
  }),
);

test(
  'findConsolidationGroups:过半情节都改的文件不算主题证据(否则入口文件把全库粘成一组)',
  isolated(() => {
    // 6 条情节、请求主题互不相关,唯一的共同点是都改了 src/index.ts。
    // commonCut = max(3, ceil(6×0.6)) = 4,而 index.ts 出现 6 次 > 4 → 不 distinctive。
    // 若没有这条过滤,真实仓库里"人人都动过入口文件"会让整个库一夜之间归为一组。
    const topics = [
      '修改启动横幅的 logo 布局',
      '升级 pnpm 依赖锁定文件版本',
      '调整终端主题的配色方案',
      '整理相机固件的说明文档',
      '排查数据库连接池泄漏',
      '重构剪贴板图片压缩逻辑',
    ];
    ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'].forEach((sid, i) => {
      const r = recordSessionEpisode({ sessionId: sid, queries: [topics[i]!], changedFiles: ['src/index.ts'] });
      assert.ok(r.ok);
    });
    assert.equal(findConsolidationGroups().length, 0, '共享的入口文件不得把无关情节粘成一组');
  }),
);

test(
  'findConsolidationGroups:同一批情节里加一个未过半的文件 → 只按它成组,且不把公共文件报成主题',
  isolated(() => {
    const topics = [
      '修改启动横幅的 logo 布局',
      '升级 pnpm 依赖锁定文件版本',
      '调整终端主题的配色方案',
      '整理相机固件的说明文档',
      '排查数据库连接池泄漏',
      '重构剪贴板图片压缩逻辑',
    ];
    // s-a/s-b/s-c 额外共享 src/ui/render.ts(3 次 ≤ commonCut 4 → distinctive)。
    const distinctiveOn = new Set(['s-a', 's-b', 's-c']);
    ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'].forEach((sid, i) => {
      const files = distinctiveOn.has(sid) ? ['src/index.ts', 'src/ui/render.ts'] : ['src/index.ts'];
      const r = recordSessionEpisode({ sessionId: sid, queries: [topics[i]!], changedFiles: files });
      assert.ok(r.ok);
    });
    const groups = findConsolidationGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.members.length, 3, '只有额外共享 render.ts 的三条成组');
    assert.equal(groups[0]!.sessions, 3);
    // 主题锚点只列 distinctive 的文件:index.ts 是公共噪音,不能出现在提示词里误导模型。
    assert.deepEqual(groups[0]!.sharedFiles, ['src/ui/render.ts']);
  }),
);

test(
  'findConsolidationGroups:已 derivedInto 的情节不再进组(防重复归纳)',
  isolated(() => {
    seedTheme();
    const groups = findConsolidationGroups();
    assert.equal(groups.length, 1);
    const applied = applyConsolidation(groups[0]!, {
      type: 'pitfall',
      name: 'tmp consolidation',
      summary: 's',
      body: 'b',
    });
    assert.ok(applied.ok);
    assert.equal(findConsolidationGroups().length, 0, '巩固过的情节必须退出候选池');
  }),
);

// ── R11.1 / R11.3 落库与双向链 ────────────────────────────────────────────

test(
  'applyConsolidation:写语义条目(derivedFrom 指源情节),源情节 derivedInto 指回',
  isolated(() => {
    const ids = seedTheme();
    const group = findConsolidationGroups()[0]!;
    const r = applyConsolidation(group, {
      type: 'pitfall',
      name: 'dashscope schema uniqueItems',
      summary: 'dashscope 收到 uniqueItems 会 400',
      body: 'detail',
      trigger: '构造 tool schema 时',
      action: '递归剔除 uniqueItems',
    });
    assert.ok(r.ok);
    assert.equal(r.created, true);
    const semantic = loadAll().find((e) => e.id === r.id);
    assert.ok(semantic);
    assert.equal(semantic.type, 'pitfall', '巩固产物是语义,不是又一条 episode');
    assert.deepEqual([...(semantic.derivedFrom ?? [])].sort(), [...ids].sort());
    assert.equal(semantic.trigger, '构造 tool schema 时');
    for (const id of ids) {
      assert.equal(loadAll().find((e) => e.id === id)?.derivedInto, r.id, `${id} 应指回语义条目`);
    }
    // 成员情节本身不进 R14 stale:源是 active,语义条目不该一落库就「根据失效」
    assert.equal(loadAll().filter((e) => e.derivedFrom?.includes(ids[0]!)).length, 1);
  }),
);

test(
  'applyConsolidation:type 只接受语义类型,episode 被降级为 fact',
  isolated(() => {
    seedTheme();
    const group = findConsolidationGroups()[0]!;
    const r = applyConsolidation(group, {
      type: 'episode',
      name: 'should not be an episode',
      summary: 's',
      body: 'b',
    });
    assert.ok(r.ok);
    assert.equal(loadAll().find((e) => e.id === r.id)?.type, 'fact');
  }),
);

test(
  'applyConsolidation:name/summary/body 缺一不可 → 不写库、不动成员',
  isolated(() => {
    const ids = seedTheme();
    const group = findConsolidationGroups()[0]!;
    const before = loadAll().length;
    const r = applyConsolidation(group, { name: '', summary: 's', body: 'b' });
    assert.equal(r.ok, false);
    assert.equal(loadAll().length, before);
    for (const id of ids) {
      assert.equal(loadAll().find((e) => e.id === id)?.derivedInto, undefined);
    }
  }),
);

test(
  'applyConsolidation:语义条目已存在(同 dedupKey)→ 复用既有 id,仍补齐 derivedInto',
  isolated(() => {
    const ids = seedTheme();
    const group = findConsolidationGroups()[0]!;
    const first = applyConsolidation(group, { name: 'n1', summary: '同一个总结', body: '同一段正文' });
    assert.ok(first.ok);
    // 清掉标记,让同一批情节重新进候选池,模拟「换个名字又归纳了一次」
    for (const id of ids) updateEntry(id, { derivedInto: '' });
    const group2 = findConsolidationGroups()[0]!;
    const second = applyConsolidation(group2, { name: 'n2-other-name', summary: '同一个总结', body: '同一段正文' });
    assert.ok(second.ok);
    assert.equal(second.created, false, 'dedupKey 命中应复用而非新建');
    assert.equal(second.id, first.id);
    for (const id of ids) {
      assert.equal(loadAll().find((e) => e.id === id)?.derivedInto, first.id);
    }
    assert.equal(loadAll().filter((e) => e.type !== 'episode').length, 1, '不得产生第二条重复语义条目');
  }),
);

// ── R11.1 降权:已巩固情节走 3 天衰减 ──────────────────────────────────────

test(
  'gcMemories:已巩固情节 3 天衰减,未巩固的仍按 7 天',
  isolated(() => {
    const ids = seedTheme();
    const [a, b, c] = ids as [string, string, string];
    const group = findConsolidationGroups()[0]!;
    applyConsolidation(group, { name: 'sem', summary: 's', body: 'b' });
    // a/b/c 都已被标记 → 都会 3 天衰减。再造一条没被巩固的做对照。
    const solo = saveEntry({
      type: 'episode',
      name: 'session solo',
      summary: '1 个请求',
      body: '## 请求\n- 完全不同的话题',
      scope: 'project',
      source: { session: 'solo' },
    });
    assert.ok(solo.ok);
    backdate([a, b, c, solo.id], 5);
    gcMemories();
    const byId = (id: string) => loadAll().find((e) => e.id === id);
    assert.equal(byId(a)?.status, 'archived', '已巩固情节 5 天应已衰减(周期 3 天)');
    assert.equal(byId(c)?.status, 'archived');
    assert.equal(byId(solo.id)?.status, 'active', '未巩固情节 5 天仍在(周期 7 天)');
  }),
);

// ── 失败路径:一条都不写 ─────────────────────────────────────────────────

test(
  'kickoffConsolidation:无候选时零成本返回,不发任何 LLM 请求',
  isolated(async () => {
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return sse(DRAFT);
    });
    kickoffConsolidation();
    await drainMemoryBackground();
    assert.equal(calls, 0, '没有候选组就不该压请求给后端');
  }),
);

test(
  'kickoffConsolidation:开关关闭时不发请求也不写库',
  isolated(async () => {
    seedTheme();
    process.env.MOCODE_MEMORY_CONSOLIDATE = '0';
    assert.equal(isConsolidationEnabled(), false);
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return sse(DRAFT);
    });
    kickoffConsolidation();
    await drainMemoryBackground();
    assert.equal(calls, 0);
    assert.equal(loadAll().filter((e) => e.type !== 'episode').length, 0);
  }),
);

test(
  'runConsolidation:模型 skip → 不算巩固、不写库',
  isolated(async () => {
    const ids = seedTheme();
    __setChatCreateImpl(async () => sse('{"skip":true,"reason":"只是碰巧同目录"}'));
    const r = await runConsolidation(undefined);
    assert.equal(r.groups, 1);
    assert.equal(r.consolidated, 0);
    assert.equal(r.skipped, 1);
    assert.equal(loadAll().filter((e) => e.type !== 'episode').length, 0);
    for (const id of ids) assert.equal(loadAll().find((e) => e.id === id)?.derivedInto, undefined);
  }),
);

test(
  'runConsolidation:解析失败(含修复式重试)→ 不写库,成员保持可再试',
  isolated(async () => {
    const ids = seedTheme();
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return sse('这不是 JSON');
    });
    const r = await runConsolidation(undefined);
    assert.equal(calls, 2, '首轮失败应有一次修复式重试');
    assert.equal(r.consolidated, 0);
    assert.equal(r.error, 'parse-failed');
    assert.equal(loadAll().filter((e) => e.type !== 'episode').length, 0);
    // 关键:失败后成员没有被标记,下一轮还能再试(否则这条通道静默失效)
    for (const id of ids) assert.equal(loadAll().find((e) => e.id === id)?.derivedInto, undefined);
    assert.equal(findConsolidationGroups().length, 1);
  }),
);

test(
  'runConsolidation:LLM 抛错 → 不写库',
  isolated(async () => {
    seedTheme();
    __setChatCreateImpl(async () => {
      throw new Error('backend down');
    });
    const r = await runConsolidation(undefined);
    assert.equal(r.consolidated, 0);
    assert.ok(r.error);
    assert.equal(loadAll().filter((e) => e.type !== 'episode').length, 0);
  }),
);

// ── 端到端:kickoff → 落库 ────────────────────────────────────────────────

test(
  'kickoffConsolidation:端到端写出语义条目并标记成员',
  isolated(async () => {
    const ids = seedTheme();
    __setChatCreateImpl(async () => sse(DRAFT));
    kickoffConsolidation();
    await drainMemoryBackground();
    const semantic = loadAll().filter((e) => e.type !== 'episode');
    assert.equal(semantic.length, 1);
    assert.deepEqual([...(semantic[0]!.derivedFrom ?? [])].sort(), [...ids].sort());
    for (const id of ids) {
      assert.equal(loadAll().find((e) => e.id === id)?.derivedInto, semantic[0]!.id);
    }
  }),
);

test(
  'kickoffConsolidation:同一批情节不会反复归纳(第二次已无候选)',
  isolated(async () => {
    seedTheme();
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return sse(DRAFT);
    });
    kickoffConsolidation();
    await drainMemoryBackground();
    const firstCalls = calls;
    kickoffConsolidation();
    await drainMemoryBackground();
    assert.equal(calls, firstCalls, '成员已标记 derivedInto,第二轮应零请求');
    assert.equal(loadAll().filter((e) => e.type !== 'episode').length, 1);
  }),
);

// ── 纯函数:解析 ──────────────────────────────────────────────────────────

test('parseConsolidationPlan:skip / 围栏 / 尾部逗号 / 残缺字段', () => {
  assert.deepEqual(parseConsolidationPlan('{"skip":true}'), { skip: true, reason: undefined });
  const fenced = parseConsolidationPlan('```json\n' + DRAFT + '\n```');
  assert.ok(fenced && !fenced.skip);
  if (fenced && !fenced.skip) {
    assert.equal(fenced.draft.name, 'dashscope tool schema strips uniqueItems');
    assert.equal(fenced.draft.type, 'pitfall');
  }
  // 尾逗号容错
  const trailing = parseConsolidationPlan('{"name":"n","summary":"s","body":"b",}');
  assert.ok(trailing && !trailing.skip);
  // 缺 body → null(残缺产物不进库)
  assert.equal(parseConsolidationPlan('{"name":"n","summary":"s"}'), null);
  assert.equal(parseConsolidationPlan('不是 JSON'), null);
  assert.equal(parseConsolidationPlan(null), null);
});
