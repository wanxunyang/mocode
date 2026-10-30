/**
 * R17 会话内记忆尾注:本轮之前新写入/更新的记忆,下一轮模型就该知道。
 *
 * 钉的是五件事(对应 src/memory/tail.ts 的头注释与 design-notes/memory/memory.md §R17):
 *  1. 启动时拍基线 → 无变化返回空串(零注入,零行为变化);
 *  2. 会话中新写/更新的 active 条目出现在尾注里,带 type / id / summary / body 截断;
 *  3. 开关关闭 → 空串;没拍过基线 → 空串(不猜);
 *  4. 硬上限 3 条,多余只在尾行报数;
 *  5. episode 永不计入——它只在会话结束时写,算进来等于让上次会话冒充本轮成果。
 *
 * 注意 isolated() 必须同时 setSandboxRoot 与 chdir:store 的 global 路径读 HOME、
 * project 路径读 process.cwd(),只改一个会让测试写进仓库真实记忆库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetMemoryBaselineForTests, buildMemoryTailSection, captureMemoryBaseline } from '../src/memory/tail.js';
import { __resetPendingRecallForTests, forgetEntry, saveEntry, updateEntry } from '../src/memory/store.js';
import { recordSessionEpisode } from '../src/memory/episodic.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-tail-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    delete process.env.MEMORY_ENABLED;
    __resetMemoryBaselineForTests();
    try {
      await fn();
    } finally {
      __resetMemoryBaselineForTests();
      __resetPendingRecallForTests();
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/**
 * 把某条目的 updatedAt 回拨 seconds 秒(直接改 JSONL,模拟时间流逝)。
 *
 * 为什么需要:尾注是「schema 差分」,只比对 updatedAt 字符串。测试里
 * save → captureMemoryBaseline → update 三步若落在**同一毫秒**,updatedAt 逐字相同,
 * 差分看不见这次修改。CI 的 Linux tmpfs 快到会撞进同一毫秒(本地 Windows NTFS 反而
 * 每轮 I/O 超过 1ms,所以本地跑不出来)。把基线拍在回拨之后,先后关系就与文件系统
 * 速度无关了。
 */
function backdateUpdatedAt(id: string, seconds: number): void {
  const file = join(process.cwd(), '.mocode', 'memory.jsonl');
  const iso = new Date(Date.now() - seconds * 1000).toISOString();
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const out = lines.map((l) => {
    const e = JSON.parse(l) as Record<string, unknown>;
    if (e.id !== id) return l;
    e.updatedAt = iso;
    return JSON.stringify(e);
  });
  writeFileSync(file, out.join('\n') + '\n', 'utf8');
}

const writeEntry = (over: Partial<Parameters<typeof saveEntry>[0]> = {}) => {
  const r = saveEntry({
    name: 'tail-subject',
    summary: '一条用来测尾注的记忆',
    body: '正文:尾注应该把它带进下一轮上下文。',
    type: 'fact',
    scope: 'project',
    ...over,
  });
  assert.equal(r.ok, true);
  return r;
};

test(
  'R17:没拍基线 → 空串(不猜,也不注入半份索引)',
  isolated(() => {
    writeEntry();
    // 刻意不调 captureMemoryBaseline:调用方没接线时,尾注必须静默。
    assert.equal(buildMemoryTailSection(true), '');
  }),
);

test(
  'R17:基线之后无变化 → 空串(零注入)',
  isolated(() => {
    writeEntry({ name: 'stable', summary: '早就存在的条目' });
    captureMemoryBaseline();
    assert.equal(buildMemoryTailSection(true), '');
  }),
);

