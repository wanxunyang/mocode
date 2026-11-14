import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteRecoveryLog, readRecovery, recoveryLog } from '../../packages/work-app/src/recovery-log.js';

function withRoot(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-recovery-'));
  try {
    run(root);
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
