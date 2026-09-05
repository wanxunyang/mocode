/**
 * computer 工具 schema 校验单测(validateComputerArgs,纯函数,不碰屏幕/注入)。
 * 覆盖:未知动作、缺坐标/region、scroll/wait 边界、合法动作全通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateComputerArgs } from '../src/tools/builtins/computer.js';

test('validateComputerArgs: 未知动作报错并列出合法动作', () => {
  const err = validateComputerArgs({ action: 'explode' });
  assert.ok(err);
  assert.match(err!, /unknown action "explode"/);
  assert.match(err!, /screenshot/);
});

test('validateComputerArgs: 需要坐标的动作缺 coordinate 报错', () => {
  for (const action of ['left_click', 'mouse_move', 'scroll', 'left_click_drag']) {
    const err = validateComputerArgs({ action });
    assert.ok(err, `${action} should require coordinate`);
    assert.match(err!, /requires coordinate/);
  }
});

test('validateComputerArgs: 坐标必须是 norm1000 的 [x, y] 整数对', () => {
  // 越界
  assert.ok(validateComputerArgs({ action: 'left_click', coordinate: [1001, 500] }));
  assert.ok(validateComputerArgs({ action: 'left_click', coordinate: [-1, 500] }));
  // 长度错
  assert.ok(validateComputerArgs({ action: 'left_click', coordinate: [500] }));
  assert.ok(validateComputerArgs({ action: 'left_click', coordinate: [500, 500, 500] }));
  // 非数字
  assert.ok(validateComputerArgs({ action: 'left_click', coordinate: ['a', 500] }));
  // 合法
  assert.equal(validateComputerArgs({ action: 'left_click', coordinate: [500, 500] }), null);
  assert.equal(validateComputerArgs({ action: 'left_click', coordinate: [0, 0] }), null);
  assert.equal(validateComputerArgs({ action: 'left_click', coordinate: [1000, 1000] }), null);
});

test('validateComputerArgs: zoom 需要合法 region,w/h > 0', () => {
  assert.ok(validateComputerArgs({ action: 'zoom' }));
  assert.ok(validateComputerArgs({ action: 'zoom', region: [0, 0, 100] })); // 长度 3
  assert.ok(validateComputerArgs({ action: 'zoom', region: [0, 0, 0, 100] })); // w=0
  assert.ok(validateComputerArgs({ action: 'zoom', region: [0, 0, 100, -5] })); // h<0
  assert.equal(validateComputerArgs({ action: 'zoom', region: [100, 100, 200, 150] }), null);
});

test('validateComputerArgs: left_click_drag 需要 coordinate_to', () => {
  assert.ok(validateComputerArgs({ action: 'left_click_drag', coordinate: [100, 100] }));
  assert.equal(
    validateComputerArgs({ action: 'left_click_drag', coordinate: [100, 100], coordinate_to: [200, 200] }),
    null,
  );
});

test('validateComputerArgs: type/key 需要非空 text', () => {
  assert.ok(validateComputerArgs({ action: 'type' }));
  assert.ok(validateComputerArgs({ action: 'type', text: '' }));
  assert.ok(validateComputerArgs({ action: 'key' }));
  assert.equal(validateComputerArgs({ action: 'type', text: 'hello' }), null);
  assert.equal(validateComputerArgs({ action: 'key', text: 'ctrl+s' }), null);
});

test('validateComputerArgs: scroll 需要合法方向与 1-10 的整数 amount', () => {
  assert.ok(validateComputerArgs({ action: 'scroll', coordinate: [100, 100] })); // 缺方向
  assert.ok(validateComputerArgs({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'diagonal' }));
  assert.ok(
    validateComputerArgs({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'up', scroll_amount: 0 }),
  );
  assert.ok(
    validateComputerArgs({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'up', scroll_amount: 11 }),
  );
  assert.ok(
    validateComputerArgs({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'up', scroll_amount: 2.5 }),
  );
  // amount 缺省默认 3,合法
  assert.equal(validateComputerArgs({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'up' }), null);
  assert.equal(
    validateComputerArgs({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'down', scroll_amount: 5 }),
    null,
  );
});

test('validateComputerArgs: wait 需要 1-10000 的整数 duration_ms', () => {
  assert.ok(validateComputerArgs({ action: 'wait' }));
  assert.ok(validateComputerArgs({ action: 'wait', duration_ms: 0 }));
  assert.ok(validateComputerArgs({ action: 'wait', duration_ms: 10001 }));
  assert.ok(validateComputerArgs({ action: 'wait', duration_ms: 1.5 }));
  assert.equal(validateComputerArgs({ action: 'wait', duration_ms: 1000 }), null);
});

test('validateComputerArgs: 无坐标要求的动作(截图/光标位置)直接通过', () => {
  assert.equal(validateComputerArgs({ action: 'screenshot' }), null);
  assert.equal(validateComputerArgs({ action: 'screenshot', target: 'all' }), null);
  assert.equal(validateComputerArgs({ action: 'cursor_position' }), null);
});
