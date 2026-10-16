/**
 * 压缩归档(compacted history)护栏:
 *  - renderCompactedSegment:消息 → grep 友好 Markdown(turn/tool/call 头、图片占位、路径元数据)
 *  - parseSegmentMeta:首行元数据往返
 *  - SessionStore.archiveCompactedMessages:编号单调、index.md 重建、超预算从最老淘汰
 *  - compactHistory 摘要成功后摘要尾部出现 [archived: …] 且 seg 文件可 grep 回原文
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../src/llm/index.js';
import {
  parseSegmentMeta,
  renderArchiveIndex,
  renderCompactedSegment,
  segmentFileName,
} from '../src/session/compact-archive.js';
import { SessionStore } from '../src/session/store.js';
import { config } from '../src/config/index.js';
import { setCurrentSessionId } from '../src/session/state.js';
import { compactHistory, createContextState } from '../src/session/compact.js';
import { appendTool, system } from './helpers.js';

function msgs(): ChatMessage[] {
  const h: ChatMessage[] = [system('sys')];
  h.push({ role: 'user', content: '先跑测试,别动 tests/ 目录' } as ChatMessage);
  appendTool(h, 'run_command', 'call-1', { command: 'npm test' }, '2 passing\n1 failing at src/a.ts:42');
  h.push({
    role: 'assistant',
    content: '结论:a.ts:42 有空指针,稍后再改',
  } as ChatMessage);
  appendTool(h, 'read_file', 'call-2', { path: 'src/a.ts' }, 'line40 null.x boom');
  return h;
}

test('renderCompactedSegment: 头/turn/工具调用与结果/路径元数据齐全且可解析', () => {
  const { markdown, meta } = renderCompactedSegment(1, msgs(), '2026-10-16T00:00:00.000Z');
  assert.equal(meta.file, 'seg-001.md');
  assert.equal(segmentFileName(1), 'seg-001.md');
  assert.equal(meta.turns, 1);
  assert.deepEqual(meta.tools, ['run_command', 'read_file']);
  assert.ok(meta.files.includes('src/a.ts'));
  assert.match(meta.firstUser, /先跑测试/);

  // 原文可检索
  assert.match(markdown, /### \[turn 1\] user/);
  assert.match(markdown, /先跑测试,别动 tests\/ 目录/);
  assert.match(markdown, /call=call-1 tool=run_command/);
  assert.match(markdown, /2 passing/);
  assert.match(markdown, /空指针,稍后再改/);
  assert.match(markdown, /args: .*"path":"src\/a\.ts"/);

  const parsed = parseSegmentMeta(markdown);
  assert.ok(parsed);
  assert.equal(parsed!.seq, 1);
  assert.equal(parsed!.chars, markdown.length);
  assert.deepEqual(parsed!.tools, meta.tools);

  assert.equal(parseSegmentMeta('not a header\nbody'), null);
});

test('renderCompactedSegment: 图片 content 只留占位不进归档', () => {
  const h: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAAVERY LONG' } },
      ],
    } as ChatMessage,
  ];
  const { markdown } = renderCompactedSegment(2, h);
  assert.match(markdown, /\[图片已剥离: image\/png\]/);
  assert.ok(!markdown.includes('AAAAVERY LONG'), 'base64 不得进归档');
});

test('renderArchiveIndex: 确定性列出每段', () => {
  const { meta } = renderCompactedSegment(3, msgs());
  const idx = renderArchiveIndex([meta], '.mocode/sessions/s1/compacted');
  assert.match(idx, /seg-003\.md/);
  assert.match(idx, /1 turns/);
  assert.match(idx, /run_command/);
  assert.match(idx, /\.mocode\/sessions\/s1\/compacted\/\*\*/, 'index 写明 glob 限定要求');
});

