import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compactRecoveryLog,
  compactRecoveryLogs,
  deleteRecoveryLog,
  readRecovery,
  readRecoveryAsync,
  recoveryLog,
} from '../../packages/work-app/src/recovery-log.js';

/** 临时 root：同步 / 异步回调都支持（瘦身那几条要走 await）。 */
async function withRoot(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-recovery-'));
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const event = (name: string, payload: Record<string, unknown> = {}) => ({ type: 'event', event: name, payload });

test('恢复多轮用户消息、附件、正文、工具结构化结果和上下文快照', () =>
  withRoot((root) => {
    const log = recoveryLog(root, 'task-1');
    const image = { name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' };
    const document = { name: 'spec.pdf', text: 'PDF 提取正文', truncated: true };
    log.user('先看这张图', [image, document]);
    log.event(event('run_started', { sessionId: 'session-1' }));
    log.event(event('text_delta', { text: '第一段' }));
    log.event(event('approval_requested', { approvalId: 'approval-1', title: '允许读取？' }));
    log.event(event('tool_started', { id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }));
    log.event(event('tool_output', { id: 'call-1', name: 'read_file', chunk: 'partial output' }));
    log.event(
      event('tool_completed', {
        id: 'call-1',
        name: 'read_file',
        output: 'complete output',
        status: 'success',
        changedFiles: ['a.ts'],
        editStartLine: 12,
      }),
    );
    log.event(event('live_usage', { contextUsage: { tokens: 123, percent: 4 } }));
    log.event(event('run_completed', { terminationReason: 'completed' }));
    log.user('继续');
    log.event(event('run_started', { sessionId: 'session-1' }));
    log.event(event('text_delta', { text: '第二段' }));
    log.event(event('run_aborted'));

    const snapshot = readRecovery(root, 'task-1');
    assert.ok(snapshot);
    assert.deepEqual(snapshot.items[0], { kind: 'user', text: '先看这张图', attachments: [image, document] });
    assert.deepEqual(
      snapshot.items.slice(1).map((item) => item.kind),
      ['text', 'tool', 'user', 'text'],
    );
    const tool = snapshot.items[2];
    assert.ok(tool?.kind === 'tool');
    assert.equal(tool.output, 'complete output');
    assert.equal(tool.done, true);
    assert.equal(tool.payload?.status, 'success');
    assert.equal(tool.payload?.editStartLine, 12);
    assert.deepEqual(snapshot.contextUsage, { tokens: 123, percent: 4 });
    assert.equal(snapshot.pendingApproval, null);
    assert.equal(snapshot.interrupted, false);
  }));

test('切回仍在运行的任务时保留工具执行态，不提前标记中止', () =>
  withRoot((root) => {
    const log = recoveryLog(root, 'task-live');
    log.user('执行命令');
    log.event(event('run_started'));
    log.event(event('tool_started', { id: 'live-call', name: 'run_command', arguments: '{"command":"npm test"}' }));
    log.event(event('tool_output', { id: 'live-call', chunk: '测试运行中' }));
    const snapshot = readRecovery(root, 'task-live', true);
    assert.ok(snapshot);
    const tool = snapshot.items[1];
    assert.ok(tool?.kind === 'tool');
    assert.equal(tool.done, false);
    assert.equal(tool.payload?.status, undefined);
    assert.equal(tool.output, '测试运行中');
  }));

test('崩溃留下半行时保留此前输出，未完成工具只回放且绝不执行', () =>
  withRoot((root) => {
    const log = recoveryLog(root, 'task-2');
    log.user('开始');
    log.event(event('run_started'));
    log.event(event('text_delta', { text: '已经输出到 UI' }));
    log.event(
      event('tool_started', { id: 'call-crash', name: 'write_file', arguments: '{"path":"should-not-run.txt"}' }),
    );
    log.event(event('tool_output', { id: 'call-crash', name: 'write_file', chunk: '已知的部分输出' }));
    const file = path.join(root, 'task-recovery', 'task-2.jsonl');
    fs.appendFileSync(file, '{"seq":999,"at":"2026-11-14T00:00:00.000Z","type":"event"', 'utf8');
    fs.appendFileSync(file, '\nnot-json\n', 'utf8');

    const snapshot = readRecovery(root, 'task-2');
    assert.ok(snapshot);
    assert.equal(snapshot.interrupted, true);
    assert.deepEqual(
      snapshot.items.map((item) => item.kind),
      ['user', 'text', 'tool'],
    );
    const tool = snapshot.items[2];
    assert.ok(tool?.kind === 'tool');
    assert.equal(tool.done, true);
    assert.equal(tool.payload?.status, 'aborted');
    assert.equal(tool.output, '已知的部分输出');
    assert.equal(snapshot.pendingApproval, null);
    assert.equal(fs.existsSync(path.join(root, 'should-not-run.txt')), false);

    // 模拟 App 重启：新日志对象先给残缺尾行补换行，再追加续聊，不能粘坏新记录。
    const continued = recoveryLog(root, 'task-2');
    continued.user('崩溃后继续');
    continued.event(event('run_started'));
    continued.event(event('text_delta', { text: '只新增回答，不重放旧工具' }));
    continued.event(event('run_completed'));
    const resumed = readRecovery(root, 'task-2');
    assert.ok(resumed);
    assert.deepEqual(
      resumed.items.filter((item) => item.kind === 'user').map((item) => item.kind === 'user' && item.text),
      ['开始', '崩溃后继续'],
    );
    const oldTool = resumed.items[2];
    assert.ok(oldTool?.kind === 'tool');
    assert.equal(oldTool.done, true);
    assert.equal(oldTool.payload?.status, 'aborted');
    assert.equal(resumed.interrupted, false);
    assert.equal(fs.existsSync(path.join(root, 'should-not-run.txt')), false);
  }));

test('回滚与重新生成同步裁剪 UI 日志，非法用户序号不清空历史', () =>
  withRoot((root) => {
    const log = recoveryLog(root, 'task-3');
    for (const [index, text] of ['第一轮', '第二轮', '第三轮'].entries()) {
      log.user(text);
      log.event(event('run_started'));
      log.event(event('text_delta', { text: `回答 ${index}` }));
      log.event(event('run_completed'));
    }
    log.truncate(99);
    assert.equal(readRecovery(root, 'task-3')?.items.filter((item) => item.kind === 'user').length, 3);
    log.truncate(1);
    let snapshot = readRecovery(root, 'task-3');
    assert.deepEqual(
      snapshot?.items.map((item) => (item.kind === 'user' ? item.text : '')),
      ['第一轮', ''],
    );

    log.user('新的第二轮', [{ name: 'new.png', dataUrl: 'data:image/png;base64,BBBB' }]);
    log.event(event('run_started'));
    log.event(event('text_delta', { text: '将被重新生成' }));
    log.regenerate(1);
    snapshot = readRecovery(root, 'task-3');
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.items.map((item) => item.kind),
      ['user', 'text', 'user'],
    );
    const retained = snapshot.items[2];
    assert.ok(retained?.kind === 'user');
    assert.equal(retained.text, '新的第二轮');
    assert.equal(retained.attachments?.[0]?.name, 'new.png');
    log.event(event('run_started'));
    log.event(event('text_delta', { text: '重新生成的回答' }));
    assert.equal(readRecovery(root, 'task-3')?.items.at(-1)?.kind, 'text');
  }));

test('拒绝路径逃逸，损坏记录不会混入会话，删除后恢复为空', () =>
  withRoot((root) => {
    recoveryLog(root, '../escape').user('不能落盘');
    recoveryLog(root, 'nested/evil').event(event('text_delta', { text: '不能落盘' }));
    assert.equal(fs.existsSync(path.join(root, 'escape.jsonl')), false);
    assert.equal(readRecovery(root, '../escape'), null);

    const file = path.join(root, 'task-recovery', 'task-4.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ seq: 1, at: 'bad', type: 'user', text: 42 }),
        JSON.stringify({
          seq: 2,
          at: new Date().toISOString(),
          type: 'event',
          event: { type: 'event', event: 'text_delta', payload: [] },
        }),
        JSON.stringify({ seq: 3, at: new Date().toISOString(), type: 'user', text: '有效消息' }),
      ].join('\n'),
      'utf8',
    );
    assert.deepEqual(readRecovery(root, 'task-4')?.items, [{ kind: 'user', text: '有效消息' }]);
    deleteRecoveryLog(root, 'task-4');
    assert.equal(readRecovery(root, 'task-4'), null);
  }));
