/**
 * R6 情节记忆的**胶水层**:`src/repl/episode-finalize.ts`。
 *
 * 为什么单独一个测试文件:`memory-episode.test.ts` 测的是 `recordSessionEpisode`(叶子层,
 * 只认传入的参数),而生产路径真正调用的是 `finalizeCurrentEpisode` —— 它负责从
 * `history` 抽改动文件、从 `notes.md` 抽未完成步骤、再做开关判定。三个来源横跨
 * repl / session / config 三个子系统,是这条通道最容易**静默失效**的地方:
 * 抽出为空不会报错,只会悄悄生成一条「0 个请求;0 项未完成」的空情节。
 *
 * 钉五件事:
 *  1. notes.md 必须从 **sandboxRoot** 读,而不是 process.cwd()(--sandbox-root 下两者不同);
 *  2. 三个来源(queries / changedFiles / pendingSteps)都能落到 body 里;
 *  3. 压缩摘要能被复用(长会话唯一的高质量叙述来源);
 *  4. 无 notes、无 sessionId、memory 关闭时既不崩也不写库;
 *  5. 幂等:同一会话重复 finalize(退出 + /clear + /resume 会连续触发)只刷新一条。
 *
 * 隔离要点(踩过的坑):`store.ts` 的 `projectPath()` 用 `process.cwd()` 而不是 sandboxRoot,
 * 所以 isolated() 里**必须 chdir**;只设 sandboxRoot 会让测试写进仓库真实的
 * `.mocode/memory.jsonl`,把开发者的记忆库污染成测试数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { finalizeCurrentEpisode } from '../src/repl/episode-finalize.js';
import { loadAll, __resetPendingRecallForTests } from '../src/memory/store.js';
import type { ChatMessage } from '../src/llm/index.js';

interface Dirs {
  /** notes 的来源(sandboxRoot),也是默认 cwd —— 对应常态:两者一致。 */
  projDir: string;
  /** 备用工作目录:用来证明 notes 不是从 cwd 读的。 */
  otherDir: string;
}

function isolated(fn: (dirs: Dirs) => void | Promise<void>): () => Promise<void> {
  return async () => {
    // home / proj / other 三者分离:home→global 记忆,proj→project 记忆 + sandboxRoot。
    const root = mkdtempSync(join(tmpdir(), 'mocode-episode-finalize-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    const otherDir = join(root, 'other');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    const env = {
      home: process.env.HOME,
      up: process.env.USERPROFILE,
      mem: process.env.MEMORY_ENABLED,
      epi: process.env.MOCODE_MEMORY_EPISODIC,
    };
    const cwd = process.cwd();
    const prevRoot = setSandboxRoot(projDir);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.MEMORY_ENABLED = 'true';
    delete process.env.MOCODE_MEMORY_EPISODIC;
    // 必须 chdir:project 记忆库落在 cwd,不切就会写进仓库真实库。
    process.chdir(projDir);
    try {
      await fn({ projDir, otherDir });
    } finally {
      __resetPendingRecallForTests();
      setSandboxRoot(prevRoot);
      for (const [k, v] of [
        ['HOME', env.home],
        ['USERPROFILE', env.up],
        ['MEMORY_ENABLED', env.mem],
        ['MOCODE_MEMORY_EPISODIC', env.epi],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 在指定根下写 notes.md。 */
function writeNotes(root: string, sessionId: string, body: string): void {
  const dir = join(root, '.mocode', 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.md'), body, 'utf8');
}

const PLAN_NOTES = [
  '## Plan: 做记忆',
  '',
  '### Steps',
  '- [x] 1. 已完成的步骤',
  '- [ ] 2. 未完成步骤 A',
  '- [ ] 3. 未完成步骤 B',
  '',
].join('\n');

/** 构造一段带写类工具调用的 history。 */
function historyWithWrite(path: string): ChatMessage[] {
  return [
    { role: 'system', content: 'base' },
    { role: 'user', content: '改一下这个文件' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'edit_file', arguments: JSON.stringify({ path }) } }],
    } as unknown as ChatMessage,
  ];
}

const episodes = () => loadAll().filter((e) => e.type === 'episode');

// ── 三个来源都能落地 ──────────────────────────────────────────────────────

test(
  'finalizeCurrentEpisode:queries + 改动文件 + notes 未完成步骤全部进 body',
  isolated(({ projDir }) => {
    const sid = 'sess-full';
    writeNotes(projDir, sid, PLAN_NOTES);
    const r = finalizeCurrentEpisode(sid, historyWithWrite('src/memory/store.ts'), ['实现情节记忆', '再补测试']);
    assert.ok(r.ok, `应写入成功,实际 ${JSON.stringify(r)}`);
    const e = episodes()[0];
    assert.ok(e);
    assert.equal(e.source?.session, sid);
    assert.match(e.summary, /2 个请求/);
    assert.match(e.summary, /改动 1 个文件/);
    assert.match(e.summary, /2 项未完成/);
    assert.ok(e.body.includes('- 实现情节记忆'), '请求来自 queries');
    assert.ok(e.body.includes('- src/memory/store.ts'), '改动文件来自 history 的 tool_calls');
    assert.ok(e.body.includes('- 未完成步骤 A'), '未完成项来自 notes.md');
    assert.ok(!e.body.includes('已完成的步骤'), '已完成步骤不该被当成未完成');
  }),
);

test(
  'finalizeCurrentEpisode:长会话复用 history 里的压缩摘要',
  isolated(() => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'base' },
      { role: 'system', content: '# 会话摘要\n\n## Objective\n把记忆接通' },
      ...historyWithWrite('src/a.ts'),
    ];
    const r = finalizeCurrentEpisode('sess-summary', history, ['q1']);
    assert.ok(r.ok);
    const e = episodes()[0];
    assert.ok(e);
    assert.ok(e.body.includes('## 压缩摘要'), '长会话应复用模型自己写的摘要');
    assert.ok(e.body.includes('把记忆接通'));
  }),
);

// ── 关键边界:notes 从 sandboxRoot 读,不是 cwd ───────────────────────────

test(
  'finalizeCurrentEpisode:notes 从 sandboxRoot 读,不受 cwd 里同名文件影响',
  isolated(({ projDir, otherDir }) => {
    const sid = 'sess-sandbox';
    writeNotes(projDir, sid, PLAN_NOTES);
    // 诱饵:同名会话、同文件名,但内容不同,放在**非** sandboxRoot 的目录里。
    writeNotes(otherDir, sid, ['## Plan: 诱饵', '', '- [ ] 不该出现的步骤', ''].join('\n'));
    process.chdir(otherDir);

    const r = finalizeCurrentEpisode(sid, historyWithWrite('src/x.ts'), ['q']);
    assert.ok(r.ok);
    const e = episodes()[0];
    assert.ok(e);
    assert.ok(e.body.includes('未完成步骤 A'), '必须读 sandboxRoot 下的 notes');
    assert.ok(!e.body.includes('不该出现的步骤'), 'cwd 下的同名 notes 是诱饵,绝不能被读到');
  }),
);

// ── 不崩、不乱写 ─────────────────────────────────────────────────────────

test(
  'finalizeCurrentEpisode:无 sessionId → no-session,零写入',
  isolated(() => {
    const r = finalizeCurrentEpisode(undefined, historyWithWrite('src/a.ts'), ['q']);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'no-session');
    assert.equal(loadAll().length, 0);
  }),
);

