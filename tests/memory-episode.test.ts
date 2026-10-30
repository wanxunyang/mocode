/**
 * R6 情节记忆:让新会话知道「最近发生了什么」。
 *
 * 钉的是四件事(对应 design-notes/memory/memory.md §R6):
 *  1. R6.2 episode 与事实记忆走**两套生命周期**:7 天衰减 / 30 天硬删,且不占 MAX_ACTIVE 名额
 *     —— 否则每会话一条会在两个月内把长期知识挤出封顶(「情节淹没语义」);
 *  2. R6.1 产出是确定性的、零 LLM:空会话不产、同会话幂等(只刷新不新增);
 *  3. R6.3 注入独立小节、硬上限 3 条、最新在前,且**不进** Memory Index;
 *  4. 双层开关:memory 总开关 veto 优先于 MOCODE_MEMORY_EPISODIC。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEpisode,
  buildEpisodeSection,
  collectChangedFiles,
  extractCompactionSummary,
  isEpisodicEnabled,
  listEpisodes,
  parsePendingSteps,
  recordSessionEpisode,
} from '../src/memory/episodic.js';
import { buildMemoryIndexSection, gcMemories, loadAll, saveEntry, forgetEntry } from '../src/memory/store.js';
import { __resetPendingRecallForTests } from '../src/memory/store.js';
import { MAX_ACTIVE } from '../src/tools/constants.js';
import type { ChatMessage } from '../src/llm/index.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    // home / proj 必须分离:同目录会让 loadAll 把同一文件当 global 与 project 读两遍。
    const root = mkdtempSync(join(tmpdir(), 'mocode-episode-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    const epiEnv = process.env.MOCODE_MEMORY_EPISODIC;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    process.env.MEMORY_ENABLED = 'true';
    delete process.env.MOCODE_MEMORY_EPISODIC;
    try {
      await fn();
    } finally {
      __resetPendingRecallForTests();
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      if (epiEnv === undefined) delete process.env.MOCODE_MEMORY_EPISODIC;
      else process.env.MOCODE_MEMORY_EPISODIC = epiEnv;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const projectFile = (): string => join(process.cwd(), '.mocode', 'memory.jsonl');

/** 把某条目的时间字段回拨 days 天(直接改 JSONL,模拟时间流逝)。 */
function backdate(id: string, days: number, fields: ('createdAt' | 'updatedAt')[] = ['createdAt']): void {
  const file = projectFile();
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const iso = new Date(Date.now() - days * 86400000).toISOString();
  const out = lines.map((l) => {
    const e = JSON.parse(l) as Record<string, unknown>;
    if (e.id !== id) return l;
    for (const f of fields) e[f] = iso;
    if (fields.includes('createdAt')) e.lastRecalledAt = null;
    return JSON.stringify(e);
  });
  writeFileSync(file, out.join('\n') + '\n', 'utf8');
}

function seedFact(name: string): string {
  const r = saveEntry({ name, summary: `${name} 摘要`, body: 'b' });
  assert.ok(r.ok, `前置:${name} 应写入成功`);
  return (r as { ok: true; id: string }).id;
}

// ── R6.1 产出:确定性、幂等、有界 ───────────────────────────────────────────

test('buildEpisode:无请求且无摘要 → null(空会话不占注入位)', () => {
  assert.equal(buildEpisode({ sessionId: 's1', queries: [] }), null);
  assert.equal(buildEpisode({ sessionId: 's1', queries: ['   '], summaryText: '  ' }), null);
});

test('buildEpisode:摘要行是可扫读结构;请求只保留最近 N 条', () => {
  const queries = Array.from({ length: 12 }, (_, i) => `请求 ${i}`);
  const d = buildEpisode({
    sessionId: 's1',
    queries,
    changedFiles: ['a.ts', 'b.ts', 'a.ts'],
    pendingSteps: ['没做完的事'],
  });
  assert.ok(d);
  assert.equal(d.summary, '12 个请求;改动 2 个文件;1 项未完成');
  // 只保留最后 8 条(EPISODE_MAX_REQUESTS):episode 是摘要索引,不是转录副本(R6.4)。
  assert.ok(d.body.includes('请求 11'));
  assert.ok(!d.body.includes('- 请求 0'));
  // 去重后的文件列表
  assert.equal(d.body.match(/^- a\.ts$/gm)?.length, 1);
});