test('context_compacted 落成系统提示行：重启回放仍有「已压缩」，且刷新上下文快照', () =>
  withRoot((root) => {
    const log = recoveryLog(root, 'task-compact');
    log.user('跑一个长任务');
    log.event(event('run_started'));
    log.event(
      event('context_compacted', {
        manual: false,
        summarized: true,
        beforeTokens: 205_000,
        afterTokens: 29_000,
        contextWindow: 262_144,
        contextUsage: { tokens: 29_000, percent: 11 },
      }),
    );
    log.event(event('text_delta', { text: '继续干活' }));
    log.event(event('run_completed'));

    const snapshot = readRecovery(root, 'task-compact');
    assert.ok(snapshot);
    // 只存结构不存译文：文案由渲染层按当前语言生成，切语言后回放不会残留旧语言。
    assert.deepEqual(snapshot.items[1], {
      kind: 'notice',
      notice: {
        type: 'contextCompacted',
        beforeTokens: 205_000,
        afterTokens: 29_000,
        windowTokens: 262_144,
        summarized: true,
      },
    });
    assert.deepEqual(snapshot.contextUsage, { tokens: 29_000, percent: 11 });
    assert.equal(snapshot.items[2]?.kind, 'text');
  }));

test('超长日志里的 truncate 不再抛 RangeError（展开传参上限）', () =>
  withRoot((root) => {
    // 真实事故：25 万条的恢复日志里只要有一条 truncate，`splice(0, len, ...cut)` 就会
    // RangeError → work:select-task 整条 IPC reject → 用户点会话毫无反应。
    const file = path.join(root, 'task-recovery', 'task-long.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    let seq = 0;
    lines.push(JSON.stringify({ seq: ++seq, at: new Date().toISOString(), type: 'user', text: '第一轮' }));
    lines.push(JSON.stringify({ seq: ++seq, at: new Date().toISOString(), type: 'user', text: '第二轮' }));
    // 13 万条 text_delta 足够超过实参上限（≈125k），且不走 live_usage 前缀短路。
    for (let i = 0; i < 130_000; i += 1) {
      lines.push(
        JSON.stringify({
          seq: ++seq,
          at: new Date().toISOString(),
          type: 'event',
          event: { type: 'event', event: 'text_delta', payload: { text: 'x' } },
        }),
      );
    }
    lines.push(JSON.stringify({ seq: ++seq, at: new Date().toISOString(), type: 'truncate', userIndex: 1 }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const snapshot = readRecovery(root, 'task-long');
    assert.ok(snapshot);
    const users = snapshot.items.filter((item) => item.kind === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0]?.kind === 'user' ? users[0].text : '', '第一轮');
  }));

test('快照剥掉 payload 里与顶层重复的 arguments/output/chunk，结构化字段全留', () =>
  withRoot((root) => {
    // 回归背景：payload 是事件原文的拷贝，而 arguments/output 已经提到 item 顶层。
    // 真实会话 905/910 个工具项两处逐字相同 —— 占一份 6.54MB 快照的 47%，白白 stringify + 过 IPC。
    const log = recoveryLog(root, 'task-dedup');
    log.user('读文件');
    log.event(event('run_started'));
    log.event(event('tool_started', { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }));
    log.event(event('tool_output', { id: 'c1', name: 'read_file', chunk: 'partial' }));
    log.event(
      event('tool_completed', {
        id: 'c1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
        output: 'complete output',
        status: 'success',
        code: 'OK',
        changedFiles: ['a.ts'],
        editStartLine: 12,
        durationMs: 34,
      }),
    );
    const snapshot = readRecovery(root, 'task-dedup');
    assert.ok(snapshot);
    const tool = snapshot.items[1];
    assert.ok(tool?.kind === 'tool');
    // 顶层仍是完整内容（渲染层回放靠它）。
    assert.equal(tool.args, '{"path":"a.ts"}');
    assert.equal(tool.output, 'complete output');
    // payload 里不再留同一份拷贝。
    assert.equal('output' in (tool.payload ?? {}), false);
    assert.equal('arguments' in (tool.payload ?? {}), false);
    assert.equal('chunk' in (tool.payload ?? {}), false);
    // 只有 payload 才有的结构化信息一个字都不能少（toolOutcomeInfo / diff 视图全靠这些）。
    assert.equal(tool.payload?.status, 'success');
    assert.equal(tool.payload?.code, 'OK');
    assert.deepEqual(tool.payload?.changedFiles, ['a.ts']);
    assert.equal(tool.payload?.editStartLine, 12);
    assert.equal(tool.payload?.durationMs, 34);
  }));

test('writer 只保留百分比变化了的 live_usage，恢复仍能拿到用量快照', () =>
  withRoot((root) => {
    const log = recoveryLog(root, 'task-usage');
    log.user('跑起来');
    log.event(event('run_started'));
    // 同一百分比的 200 条进度只该落 1 条；百分比变化时再落。
    for (let i = 0; i < 200; i += 1) log.event(event('live_usage', { contextUsage: { tokens: 100 + i, percent: 4 } }));
    log.event(event('live_usage', { contextUsage: { tokens: 300, percent: 5 } }));
    const file = path.join(root, 'task-recovery', 'task-usage.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.filter((line) => line.includes('live_usage')).length, 2);
    assert.deepEqual(readRecovery(root, 'task-usage')?.contextUsage, { tokens: 300, percent: 5 });
  }));

test('compactRecoveryLog 只删 live_usage 行、保留最后一条，且不改其它内容', () =>
  withRoot(async (root) => {
    const file = path.join(root, 'task-recovery', 'task-fat.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    let seq = 0;
    const push = (entry: Record<string, unknown>): void => {
      lines.push(JSON.stringify({ ...entry, seq: ++seq, at: new Date().toISOString() }));
    };
    push({ type: 'user', text: '第一轮' });
    push({ type: 'event', event: { type: 'event', event: 'run_started', payload: {} } });
    // 撑过 2MB 阈值：3000 条带填充文本的 live_usage。
    const filler = 'x'.repeat(800);
    for (let i = 0; i < 3000; i += 1) {
      push({
        type: 'event',
        event: { type: 'event', event: 'live_usage', payload: { contextUsage: { percent: i % 60, filler } } },
      });
    }
    push({ type: 'event', event: { type: 'event', event: 'text_delta', payload: { text: '回答' } } });
    // 越界序号：cutAtUser 找不到目标时不清空日志，正好用它验证瘦身不破坏回滚语义。
    push({ type: 'truncate', userIndex: 9 });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const beforeBytes = fs.statSync(file).size;
    assert.ok(beforeBytes > 2 * 1024 * 1024, `样本应超过阈值，实际 ${beforeBytes}`);

    assert.equal(await compactRecoveryLog(root, 'task-fat'), true);
    assert.ok(fs.statSync(file).size < beforeBytes / 10);
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.filter((line) => line.includes('"live_usage"')).length, 1);
    // 其它记录一条不少、顺序不变：user + run_started + 保留的 live_usage + text_delta + truncate。
    assert.equal(kept.length, 5);
    assert.match(kept[0]!, /"第一轮"/);
    assert.match(kept.at(-1)!, /"truncate"/);
    const snapshot = await readRecoveryAsync(root, 'task-fat');
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.items.filter((item) => item.kind === 'user').map((item) => item.kind === 'user' && item.text),
      ['第一轮'],
    );
    assert.equal(snapshot.contextUsage?.percent, 59);
  }));

test('compactRecoveryLogs 扫描 root/task-recovery 并对超阈值日志瘦身', () =>
  withRoot(async (root) => {
    const file = path.join(root, 'task-recovery', 'task-scan.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    let seq = 0;
    lines.push(JSON.stringify({ seq: ++seq, at: new Date().toISOString(), type: 'user', text: '你好' }));
    const filler = 'y'.repeat(800);
    for (let i = 0; i < 3000; i += 1) {
      lines.push(
        JSON.stringify({
          seq: ++seq,
          at: new Date().toISOString(),
          type: 'event',
          event: { type: 'event', event: 'live_usage', payload: { contextUsage: { percent: i % 40, filler } } },
        }),
      );
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const before = fs.statSync(file).size;
    assert.equal(await compactRecoveryLogs(root), 1);
    assert.ok(fs.statSync(file).size < before / 10);
    // 再跑一次：已经没有可省的，返回 0 并且文件不再变。
    const compactedOnce = fs.statSync(file).size;
    assert.equal(await compactRecoveryLogs(root), 0);
    assert.equal(fs.statSync(file).size, compactedOnce);
  }));