test(
  'finalizeCurrentEpisode:memory 关闭 → disabled,零写入',
  isolated(() => {
    process.env.MEMORY_ENABLED = 'false';
    const r = finalizeCurrentEpisode('sess-off', historyWithWrite('src/a.ts'), ['q']);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'disabled');
    assert.equal(loadAll().length, 0);
  }),
);

test(
  'finalizeCurrentEpisode:MOCODE_MEMORY_EPISODIC=0 → disabled,零写入',
  isolated(() => {
    process.env.MOCODE_MEMORY_EPISODIC = '0';
    const r = finalizeCurrentEpisode('sess-epi-off', historyWithWrite('src/a.ts'), ['q']);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'disabled');
    assert.equal(loadAll().length, 0);
  }),
);

test(
  'finalizeCurrentEpisode:无 notes 文件不崩,摘要只报请求数',
  isolated(() => {
    const r = finalizeCurrentEpisode('sess-no-notes', [], ['只有这句请求']);
    assert.ok(r.ok);
    const e = episodes()[0];
    assert.ok(e);
    assert.equal(e.summary, '1 个请求');
    assert.ok(!e.body.includes('## 未完成'));
  }),
);

test(
  'finalizeCurrentEpisode:空会话(无请求且无摘要)→ 不产情节',
  isolated(() => {
    const r = finalizeCurrentEpisode('sess-empty', [], []);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'empty');
    assert.equal(loadAll().length, 0);
  }),
);

// ── 幂等 ─────────────────────────────────────────────────────────────────

test(
  'finalizeCurrentEpisode:同一会话连续 finalize(退出 + /clear + /resume)只刷新一条',
  isolated(({ projDir }) => {
    const sid = 'sess-idem';
    writeNotes(projDir, sid, PLAN_NOTES);
    const first = finalizeCurrentEpisode(sid, historyWithWrite('src/a.ts'), ['q1']);
    assert.ok(first.ok);
    assert.equal(first.updated, false);
    // 第二次多一轮请求,内容应被刷新而不是新增
    const second = finalizeCurrentEpisode(sid, historyWithWrite('src/b.ts'), ['q1', 'q2']);
    assert.ok(second.ok);
    assert.equal(second.updated, true);
    assert.equal(second.id, first.id);
    assert.equal(episodes().length, 1);
    assert.match(episodes()[0]!.summary, /2 个请求/);
  }),
);