test('buildEpisode:单条请求压平成一行并截断(不让一轮长输入吃掉整条 episode)', () => {
  const d = buildEpisode({ sessionId: 's1', queries: [`第一行\n第二行\t${'x'.repeat(400)}`] });
  assert.ok(d);
  const reqLine = d.body.split('\n').find((l) => l.startsWith('- 第一行'));
  assert.ok(reqLine, '应有一行请求');
  assert.ok(!reqLine.includes('\n'));
  assert.ok(reqLine.length < 130, `请求行应被截断,实际 ${reqLine.length}`);
});

test(
  'recordSessionEpisode:同一会话重复 finalize 只刷新同一条(幂等)',
  isolated(() => {
    const first = recordSessionEpisode({ sessionId: 'sess-a', queries: ['做 X'] });
    assert.ok(first.ok);
    assert.equal(first.updated, false);
    const second = recordSessionEpisode({ sessionId: 'sess-a', queries: ['做 X', '再做 Y'] });
    assert.ok(second.ok);
    assert.equal(second.updated, true);
    assert.equal(second.id, first.id, '同一会话不得产生第二条');
    const episodes = loadAll().filter((e) => e.type === 'episode');
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].summary, '2 个请求');
  }),
);

test(
  'recordSessionEpisode:写入 type=episode、scope=project、source.session 可追溯',
  isolated(() => {
    const r = recordSessionEpisode({ sessionId: 'sess-b', queries: ['q'] });
    assert.ok(r.ok);
    const e = loadAll().find((x) => x.id === r.id);
    assert.ok(e);
    assert.equal(e.type, 'episode');
    assert.equal(e.scope, 'project', '情节是工作区内的「上次干到哪」,不进 global');
    assert.equal(e.source?.session, 'sess-b');
  }),
);

// ── 内容抽取(纯函数)─────────────────────────────────────────────────────

test('parsePendingSteps:只取活跃 ## Plan: 段的未完成项,忽略已完成与 ## Done:', () => {
  const notes = [
    '## Plan: 做记忆',
    '### Steps',
    '- [x] 1. **已完成** — done',
    '- [ ] 2. **未完成** — todo A',
    '- [ ] 3. 未完成 B',
    '',
    '## Done: 旧计划',
    '- [ ] 不该被算作未完成',
    '',
    '## Findings',
    '- [ ] 笔记里的复选框不是 plan 步骤',
  ].join('\n');
  // 段内序号(`2. `/`3. `)是 plan 里的位置信息,搬进情节后无意义,读取时剥掉。
  assert.deepEqual(parsePendingSteps(notes), ['**未完成** — todo A', '未完成 B']);
  assert.deepEqual(parsePendingSteps(null), []);
  assert.deepEqual(parsePendingSteps(''), []);
});

test('extractCompactionSummary:取最近一条摘要正文,无则 null', () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'base prompt' },
    { role: 'user', content: 'q' },
    { role: 'system', content: '# 会话摘要\n\n## Objective\n旧摘要' },
    { role: 'system', content: '# 会话摘要\n\n## Objective\n新摘要' },
  ];
  assert.equal(extractCompactionSummary(history), '## Objective\n新摘要');
  assert.equal(extractCompactionSummary([{ role: 'system', content: 'base' }]), null);
});

test('collectChangedFiles:只认写类工具的 path 参数,不把 content 里的路径当改动', () => {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: '1', function: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"src/b.ts"}' } },
        { id: '2', function: { name: 'read_file', arguments: '{"path":"src/c.ts"}' } },
        { id: '3', function: { name: 'write_file', arguments: '{"path":"src/d.ts","content":"x"}' } },
        { id: '4', function: { name: 'grep', arguments: '{"pattern":"src/e.ts"}' } },
      ],
    } as unknown as ChatMessage,
  ];
  assert.deepEqual(collectChangedFiles(history).sort(), ['src/a.ts', 'src/d.ts']);
});

// ── R6.2 生命周期分化 ──────────────────────────────────────────────────────

test(
  'R6.2:episode 8 天就衰减,同样龄期的事实记忆不动',
  isolated(() => {
    const ep = recordSessionEpisode({ sessionId: 'sess-old', queries: ['老会话'] });
    assert.ok(ep.ok);
    const fact = seedFact('老事实');
    backdate(ep.id, 8);
    backdate(fact, 8);

    const gc = gcMemories();
    assert.equal(gc.decayed, 1, '只有 episode 越过了 7 天线');
    assert.equal(loadAll().find((e) => e.id === ep.id)?.status, 'archived');
    assert.equal(loadAll().find((e) => e.id === fact)?.status, 'active', '8 天远未到事实的 30 天');
  }),
);

