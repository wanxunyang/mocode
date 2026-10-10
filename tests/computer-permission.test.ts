/**
 * computer 工具的权限层单测:
 * - computerTextNeedsReview:敏感文本(URL/密码/支付)识别;
 * - permissionFingerprint:computer 按动作粒度授权(坐标/文本不进指纹),
 *   坐标不同的同一动作指纹相同,不同动作指纹不同。
 * 不触发真实权限弹窗(只测纯函数与指纹计算)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computerTextNeedsReview, permissionFingerprint } from '../src/permissions/index.js';
import type { Tool } from '../src/tools/types.js';

// 最小化 computer 工具桩:permissionFingerprint 只读 tool.name 与 capabilities.resources。
const computerToolStub: Tool = {
  name: 'computer',
  description: 'stub',
  parameters: {},
  risk: 'dangerous',
  capabilities: { effect: 'process', concurrency: 'serial', resources: () => ['desktop'] },
  execute: async () => 'ok',
};

test('computerTextNeedsReview: URL 命中', () => {
  assert.equal(computerTextNeedsReview('open https://evil.example.com/x'), true);
  assert.equal(computerTextNeedsReview('visit www.banking-site.com now'), true);
  assert.equal(computerTextNeedsReview('plain text without links'), false);
});

test('computerTextNeedsReview: 密码形态命中', () => {
  assert.equal(computerTextNeedsReview('password: hunter2'), true);
  assert.equal(computerTextNeedsReview('api_key=sk-abc123'), true);
  assert.equal(computerTextNeedsReview('token: xyz'), true);
  assert.equal(computerTextNeedsReview('a normal sentence'), false);
});

test('computerTextNeedsReview: 支付/凭证关键词命中(中英)', () => {
  assert.equal(computerTextNeedsReview('enter card number 4111'), true);
  assert.equal(computerTextNeedsReview('cvv 123'), true);
  assert.equal(computerTextNeedsReview('输入密码'), true);
  assert.equal(computerTextNeedsReview('确认支付订单'), true);
  assert.equal(computerTextNeedsReview('hello world'), false);
});

test('permissionFingerprint: computer 同一动作不同坐标 → 指纹相同(按动作粒度授权)', () => {
  const a = permissionFingerprint(computerToolStub, { action: 'left_click', coordinate: [100, 200] });
  const b = permissionFingerprint(computerToolStub, { action: 'left_click', coordinate: [900, 50] });
  assert.equal(a, b);
});

test('permissionFingerprint: computer 不同动作 → 指纹不同', () => {
  const click = permissionFingerprint(computerToolStub, { action: 'left_click', coordinate: [100, 200] });
  const right = permissionFingerprint(computerToolStub, { action: 'right_click', coordinate: [100, 200] });
  const type = permissionFingerprint(computerToolStub, { action: 'type', text: 'hello' });
  assert.notEqual(click, right);
  assert.notEqual(click, type);
});

test('permissionFingerprint: computer 文本内容不进指纹(内容审查由 forceOnce 路径兜住)', () => {
  const t1 = permissionFingerprint(computerToolStub, { action: 'type', text: 'hello' });
  const t2 = permissionFingerprint(computerToolStub, { action: 'type', text: 'password: secret' });
  assert.equal(t1, t2);
});

test('permissionFingerprint: 非 computer 工具行为不变(run_command 仍按命令)', () => {
  const runStub: Tool = {
    name: 'run_command',
    description: 'stub',
    parameters: {},
    capabilities: { effect: 'process', concurrency: 'serial' },
    execute: async () => 'ok',
  };
  const a = permissionFingerprint(runStub, { command: 'git status' });
  const b = permissionFingerprint(runStub, { command: 'git push' });
  assert.notEqual(a, b);
  assert.equal(permissionFingerprint(runStub, { command: 'git status' }), a);
});

// ── P1 UIA 元素动作的审查(design-notes/computer-use-rpa.md §2.6)──────────

test('computerTargetNeedsReview: 删除/发送/支付类按钮名命中(中英)', async () => {
  const { computerTargetNeedsReview } = await import('../src/permissions/index.js');
  assert.equal(computerTargetNeedsReview('Delete'), true);
  assert.equal(computerTargetNeedsReview('Send message'), true);
  assert.equal(computerTargetNeedsReview('确认付款'), true);
  assert.equal(computerTargetNeedsReview('删除文件'), true);
  assert.equal(computerTargetNeedsReview('文件'), false);
  assert.equal(computerTargetNeedsReview('Close'), false);
});

test('computerArgsNeedReview: set_value 文本与 click_element 目标名都走 forceOnce', async () => {
  const { computerArgsNeedReview } = await import('../src/permissions/index.js');
  const { setElementRefNames, clearElementRefNames } = await import('../src/runtime/uia-selector.js');
  const node = (name: string) => ({
    id: 1,
    parent: 0,
    path: '0',
    depth: 1,
    role: 'Button',
    name,
    automationId: '',
    className: '',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    enabled: true,
    offscreen: false,
    isPassword: false,
    patterns: ['invoke'],
  });
  try {
    assert.equal(computerArgsNeedReview({ action: 'set_value', ref: 'e1', text: 'password: x' }), true);
    assert.equal(computerArgsNeedReview({ action: 'set_value', ref: 'e1', text: 'hello' }), false);
    setElementRefNames([
      { ref: 'e1', node: node('发送') },
      { ref: 'e2', node: node('文件') },
    ]);
    assert.equal(computerArgsNeedReview({ action: 'click_element', ref: 'e1' }), true);
    assert.equal(computerArgsNeedReview({ action: 'click_element', ref: 'e2' }), false);
    // 未登记 ref:工具自身会 ELEMENT_NOT_FOUND,这里不额外强制。
    assert.equal(computerArgsNeedReview({ action: 'click_element', ref: 'e99' }), false);
  } finally {
    clearElementRefNames();
  }
});
