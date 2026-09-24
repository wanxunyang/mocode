/**
 * Session retention(归档 / 清除)测试。
 *
 * 覆盖 src/session/retention.js:
 *  - planRetention:超龄会话入归档计划、当前会话豁免、未超龄不动、非会话目录跳过、超龄 gz 入 purge 计划
 *  - runRetention:archive(原目录删除 / gz 可还原 / index 落 meta+摘要)、purge(gz 删除 / index 行保留标 purgedAt)
 *  - loadArchivedSession:未 purge 可还原、已 purge / 不存在返 null
 *  - searchArchiveIndex:BM25 命中,已 purge 的条目仍可检索
 *  - readArchiveIndex / upsertArchiveIndex:损坏行跳过、按 id upsert 覆盖
 *
 * 归档前的 consolidateSession 会调 runReflection(LLM):用 __setChatCreateImpl 桩成立即抛错,
 * reflection 静默失败,归档照常——与生产断网时行为一致,且零网络、零等待。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import type { ChatMessage } from '../src/llm/index.js';
import type { SessionRecord } from '../src/session/store.js';
import {
  DEFAULT_RETENTION_POLICY,
  loadArchivedSession,
  planRetention,
  readArchiveIndex,
  retentionPaths,
  runRetention,
  searchArchiveIndex,
  upsertArchiveIndex,
  type RetentionPolicy,
} from '../src/session/retention.js';

const DAY_MS = 86_400_000;

/** 造一个合法会话目录(目录名须匹配 ^\d{8}-\d{6}),返回目录路径。 */
function writeSession(sessionsRoot: string, id: string, firstUser: string, summary = ''): string {
  const dir = join(sessionsRoot, id);
  mkdirSync(dir, { recursive: true });
  const history: ChatMessage[] = [
    { role: 'system', content: 'you are mocode' },
    { role: 'user', content: firstUser },
  ];
  if (summary) history.push({ role: 'system', content: summary });
  const record: SessionRecord = {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    model: 'test-model',
    firstUser,
    history,
  };
  writeFileSync(join(dir, 'session.json'), JSON.stringify(record), 'utf8');
  return dir;
}

/** 把 session.json 的 mtime 调到 now - ageDays。 */
function ageSession(dir: string, ageDays: number, now: number): void {
  const t = new Date(now - ageDays * DAY_MS);
  utimesSync(join(dir, 'session.json'), t, t);
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mocode-retention-test-'));
}

