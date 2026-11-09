import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLaneCommand,
  appendLaneEvent,
  laneChannelPaths,
  parseJsonLines,
  readChannel,
  readLinesFrom,
  resetLaneChannel,
} from '../../src/orchestrator/lane-channel.js';

function withRoot<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-channel-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('laneChannelPaths: both channels live under the run artifacts so one run is self-contained', () => {
  const paths = laneChannelPaths('C:/work', 'run-1', 'lane-a');
  // 用 path 拼出来的期望值：这里断言的是目录结构，不是某个平台的分隔符。
  assert.equal(path.dirname(paths.events), path.dirname(paths.commands));
  assert.ok(paths.events.includes(path.join('orchestrations', 'run-1', 'artifacts', 'lanes', 'lane-a')));
  assert.ok(paths.events.endsWith('lane.events'));
  assert.ok(paths.commands.endsWith('lane.commands'));
});

test('commands: the supervisor can enqueue before the lane window exists', () => {
  withRoot((root) => {
    const paths = laneChannelPaths(root, 'run-1', 'lane-a');
    // 目录都还不存在：append 必须自己建，窗口晚起来也不能丢指令。
    appendLaneCommand(paths, { t: 1, id: 'c1', taskId: 'task-1', kind: 'task', text: 'do it' });
    appendLaneCommand(paths, { t: 2, id: 'c2', kind: 'tell', text: 'also docs' });
    const read = readChannel<{ id: string; text: string }>(paths.commands, 0);
    assert.deepEqual(
      read.items.map((item) => item.id),
      ['c1', 'c2'],
    );
    assert.equal(read.consumed, 2);
  });
});

test('events: a half-written trailing line is left for the next read, never parsed early', () => {
  withRoot((root) => {
    const paths = laneChannelPaths(root, 'run-1', 'lane-a');
    fs.mkdirSync(path.dirname(paths.events), { recursive: true });
    fs.writeFileSync(paths.events, '{"t":1,"kind":"ready"}\n{"t":2,"kin', 'utf8');

    const first = readChannel<{ kind: string }>(paths.events, 0);
    assert.deepEqual(
      first.items.map((item) => item.kind),
      ['ready'],
    );
    assert.equal(first.consumed, 1, 'the incomplete line must not be counted as consumed');

    fs.appendFileSync(paths.events, 'd":"exit"}\n', 'utf8');
    const second = readChannel<{ kind: string }>(paths.events, first.consumed);
    assert.deepEqual(
      second.items.map((item) => item.kind),
      ['exit'],
    );
    assert.equal(second.consumed, 2);
  });
});

test('readLinesFrom: a missing file is empty, not an error', () => {
  withRoot((root) => {
    const read = readLinesFrom(path.join(root, 'nope.jsonl'), 0);
    assert.deepEqual(read, { lines: [], consumed: 0, total: 0 });
  });
});

test('parseJsonLines: a corrupt line inside the stream is skipped, not thrown', () => {
  const items = parseJsonLines<{ kind: string }>('{"kind":"ready"}\nnot json\n{"kind":"exit"}');
  assert.deepEqual(
    items.map((item) => item.kind),
    ['ready', 'exit'],
  );
});

test('resetLaneChannel: a new window clears BOTH channels so old commands are not replayed', () => {
  withRoot((root) => {
    const paths = laneChannelPaths(root, 'run-1', 'lane-a');
    appendLaneEvent(paths, { t: 1, kind: 'ready' });
    appendLaneCommand(paths, { t: 1, id: 'c1', kind: 'task', text: 'do it' });

    resetLaneChannel(paths);
    assert.deepEqual(readChannel(paths.events, 0).items, []);
    // 真实事故：只清 events 时，新窗口的读游标从 0 开始，于是把 20 小时前那条已经执行过的
    // 指令当成待办又跑了一遍——人看到的任务是错的。所以 commands 必须一起清。
    assert.deepEqual(readChannel(paths.commands, 0).items, [], 'stale commands must not survive a restart');
  });
});

test('readChannel: total lets a caller notice the file was truncated under it', () => {
  withRoot((root) => {
    const paths = laneChannelPaths(root, 'run-1', 'lane-a');
    appendLaneEvent(paths, { t: 1, kind: 'ready' });
    appendLaneEvent(paths, { t: 2, kind: 'exit' });
    appendLaneEvent(paths, { t: 3, kind: 'ready' });
    const first = readChannel(paths.events, 0);
    assert.equal(first.total, 3);
    assert.equal(first.consumed, 3);

    // 新窗口 reset 掉 events 后只写一行：total(1) < consumed(3)，调用方据此把游标归零。
    resetLaneChannel(paths);
    appendLaneEvent(paths, { t: 4, kind: 'ready' });
    const stale = readChannel(paths.events, first.consumed);
    assert.deepEqual(stale.items, [], 'a stale cursor sees nothing, which is exactly the bug');
    assert.equal(stale.total, 1);
    const reread = readChannel(paths.events, 0);
    assert.equal(reread.items.length, 1, 'resetting the cursor recovers the new content');
  });
});

test('appendLaneEvent: an unwritable channel never throws into the turn', () => {
  // 把 events 指到一个目录：append 会失败，但这是旁路日志，不能把正在跑的对话带崩。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-channel-bad-'));
  try {
    const paths = laneChannelPaths(root, 'run-1', 'lane-a');
    fs.mkdirSync(paths.events, { recursive: true });
    assert.doesNotThrow(() => appendLaneEvent(paths, { t: 1, kind: 'ready' }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
