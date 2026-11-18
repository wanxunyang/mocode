import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasRealUserTurn, listProjectSessions, titleFromHistory } from '../../packages/work-app/src/workspace-sync.js';

/**
 * 侧栏「历史会话」列表的两条口径，都来自用户报过的真实症状：
 *   1. 多模态首轮（文字+图片）的 content 被 JSON.stringify 存进 firstUser 后，列表里
 *      显示成 `[{"type":"text","text":"这是？"},…]` —— 标题必须从 history 现算；
 *   2. history 里没有真实用户发言的会话（只有 system 的残留壳子）点开是空的，
 *      不该占列表位置。
 */

/** 造一个会话目录：`<root>/.mocode/sessions/<id>/session.json`。 */
const sessionsOf = (root: string): string => join(root, '.mocode', 'sessions');

function writeSession(root: string, id: string, record: Record<string, unknown>): void {
  const dir = join(sessionsOf(root), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({ id, createdAt: '2026-11-17T08:00:00.000Z', model: 'test', ...record }),
    'utf8',
  );
}

const multimodalFirstTurn = [
  { type: 'text', text: '这是？' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
];

test('titleFromHistory：多模态首轮取文字段，不吐 JSON', () => {
  const title = titleFromHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: multimodalFirstTurn },
    { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(title, '这是？');
});

test('titleFromHistory：纯图片发言给占位，不吐 base64', () => {
  const title = titleFromHistory([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ]);
  assert.equal(title, '[图片]');
});

test('titleFromHistory：字符串 content 的换行压成一行并截断到 40 字符', () => {
  const long = `${'一'.repeat(60)}\n第二行`;
  assert.equal(titleFromHistory([{ role: 'user', content: long }]).length, 40);
  assert.equal(titleFromHistory([{ role: 'user', content: '第一行\n第二行' }]), '第一行 第二行');
});

test('titleFromHistory：跳过内容为空的 user，取第一条有文字的', () => {
  const title = titleFromHistory([
    { role: 'user', content: '' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: '真正的问题' },
  ]);
  assert.equal(title, '真正的问题');
});

test('hasRealUserTurn：只有 system / 空 user 的会话不算聊过', () => {
  assert.equal(hasRealUserTurn([{ role: 'system', content: 'sys' }]), false);
  assert.equal(hasRealUserTurn([{ role: 'user', content: '' }]), false);
  assert.equal(hasRealUserTurn([]), false);
  assert.equal(hasRealUserTurn(null), false);
  // 只有图片的多模态发言是真实发言：用户确实发了东西。
  assert.equal(hasRealUserTurn([{ role: 'user', content: multimodalFirstTurn }]), true);
  assert.equal(hasRealUserTurn([{ role: 'user', content: 'hi' }]), true);
});

test('listProjectSessions：隐藏没有用户发言的会话，且标题修掉序列化的 firstUser', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-ws-sync-'));
  try {
    // 多模态会话：落盘的 firstUser 是早期版本序列化出来的 JSON 串。
    writeSession(root, '20261117-080000-000-aaaaaaaa', {
      firstUser: JSON.stringify(multimodalFirstTurn).slice(0, 40),
      history: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: multimodalFirstTurn },
        { role: 'assistant', content: 'answer' },
      ],
    });
    // 残留空壳：history 里只有 system（首轮没发出去就退出了）。
    writeSession(root, '20261027-100018-193-c65dc7c3', {
      firstUser: '你出发一次人工介入',
      history: [{ role: 'system', content: 'sys' }],
    });
    // 普通会话：原样显示。
    writeSession(root, '20261116-090000-000-bbbbbbbb', {
      firstUser: '修一下登录页',
      history: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '修一下登录页' },
      ],
    });

    const sessions = listProjectSessions(root);
    assert.deepEqual(
      sessions.map((session) => session.id).sort(),
      ['20261116-090000-000-bbbbbbbb', '20261117-080000-000-aaaaaaaa'],
      '没有用户发言的会话不进列表',
    );
    const multimodal = sessions.find((session) => session.id === '20261117-080000-000-aaaaaaaa');
    assert.equal(multimodal?.firstUser, '这是？');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listProjectSessions：归档会话没有 firstUser 时不进列表（不逐条解 gz）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-ws-sync-archive-'));
  try {
    mkdirSync(join(sessionsOf(root), 'archive'), { recursive: true });
    writeFileSync(
      join(sessionsOf(root), 'archive', 'index.jsonl'),
      [
        JSON.stringify({ id: '20260901-000000-000-cccccccc', createdAt: '2026-09-01T00:00:00.000Z', firstUser: '' }),
        JSON.stringify({
          id: '20260902-000000-000-dddddddd',
          createdAt: '2026-09-02T00:00:00.000Z',
          firstUser: '聊过',
        }),
      ].join('\n'),
      'utf8',
    );
    const sessions = listProjectSessions(root);
    assert.deepEqual(
      sessions.map((session) => session.id),
      ['20260902-000000-000-dddddddd'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