test('SessionStore.archiveCompactedMessages: 编号单调 + index 重建 + 相对路径返回', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-compact-arch-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261016-010000-000-aaaaaaaa';
  try {
    const p1 = store.archiveCompactedMessages(id, msgs());
    const p2 = store.archiveCompactedMessages(id, msgs());
    assert.equal(p1, `.mocode/sessions/${id}/compacted/seg-001.md`);
    assert.equal(p2, `.mocode/sessions/${id}/compacted/seg-002.md`);

    const dir = join(root, id, 'compacted');
    assert.deepEqual(readdirSync(dir).sort(), ['index.md', 'seg-001.md', 'seg-002.md']);
    const seg1 = readFileSync(join(dir, 'seg-001.md'), 'utf8');
    assert.match(seg1, /2 passing/);
    const idx = readFileSync(join(dir, 'index.md'), 'utf8');
    const ordered = idx.indexOf('seg-001.md') < idx.indexOf('seg-002.md');
    assert.ok(ordered, 'index 按 seq 升序');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SessionStore.archiveCompactedMessages: 超总量预算从最老段淘汰,至少留最新段', () => {
  const prev = process.env.MOCODE_MAX_COMPACTED_BYTES;
  process.env.MOCODE_MAX_COMPACTED_BYTES = '1';
  const root = mkdtempSync(join(tmpdir(), 'mocode-compact-prune-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261016-020000-000-bbbbbbbb';
  try {
    store.archiveCompactedMessages(id, msgs());
    store.archiveCompactedMessages(id, msgs());
    const dir = join(root, id, 'compacted');
    const segs = readdirSync(dir).filter((n) => n.startsWith('seg-'));
    assert.deepEqual(segs, ['seg-002.md'], '预算=1 时只留最新段');
    assert.ok(existsSync(join(dir, 'index.md')));
    const idx = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.ok(!idx.includes('seg-001.md'), 'index 不含已淘汰段');
    assert.match(idx, /seg-002\.md/);
  } finally {
    if (prev === undefined) delete process.env.MOCODE_MAX_COMPACTED_BYTES;
    else process.env.MOCODE_MAX_COMPACTED_BYTES = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('compactHistory 摘要成功后归档旧区原文并在摘要尾部写 [archived] 指针(仅主 agent)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-compact-integ-'));
  const prevSessionDir = config.sessionDir;
  config.sessionDir = join(root, '.mocode', 'sessions');
  const sid = '20261016-030000-000-cccccccc';
  setCurrentSessionId(sid, root);
  const history: ChatMessage[] = [system('sys')];
  history.push({ role: 'user', content: '跑测试' } as ChatMessage);
  appendTool(history, 'run_command', 'c1', { command: 'npm test' }, `UNIQUE-OUTPUT-XYZ ${'1 failing'.repeat(400)}`);
  history.push({ role: 'user', content: '继续' } as ChatMessage);
  appendTool(history, 'read_file', 'c2', { path: 'src/b.ts' }, `b content ${'z'.repeat(3_000)}`);
  try {
    const result = await compactHistory(history, {
      window: 1_200,
      threshold: 100,
      summarize: async () => '## Completed\n压完了',
    });
    assert.equal(result.reason, 'summarize');
    const summary = String((history[1] as { content?: unknown }).content ?? '');
    assert.match(summary, /\[archived: .*compacted\/seg-001\.md[^\]]*\]/);

    const seg = readFileSync(join(config.sessionDir, sid, 'compacted', 'seg-001.md'), 'utf8');
    assert.match(seg, /UNIQUE-OUTPUT-XYZ/, '被压掉的工具结果原文可从段文件捞回');
    assert.ok(existsSync(join(config.sessionDir, sid, 'compacted', 'index.md')));
  } finally {
    setCurrentSessionId(undefined, root);
    config.sessionDir = prevSessionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('compactHistory 子 agent(独立 contextState)不写主会话归档', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-compact-sub-'));
  const prevSessionDir = config.sessionDir;
  config.sessionDir = join(root, '.mocode', 'sessions');
  const sid = '20261016-040000-000-dddddddd';
  setCurrentSessionId(sid, root);
  const history: ChatMessage[] = [system('sys')];
  history.push({ role: 'user', content: 'task' } as ChatMessage);
  appendTool(history, 'read_file', 's1', { path: 'c.ts' }, 'z'.repeat(3_000));
  history.push({ role: 'user', content: '继续' } as ChatMessage);
  appendTool(history, 'run_command', 's2', { command: 'echo hi' }, 'hi');
  try {
    const result = await compactHistory(history, {
      window: 1_200,
      threshold: 100,
      contextState: createContextState(),
      summarize: async () => '## Completed\n子 agent 压完',
    });
    assert.equal(result.reason, 'summarize');
    assert.ok(
      !existsSync(join(config.sessionDir, sid, 'compacted')),
      '子 agent 独立 contextState 不应在主会话目录留归档',
    );
  } finally {
    setCurrentSessionId(undefined, root);
    config.sessionDir = prevSessionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 边界2:push-time 截断原文 blob ─────────────────────────────────────────

test('archiveToolResult: 完整结果落 result-<id>.txt 并返回相对路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-result-blob-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261016-050000-000-eeeeeeee';
  try {
    const full = 'HEAD'.repeat(10) + 'UNIQUE-FULL-RESULT' + 'TAIL'.repeat(10);
    const rel = store.archiveToolResult(id, 'toolu_abc123', full);
    assert.equal(rel, `.mocode/sessions/${id}/compacted/result-toolu_abc123.txt`);
    const onDisk = readFileSync(join(root, id, 'compacted', 'result-toolu_abc123.txt'), 'utf8');
    assert.equal(onDisk, full, 'blob 必须是未截断全文');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveToolResult: 路径穿越 id 被清洗为单层安全文件名', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-result-blob-safe-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261016-050100-000-ffffffff';
  try {
    const rel = store.archiveToolResult(id, '../../etc/passwd', 'x');
    assert.ok(rel, '应返回路径');
    // 安全性质:路径分隔符 / 被清洗成 _,结果只是 compacted 下的单层文件名,无法越界。
    const dir = join(root, id, 'compacted');
    const onDisk = readdirSync(dir).filter((n) => n.startsWith('result-'));
    assert.deepEqual(onDisk, ['result-.._.._etc_passwd.txt']);
    assert.ok(existsSync(join(dir, onDisk[0]!)), '文件只落在 compacted 单层目录内');
    assert.ok(!existsSync(join(root, 'etc')), '未在会话目录外创建任何路径');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune 统一预算:大 result blob 超预算时被删,最新 seg 始终保留', () => {
  const prev = process.env.MOCODE_MAX_COMPACTED_BYTES;
  process.env.MOCODE_MAX_COMPACTED_BYTES = '200';
  const root = mkdtempSync(join(tmpdir(), 'mocode-result-prune-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261016-050200-000-11111111';
  try {
    // seg(>200B)先写 → 最新段豁免。
    store.archiveCompactedMessages(id, msgs());
    // 再写一个同样超预算的 blob:总超限,删最老候选;最新 seg 不能被删。
    const rel = store.archiveToolResult(id, 'toolu_big', 'y'.repeat(2000));
    assert.ok(rel);
    const dir = join(root, id, 'compacted');
    const names = readdirSync(dir);
    assert.ok(names.includes('seg-001.md'), '最新 seg 必须保留');
    assert.ok(!names.includes('result-toolu_big.txt'), '超预算的旧 blob 应被淘汰');
  } finally {
    if (prev === undefined) delete process.env.MOCODE_MAX_COMPACTED_BYTES;
    else process.env.MOCODE_MAX_COMPACTED_BYTES = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('pushToolResult: 超长结果截断入 history 且尾部带 blob 全文指针(主 agent)', async () => {
  const { pushToolResult } = await import('../src/agent/tool-helpers.js');
  const root = mkdtempSync(join(tmpdir(), 'mocode-push-blob-'));
  const prevSessionDir = config.sessionDir;
  config.sessionDir = join(root, '.mocode', 'sessions');
  const sid = '20261016-050300-000-22222222';
  setCurrentSessionId(sid, root);
  const history: ChatMessage[] = [];
  const full = 'H'.repeat(20_000) + 'UNIQUE-CAPPED-TAIL-90210' + 'T'.repeat(20_000);
  try {
    pushToolResult(history, { id: 'toolu_cap1', name: 'run_command', arguments: '{}' }, full, null, null, null);
    const content = String((history[0] as { content?: unknown }).content ?? '');
    assert.ok(content.length < full.length, 'history 内应为截断后内容');
    assert.match(content, /完整结果已归档.*result-toolu_cap1\.txt/, '截断内容尾部要有全文指针');
    assert.ok(!content.includes('UNIQUE-CAPPED-TAIL-90210'), '中截点附近原文不应残留在 history');
    const blob = readFileSync(join(config.sessionDir, sid, 'compacted', 'result-toolu_cap1.txt'), 'utf8');
    assert.equal(blob, full, 'blob 可捞回完整原文(含中截点)');
  } finally {
    setCurrentSessionId(undefined, root);
    config.sessionDir = prevSessionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('pushToolResult: 短结果不产生 blob/指针;子 agent contextState 不写主会话', async () => {
  const { pushToolResult } = await import('../src/agent/tool-helpers.js');
  const root = mkdtempSync(join(tmpdir(), 'mocode-push-blob-sub-'));
  const prevSessionDir = config.sessionDir;
  config.sessionDir = join(root, '.mocode', 'sessions');
  const sid = '20261016-050400-000-33333333';
  setCurrentSessionId(sid, root);
  try {
    const short: ChatMessage[] = [];
    pushToolResult(short, { id: 'toolu_short', name: 'read_file', arguments: '{}' }, 'small output', null, null, null);
    assert.equal(String((short[0] as { content?: unknown }).content), 'small output');
    assert.ok(!existsSync(join(config.sessionDir, sid, 'compacted')), '短结果不该建归档目录');

    const sub: ChatMessage[] = [];
    pushToolResult(
      sub,
      { id: 'toolu_sub', name: 'run_command', arguments: '{}' },
      'x'.repeat(40_000),
      null,
      null,
      null,
      createContextState(),
    );
    const content = String((sub[0] as { content?: unknown }).content ?? '');
    assert.ok(!content.includes('完整结果已归档'), '子 agent 不留主会话 blob 指针');
    assert.ok(!existsSync(join(config.sessionDir, sid, 'compacted')), '子 agent 不写主会话归档');
  } finally {
    setCurrentSessionId(undefined, root);
    config.sessionDir = prevSessionDir;
    rmSync(root, { recursive: true, force: true });
  }
});