test(
  'R6.2:episode 归档 31 天即硬删,事实归档 31 天仍保留(90 天线)',
  isolated(() => {
    const ep = recordSessionEpisode({ sessionId: 'sess-purge', queries: ['q'] });
    assert.ok(ep.ok);
    const fact = seedFact('待删事实');
    assert.ok(forgetEntry(ep.id, 'archive').ok);
    assert.ok(forgetEntry(fact, 'archive').ok);
    backdate(ep.id, 31, ['createdAt', 'updatedAt']);
    backdate(fact, 31, ['createdAt', 'updatedAt']);

    const gc = gcMemories();
    assert.equal(gc.gced, 1);
    const all = loadAll();
    assert.equal(
      all.find((e) => e.id === ep.id),
      undefined,
      'episode 过了 30 天清除线应物理消失',
    );
    assert.ok(
      all.find((e) => e.id === fact),
      '事实记忆归档后仍保留到 90 天',
    );
  }),
);

test(
  'R6.2:episode 不占 MAX_ACTIVE 名额(否则每会话一条会挤出长期知识)',
  isolated(() => {
    // 造满事实记忆的封顶线再多一条,外加若干 episode。
    for (let i = 0; i < MAX_ACTIVE + 1; i++) seedFact(`fact-${i}`);
    const episodes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = recordSessionEpisode({ sessionId: `sess-${i}`, queries: [`q${i}`] });
      assert.ok(r.ok);
      episodes.push(r.id);
    }

    const gc = gcMemories();
    // 只有 1 条事实超出封顶;若 episode 也占名额,这里会是 6。
    assert.equal(gc.capped, 1);
    const all = loadAll();
    for (const id of episodes) {
      assert.equal(all.find((e) => e.id === id)?.status, 'active', `${id} 不应被事实封顶淘汰`);
    }
  }),
);

// ── R6.3 启动注入 ─────────────────────────────────────────────────────────

test(
  'R6.3:注入最近 3 条、最新在前、独立小节,且不进 Memory Index',
  isolated(() => {
    for (let i = 0; i < 4; i++) {
      const r = recordSessionEpisode({ sessionId: `sess-inj-${i}`, queries: [`第 ${i} 次会话`] });
      assert.ok(r.ok);
      backdate(r.id, 4 - i); // 让 createdAt 有明确先后
    }
    const fact = seedFact('一条长期事实');

    const section = buildEpisodeSection(true);
    assert.match(section, /## Recent sessions \(episodic memory\)/);
    // 3 条上限:最老的那条(sess-inj-0)不出现。
    assert.equal(listEpisodes(3).length, 3);
    assert.ok(!section.includes('sess-inj-0'), '第 4 条应被硬上限挡掉');
    assert.ok(section.includes('sess-inj-3'), '最新一条必须在');
    assert.ok(section.includes('最近请求: 第 3 次会话'));

    // 主索引里不应出现 episode(它的生命周期差一个数量级,混排会天天刷存在感)。
    const index = buildMemoryIndexSection(true);
    assert.ok(index.includes('一条长期事实') || index.includes(fact));
    assert.ok(!index.includes('sess-inj-3'));
  }),
);

test(
  'R6.3:无 episode → 零注入;总开关关闭 → 零注入;MOCODE_MEMORY_EPISODIC=0 → 零注入',
  isolated(() => {
    assert.equal(buildEpisodeSection(true), '', '空库不产生任何小节');

    recordSessionEpisode({ sessionId: 'sess-off', queries: ['q'] });
    assert.notEqual(buildEpisodeSection(true), '');
    assert.equal(buildEpisodeSection(false), '', 'memory 总开关 veto');

    delete process.env.MOCODE_MEMORY_EPISODIC;
    assert.equal(isEpisodicEnabled(), true, '默认开启');
    process.env.MOCODE_MEMORY_EPISODIC = '0';
    assert.equal(isEpisodicEnabled(), false);
    assert.equal(buildEpisodeSection(true), '', '独立开关也能关掉');

    // 关闭时也不该再写入(否则关了还在攒数据)。
    const r = recordSessionEpisode({ sessionId: 'sess-off-2', queries: ['q'] });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'disabled');
    delete process.env.MOCODE_MEMORY_EPISODIC;
  }),
);

test(
  'R6:memoryEnabled=false 时 recordSessionEpisode 不落盘(总开关 veto 优先)',
  isolated(() => {
    const r = recordSessionEpisode({ sessionId: 'sess-veto', queries: ['q'] }, { memoryEnabled: false });
    assert.equal(r.ok, false);
    assert.equal(loadAll().length, 0);
  }),
);