test('planRetention: 超龄会话归档 / 当前会话豁免 / 未超龄不动 / 非会话目录跳过 / 超龄 gz 待 purge', () => {
  const root = makeRoot();
  try {
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    const oldId = '20260820-100000-aaaa1111';
    const currentId = '20260819-090000-bbbb2222';
    const freshId = '20260924-080000-cccc3333';
    ageSession(writeSession(root, oldId, '老会话一'), 36, now);
    ageSession(writeSession(root, currentId, '当前活跃会话'), 37, now);
    writeSession(root, freshId, '新会话');

    // 不符合命名约定的目录即便含 session.json 也应跳过。
    const stray = join(root, 'not-a-session');
    mkdirSync(join(stray), { recursive: true });
    writeFileSync(join(stray, 'session.json'), '{}', 'utf8');

    // archive 目录里放一个超龄 gz(100 天),应入 purge 计划。
    const paths = retentionPaths(root);
    mkdirSync(paths.archiveDir, { recursive: true });
    const purgedGzId = '20260601-000000-dddd4444';
    const gzPath = join(paths.archiveDir, `${purgedGzId}.json.gz`);
    writeFileSync(gzPath, 'fake-gz', 'utf8');
    const oldTime = new Date(now - 100 * DAY_MS);
    utimesSync(gzPath, oldTime, oldTime);
    // 未超龄 gz 不应进计划。
    const freshGzPath = join(paths.archiveDir, '20260901-000000-eeee5555.json.gz');
    writeFileSync(freshGzPath, 'fake-gz', 'utf8');

    const policy: RetentionPolicy = { archiveAfterDays: 30, purgeAfterDays: 90 };
    const plan = planRetention(root, policy, now, currentId);

    const archiveItems = plan.items.filter((i) => i.action === 'archive');
    const purgeItems = plan.items.filter((i) => i.action === 'purge');
    assert.deepEqual(
      archiveItems.map((i) => i.id),
      [oldId],
    );
    assert.deepEqual(
      purgeItems.map((i) => i.id),
      [purgedGzId],
    );
    assert.equal(archiveItems[0]?.firstUser, '老会话一');
    assert.ok(plan.bytesReclaimable > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runRetention: 归档后 gz 可还原、index 落 meta+摘要、原目录删除,且可被全文搜索命中', async () => {
  const root = makeRoot();
  __setChatCreateImpl(async () => {
    throw new Error('no-llm-in-test');
  });
  try {
    const now = Date.now();
    const id = '20260810-120000-abc12345';
    const firstUser = '帮我修复登录页面的空白问题';
    const summary = '# 会话摘要\n修复了登录页面空白问题';
    ageSession(writeSession(root, id, firstUser, summary), 31, now);

    const plan = planRetention(root, { archiveAfterDays: 30, purgeAfterDays: 90 }, now);
    assert.equal(plan.items.length, 1);

    const result = await runRetention(root, plan, now);
    assert.deepEqual(result, { archived: 1, purged: 0, bytesReclaimed: result.bytesReclaimed });
    assert.ok(result.bytesReclaimed > 0);

    // 原目录删除、gz 存在。
    assert.equal(existsSync(join(root, id)), false);
    const gzPath = join(retentionPaths(root).archiveDir, `${id}.json.gz`);
    assert.equal(existsSync(gzPath), true);

    // index:meta + 摘要,无 purgedAt。
    const entries = readArchiveIndex(retentionPaths(root).indexPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, id);
    assert.equal(entries[0]?.model, 'test-model');
    assert.equal(entries[0]?.firstUser, firstUser);
    assert.equal(entries[0]?.summary, summary);
    assert.ok(entries[0]?.archivedAt);
    assert.equal(entries[0]?.purgedAt, undefined);

    // gz 可完整还原。
    const restored = loadArchivedSession(root, id);
    assert.ok(restored);
    assert.equal(restored?.id, id);
    assert.equal(restored?.history.length, 3);

    // 全文搜索(含 CJK)命中。
    const hits = searchArchiveIndex(root, '登录页面');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, id);
    assert.ok((hits[0]?.score ?? 0) > 0);
  } finally {
    __setChatCreateImpl(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runRetention: purge 后 gz 删除、index 行保留并标 purgedAt,仍可搜索但不可还原', async () => {
  const root = makeRoot();
  __setChatCreateImpl(async () => {
    throw new Error('no-llm-in-test');
  });
  try {
    const id = '20260810-120000-abc67890';
    const firstUser = '讨论数据库索引优化方案';
    writeSession(root, id, firstUser, '# 会话摘要\n为慢查询加了联合索引');

    // 先归档(threshold 0 立即触发)。
    await runRetention(root, planRetention(root, { archiveAfterDays: 0, purgeAfterDays: 90 }));
    assert.ok(loadArchivedSession(root, id));

    // gz 已超 purge 年龄(purgeAfterDays:0)。
    const purgePlan = planRetention(root, { archiveAfterDays: 30, purgeAfterDays: 0 });
    assert.deepEqual(
      purgePlan.items.map((i) => i.action),
      ['purge'],
    );
    const result = await runRetention(root, purgePlan);
    assert.equal(result.purged, 1);
    assert.equal(result.archived, 0);

    // gz 删除、index 行保留且标 purgedAt。
    const gzPath = join(retentionPaths(root).archiveDir, `${id}.json.gz`);
    assert.equal(existsSync(gzPath), false);
    const entries = readArchiveIndex(retentionPaths(root).indexPath);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.purgedAt);

    // 不可还原,但 meta+摘要仍可搜索。
    assert.equal(loadArchivedSession(root, id), null);
    const hits = searchArchiveIndex(root, '索引');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, id);
    assert.ok(hits[0]?.purgedAt);
  } finally {
    __setChatCreateImpl(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadArchivedSession: 不存在返 null', () => {
  const root = makeRoot();
  try {
    assert.equal(loadArchivedSession(root, '20260101-000000-ffffffff'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive index: 损坏行跳过,upsert 按 id 覆盖而非追加', () => {
  const root = makeRoot();
  try {
    const indexPath = retentionPaths(root).indexPath;
    mkdirSync(retentionPaths(root).archiveDir, { recursive: true });

    upsertArchiveIndex(indexPath, {
      id: 'a',
      createdAt: '2026-08-01T00:00:00.000Z',
      model: 'm',
      firstUser: '第一条',
      summary: '',
      archivedAt: '2026-09-01T00:00:00.000Z',
    });
    upsertArchiveIndex(indexPath, {
      id: 'b',
      createdAt: '2026-08-02T00:00:00.000Z',
      model: 'm',
      firstUser: '第二条',
      summary: '',
      archivedAt: '2026-09-02T00:00:00.000Z',
    });
    // 同 id 再 upsert:应覆盖。
    upsertArchiveIndex(indexPath, {
      id: 'a',
      createdAt: '2026-08-01T00:00:00.000Z',
      model: 'm2',
      firstUser: '第一条更新',
      summary: '',
      archivedAt: '2026-09-03T00:00:00.000Z',
    });
    let entries = readArchiveIndex(indexPath);
    assert.equal(entries.length, 2);
    const a = entries.find((e) => e.id === 'a');
    assert.equal(a?.model, 'm2');
    assert.equal(a?.firstUser, '第一条更新');

    // 手动塞入损坏行与空行,读取时应跳过且不影响其余条目。
    const raw = readFileSync(indexPath, 'utf8');
    writeFileSync(indexPath, raw + '{broken json\n\n   \n', 'utf8');
    entries = readArchiveIndex(indexPath);
    assert.equal(entries.length, 2);

    // 索引文件不存在时返回空数组。
    assert.deepEqual(readArchiveIndex(join(root, 'nope', 'index.jsonl')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('searchArchiveIndex: 空查询与空索引返回空', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(searchArchiveIndex(root, '任意'), []);
    assert.deepEqual(searchArchiveIndex(root, '   '), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEFAULT_RETENTION_POLICY: 默认 30/90 天', () => {
  assert.equal(DEFAULT_RETENTION_POLICY.archiveAfterDays, 30);
  assert.equal(DEFAULT_RETENTION_POLICY.purgeAfterDays, 90);
});