test(
  'R17:会话中新增的条目出现在尾注里,带上 type/id/summary',
  isolated(() => {
    writeEntry({ name: 'old', summary: '会话开始前就有的' });
    captureMemoryBaseline();
    writeEntry({ name: 'brand-new', summary: '会话中途新学到的', type: 'pitfall' });

    const out = buildMemoryTailSection(true);
    assert.match(out, /## Memory updated during this session/);
    assert.match(out, /brand-new/);
    assert.match(out, /\[pitfall\]/);
    assert.match(out, /会话中途新学到的/);
    // 基线里已有的不该被当成「新学到的」重播。
    assert.doesNotMatch(out, /会话开始前就有的/);
  }),
);

test(
  'R17:会话中被更新的条目也算变化(updatedAt 变即播报)',
  isolated(() => {
    const r = writeEntry({ name: 'to-update', summary: '旧结论' });
    // 先把基线写成「1 分钟前」,再拍快照:否则 save 与 update 可能同毫秒,updatedAt
    // 不变 → 差分漏报(CI 上稳定复现;本地因 I/O 慢而跑不出来)。
    backdateUpdatedAt(r.ok ? r.id : '', 60);
    captureMemoryBaseline();
    const up = updateEntry(r.ok ? r.id : '', { summary: '被修正的新结论', reason: 'user correction' });
    assert.equal(up.ok, true);

    const out = buildMemoryTailSection(true);
    assert.match(out, /to-update/);
    assert.match(out, /被修正的新结论/);
    assert.doesNotMatch(out, /旧结论/, '要显示当前内容,不是基线里的旧内容');
  }),
);

test(
  'R17:开关关闭 → 空串,即使确有变化',
  isolated(() => {
    captureMemoryBaseline();
    writeEntry({ name: 'gated' });
    assert.equal(buildMemoryTailSection(false), '');
    assert.match(buildMemoryTailSection(true), /gated/);
  }),
);

test(
  'R17:硬上限 3 条,多余只在尾行报数',
  isolated(() => {
    captureMemoryBaseline();
    for (let i = 0; i < 5; i++) {
      writeEntry({ name: `bulk-${i}`, summary: `第 ${i} 条` });
    }
    const out = buildMemoryTailSection(true);
    const bullets = out.split('\n').filter((l) => l.startsWith('- ['));
    assert.equal(bullets.length, 3, '最多 3 条,上下文不是公告栏');
    assert.match(out, /\(2 more changed/, '被截掉的要报数,不能静默消失');
  }),
);

test(
  'R17:episode 永不计入(它只在会话结束时写)',
  isolated(() => {
    captureMemoryBaseline();
    const r = recordSessionEpisode({
      sessionId: 'sess-tail-episode',
      queries: ['测试尾注'],
      changedFiles: ['src/memory/tail.ts'],
      summaryText: '',
      pendingSteps: [],
    });
    assert.equal(r.ok, true);
    assert.equal(buildMemoryTailSection(true), '', '上次会话的摘要是历史,不是本轮新知识');
  }),
);

test(
  'R17:归档条目不出现在尾注(说的是历史,不是本轮须知)',
  isolated(() => {
    captureMemoryBaseline();
    const r = writeEntry({ name: 'goes-archived' });
    assert.equal(r.ok, true);
    // 直接改库模拟被 GC/取代归档:尾注只认 active。
    const f = forgetEntry(r.ok ? r.id : '', 'archive');
    assert.equal(f.ok, true);
    assert.equal(buildMemoryTailSection(true), '');
  }),
);

test(
  'R17:body 过长时截断,不把整段正文灌进每轮请求',
  isolated(() => {
    captureMemoryBaseline();
    writeEntry({ name: 'long-body', body: 'X'.repeat(1200) });
    const out = buildMemoryTailSection(true);
    // body 截到 400 字 + 省略号:连续 X 只能有 400 个,不能整段 1200 灌进去。
    const run = /X{2,}/.exec(out)?.[0].length ?? 0;
    assert.equal(run, 400, `body 应截到 400 字,实际 ${run}`);
    assert.ok(out.includes('…'), '截断要有省略号,不能被误读成完整正文');
    assert.ok(out.length < 900, `尾注应可控,实际 ${out.length} 字符`);
  }),
);
