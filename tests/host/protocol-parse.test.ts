/**
 * Host NDJSON 协议解析测试。
 *
 * 守两条不变量：
 *  ① 合法命令的必填字段被完整保留（否则 host 会按缺省值行事，静默改行为）；
 *  ② 非法输入一律 null（fail-closed）—— 尤其 rollback apply 缺 turnIndex 这种
 *     「少一个参数就可能回滚错轮」的场景，绝不能靠默认值兜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_PROTOCOL_VERSION, parseCommand } from '../../src/host/protocol.js';

test('协议版本常量可用（客户端据此提示不匹配）', () => {
  assert.equal(HOST_PROTOCOL_VERSION, 4);
});

test('原有四条命令行为不变', () => {
  assert.deepEqual(parseCommand({ id: 'r1', type: 'cancel' }), { id: 'r1', type: 'cancel' });
  assert.deepEqual(parseCommand({ id: 'c1', type: 'compact' }), {
    id: 'c1',
    type: 'compact',
    focus: undefined,
  });
  const run = parseCommand({
    id: 'r2',
    type: 'run',
    prompt: 'hi',
    attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }],
  });
  assert.equal(run?.type, 'run');
  assert.equal((run as { attachments?: unknown[] }).attachments?.length, 1);

  // 非图片 dataUrl 仍被丢弃；文档走经过主进程解析的文本通道。
  const textAttachment = parseCommand({
    id: 'r3',
    type: 'run',
    prompt: 'hi',
    attachments: [
      { name: 'a.txt', dataUrl: 'data:text/plain;base64,AAA' },
      { name: 'a.pdf', text: 'PDF 正文', truncated: true },
      { name: 'empty.txt', text: '  ' },
      { name: 'too-long.txt', text: 'x'.repeat(100_001) },
    ],
  });
  assert.deepEqual((textAttachment as { attachments?: unknown[] }).attachments, [
    { name: 'a.pdf', text: 'PDF 正文', truncated: true },
  ]);

  // 拼错的 approval action 一律当取消。
  assert.equal(
    (parseCommand({ id: 'a1', type: 'approval', approvalId: 'x', action: 'allow' }) as { action: string }).action,
    'cancelled',
  );
});

test('set_mode 只接受 auto/plan', () => {
  assert.deepEqual(parseCommand({ id: 'm1', type: 'set_mode', mode: 'plan' }), {
    id: 'm1',
    type: 'set_mode',
    mode: 'plan',
  });
  assert.equal(parseCommand({ id: 'm2', type: 'set_mode', mode: 'yolo' }), null);
  assert.equal(parseCommand({ id: 'm3', type: 'set_mode' }), null);
});

test('sessions：action 白名单 + limit 上限钳制', () => {
  const list = parseCommand({ id: 's1', type: 'sessions', action: 'list', limit: 20 });
  assert.deepEqual(list, {
    id: 's1',
    type: 'sessions',
    action: 'list',
    query: undefined,
    limit: 20,
    sessionId: undefined,
    // 缺省范围 = 本工作空间（与终端 /sessions 一致），显式写出来便于断言。
    scope: undefined,
  });
  // scope 只认 current/all；拼错当缺省处理，不因此拒掉整条命令（GUI 至少还能看本空间）。
  assert.equal(
    (parseCommand({ id: 's6', type: 'sessions', action: 'list', scope: 'all' }) as { scope?: string }).scope,
    'all',
  );
  assert.equal(
    (parseCommand({ id: 's7', type: 'sessions', action: 'list', scope: 'plan' }) as { scope?: string }).scope,
    undefined,
  );
  // workspaces 是只读动作，不需要 runtime 也不带其它参数。
  assert.deepEqual(parseCommand({ id: 's8', type: 'sessions', action: 'workspaces' }), {
    id: 's8',
    type: 'sessions',
    action: 'workspaces',
    query: undefined,
    limit: undefined,
    sessionId: undefined,
    scope: undefined,
  });

  // 越界/非数字 limit 丢弃，交给 host 用默认值。
  assert.equal(
    (parseCommand({ id: 's2', type: 'sessions', action: 'list', limit: 9999 }) as { limit?: number }).limit,
    undefined,
  );
  assert.equal(
    (parseCommand({ id: 's3', type: 'sessions', action: 'list', limit: -1 }) as { limit?: number }).limit,
    undefined,
  );
  assert.equal(
    (parseCommand({ id: 's4', type: 'sessions', action: 'list', limit: 1.7 }) as { limit?: number }).limit,
    1,
  );
  assert.equal(parseCommand({ id: 's5', type: 'sessions', action: 'delete' }), null);
});

test('rollback apply 缺 turnIndex 一律拒绝', () => {
  assert.equal(parseCommand({ id: 'b1', type: 'rollback', action: 'apply' }), null);
  assert.equal(parseCommand({ id: 'b2', type: 'rollback', action: 'apply', turnIndex: -1 }), null);
  const ok = parseCommand({
    id: 'b3',
    type: 'rollback',
    action: 'apply',
    turnIndex: 0,
    revertFiles: ['src/a.ts', 'src/a.ts', 'src/b.ts', 42],
  });
  assert.deepEqual(ok, {
    id: 'b3',
    type: 'rollback',
    action: 'apply',
    turnIndex: 0,
    // 去重 + 丢掉非字符串项。
    revertFiles: ['src/a.ts', 'src/b.ts'],
  });
  // list 允许不带 turnIndex。
  assert.deepEqual(parseCommand({ id: 'b4', type: 'rollback', action: 'list' }), {
    id: 'b4',
    type: 'rollback',
    action: 'list',
    turnIndex: undefined,
    revertFiles: undefined,
  });
});

test('changes / usage 的缺省与枚举', () => {
  assert.deepEqual(parseCommand({ id: 'd1', type: 'changes', action: 'list' }), {
    id: 'd1',
    type: 'changes',
    action: 'list',
    turn: undefined,
    path: undefined,
  });
  assert.equal(parseCommand({ id: 'd2', type: 'changes', action: 'render' }), null);
  assert.equal(parseCommand({ id: 'u1', type: 'usage', scope: 'team' }), null);
  assert.deepEqual(parseCommand({ id: 'u2', type: 'usage', scope: 'global', days: 30 }), {
    id: 'u2',
    type: 'usage',
    scope: 'global',
    days: 30,
    sessionId: undefined,
  });
  // session 口径可显式带 sessionId：懒启动的 host 进程内 sessionId 是空串，只能由调用方指定。
  assert.equal(
    (
      parseCommand({ id: 'u4', type: 'usage', scope: 'session', sessionId: '20260101-000000-001-abcdef12' }) as {
        sessionId?: string;
      }
    ).sessionId,
    '20260101-000000-001-abcdef12',
  );
  // days 上限 366（非法值退回 host 默认 7 天）。
  assert.equal(
    (parseCommand({ id: 'u3', type: 'usage', scope: 'global', days: 4000 }) as { days?: number }).days,
    undefined,
  );
});

test('context_usage 保留显式 sessionId，空值回退当前会话', () => {
  assert.deepEqual(parseCommand({ id: 'ctx-1', type: 'context_usage', sessionId: 'session-a' }), {
    id: 'ctx-1',
    type: 'context_usage',
    sessionId: 'session-a',
  });
  assert.deepEqual(parseCommand({ id: 'ctx-2', type: 'context_usage', sessionId: 42 }), {
    id: 'ctx-2',
    type: 'context_usage',
    sessionId: undefined,
  });
  assert.equal(parseCommand({ id: 'ctx-3', type: 'contextUsage', sessionId: 'session-a' }), null);
});

test('memory：写操作必须显式 confirm', () => {
  const read = parseCommand({ id: 'y1', type: 'memory', action: 'health' });
  assert.deepEqual(read, {
    id: 'y1',
    type: 'memory',
    action: 'health',
    query: undefined,
    entryId: undefined,
    limit: undefined,
    confirm: false,
  });
  assert.equal((parseCommand({ id: 'y2', type: 'memory', action: 'forget' }) as { confirm: boolean }).confirm, false);
  assert.equal(
    (parseCommand({ id: 'y3', type: 'memory', action: 'forget', confirm: true }) as { confirm: boolean }).confirm,
    true,
  );
  // confirm 只认真正的 true，字符串 'true' 不算。
  assert.equal(
    (parseCommand({ id: 'y4', type: 'memory', action: 'forget', confirm: 'true' }) as { confirm: boolean }).confirm,
    false,
  );
  assert.equal(parseCommand({ id: 'y5', type: 'memory', action: 'purge-everything' }), null);
});

test('settings：patch 只收合法键与标量值', () => {
  assert.equal(parseCommand({ id: 'g1', type: 'settings', action: 'set' }), null);
  assert.equal(parseCommand({ id: 'g2', type: 'settings', action: 'set', patch: {} }), null);
  const set = parseCommand({
    id: 'g3',
    type: 'settings',
    action: 'set',
    patch: {
      REASONING_EFFORT: 'high',
      AUTO_COMPACT: true,
      MOCODE_REQUEST_MAX_KB: 800,
      MEMORY_ENABLED: null,
      // 以下应被丢弃：非法键名 / 对象值 / NaN
      'lower-case': 'x',
      NESTED: { a: 1 },
      BROKEN: Number.NaN,
    },
  });
  assert.deepEqual(set, {
    id: 'g3',
    type: 'settings',
    action: 'set',
    patch: { REASONING_EFFORT: 'high', AUTO_COMPACT: true, MOCODE_REQUEST_MAX_KB: 800, MEMORY_ENABLED: null },
  });
  // get 不接受 patch（也不需要）。
  assert.deepEqual(parseCommand({ id: 'g4', type: 'settings', action: 'get' }), {
    id: 'g4',
    type: 'settings',
    action: 'get',
    patch: undefined,
  });
});

test('commit_message 保留暂存 diff 并拒绝缺参', () => {
  assert.deepEqual(
    parseCommand({
      id: 'cm1',
      type: 'commit_message',
      diff: '+change',
      stat: 'a.ts | 1 +',
      files: ['src/a.ts', 'src/a.ts', '中文 file.ts'],
      truncated: true,
      language: 'zh-CN',
    }),
    {
      id: 'cm1',
      type: 'commit_message',
      diff: '+change',
      stat: 'a.ts | 1 +',
      files: ['src/a.ts', '中文 file.ts'],
      truncated: true,
      language: 'zh-CN',
    },
  );
  assert.equal(parseCommand({ id: 'cm2', type: 'commit_message', stat: 'a.ts | 1 +', files: ['a.ts'] }), null);
  assert.equal(
    parseCommand({ id: 'cm3', type: 'commit_message', diff: '', stat: 'a.ts | 1 +', files: ['a.ts'] }),
    null,
  );
  assert.equal(parseCommand({ id: 'cm4', type: 'commit_message', diff: '+change', stat: '', files: ['a.ts'] }), null);
  assert.equal(
    parseCommand({ id: 'cm5', type: 'commit_message', diff: '+change', stat: 'a.ts | 1 +', files: [] }),
    null,
  );
});

test('独立提交信息取消只路由目标 requestId，缺目标 fail-closed', () => {
  assert.deepEqual(parseCommand({ id: 'cancel-1', type: 'cancel_commit_message', targetId: 'panel-1' }), {
    id: 'cancel-1',
    type: 'cancel_commit_message',
    targetId: 'panel-1',
  });
  assert.equal(parseCommand({ id: 'cancel-2', type: 'cancel_commit_message' }), null);
  assert.equal(parseCommand({ id: 'cancel-3', type: 'cancel_commit_message', targetId: '' }), null);
});

test('未知 type / 缺 id 一律 null', () => {
  assert.equal(parseCommand({ id: 'x1', type: 'teleport' }), null);
  assert.equal(parseCommand({ type: 'cancel' }), null);
  assert.equal(parseCommand({ id: 'x2' }), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand('cancel'), null);
});
