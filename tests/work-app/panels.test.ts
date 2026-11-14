/// <reference lib="dom" />

import test from 'node:test';
import assert from 'node:assert/strict';
import { initPanels, isPanelEvent, requestPanelCommand } from '../../packages/work-app/src/renderer/panels.js';

test('关闭面板会取消对应 AI 请求，迟到回执不再进入 pending 分发', async () => {
  const sent: Record<string, unknown>[] = [];
  initPanels({
    t: (key) => key,
    icon: () => '',
    escapeHtml: String,
    toast: () => {},
    currentTaskId: () => undefined,
    currentSessionId: () => undefined,
    reloadTask: () => {},
    send: async (command) => {
      sent.push(command);
      return { ok: true };
    },
  });
  const controller = new AbortController();
  const pending = requestPanelCommand({ type: 'commit_message' }, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).type, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = sent.find((command) => command.type === 'cancel_commit_message');
  assert.ok(cancel, '取消必须经主进程发给 host');
  assert.equal(typeof cancel.targetId, 'string');
  assert.match(String(cancel.targetId), /^panel-/);
  assert.notEqual(cancel.id, cancel.targetId);
  assert.equal(
    isPanelEvent({
      type: 'event',
      event: 'commit_message_report',
      requestId: String(cancel.targetId),
      payload: { message: 'stale' },
    }),
    false,
  );
});
