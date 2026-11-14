import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_PANEL_PARTITION_PREFIX,
  BROWSER_PANEL_SENTINEL,
  clampPanelBounds,
  panelPartitionFor,
  validatePanelUrl,
} from '../../packages/work-app/src/browser-panel.js';

// 这两条是跨进程约定：主进程（BrowserHost）与渲染层必须算出一模一样的分区名，
// 否则 agent 接管的页面和用户看到的不是同一份登录态。

test('panelPartitionFor 每个空间一份持久分区，未知空间退到 default', () => {
  assert.equal(panelPartitionFor('proj-1'), `${BROWSER_PANEL_PARTITION_PREFIX}-proj-1`);
  assert.equal(panelPartitionFor(undefined), `${BROWSER_PANEL_PARTITION_PREFIX}-default`);
  assert.equal(panelPartitionFor(null), `${BROWSER_PANEL_PARTITION_PREFIX}-default`);
  assert.equal(panelPartitionFor(''), `${BROWSER_PANEL_PARTITION_PREFIX}-default`);
  // persist: 前缀是跨会话保留登录态的前提，不能退化成内存分区。
  assert.ok(panelPartitionFor('proj-1').startsWith('persist:'));
});

test('validatePanelUrl 只放行 http(s)：file:// 等于绕过 sandbox', () => {
  assert.equal(validatePanelUrl('https://example.com'), 'https://example.com/');
  assert.equal(validatePanelUrl('  http://localhost:5173/app  '), 'http://localhost:5173/app');
  assert.equal(validatePanelUrl('file:///C:/secret.txt'), null);
  assert.equal(validatePanelUrl('javascript:alert(1)'), null);
  assert.equal(validatePanelUrl('about:blank'), null);
  assert.equal(validatePanelUrl(''), null);
  assert.equal(validatePanelUrl('   '), null);
  assert.equal(validatePanelUrl('not a url'), null);
});

test('clampPanelBounds 把超出窗口的矩形夹回内容区', () => {
  const viewport = { width: 1000, height: 700 };
  assert.deepEqual(clampPanelBounds({ x: 10, y: 20, width: 300, height: 400 }, viewport), {
    x: 10,
    y: 20,
    width: 300,
    height: 400,
  });
  // 负坐标归零，尺寸按夹取后的可用空间收缩。
  assert.deepEqual(clampPanelBounds({ x: -50, y: -20, width: 300, height: 400 }, viewport), {
    x: 0,
    y: 0,
    width: 300,
    height: 400,
  });
  assert.deepEqual(clampPanelBounds({ x: 900, y: 600, width: 300, height: 400 }, viewport), {
    x: 900,
    y: 600,
    width: 100,
    height: 100,
  });
  assert.deepEqual(clampPanelBounds({ x: 2000, y: 2000, width: 100, height: 100 }, viewport), {
    x: 1000,
    y: 700,
    width: 0,
    height: 0,
  });
  // 小数取整：原生视图的 setBounds 只接受整数。
  assert.deepEqual(clampPanelBounds({ x: 10.6, y: 20.2, width: 300.7, height: 400.4 }, viewport), {
    x: 11,
    y: 20,
    width: 301,
    height: 400,
  });
});

test('哨兵 hash 与空白起始页组合成面板初始地址', () => {
  // agent 侧（browser-manager.ts）按这段 hash 认出「这块空白页就是面板」。
  assert.equal(BROWSER_PANEL_SENTINEL, '#mocode-browser-panel');
});
