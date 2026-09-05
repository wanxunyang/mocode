import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deleteBackwardAt,
  deleteForwardAt,
  deleteToLineEndAt,
  deleteToLineStartAt,
  insertTextAt,
} from '../src/ui/prompt-internal/editor-operations.js';

describe('prompt editor 基本文本操作', () => {
  it('在光标处插入普通文本与换行并推进光标', () => {
    assert.deepEqual(insertTextAt('ac', 1, 'b'), { text: 'abc', cursor: 2 });
    assert.deepEqual(insertTextAt('ab', 2, '\ncd'), { text: 'ab\ncd', cursor: 5 });
  });

  it('Backspace/Delete 删除光标两侧字符并在边界 no-op', () => {
    assert.deepEqual(deleteBackwardAt('abc', 2), { text: 'ac', cursor: 1 });
    assert.deepEqual(deleteBackwardAt('abc', 0), { text: 'abc', cursor: 0 });
    assert.deepEqual(deleteForwardAt('abc', 1), { text: 'ac', cursor: 1 });
    assert.deepEqual(deleteForwardAt('abc', 3), { text: 'abc', cursor: 3 });
  });

  it('Ctrl+U/Ctrl+K 仅编辑当前逻辑行', () => {
    assert.deepEqual(deleteToLineStartAt('first\nsecond\nthird', 10), {
      text: 'first\nnd\nthird',
      cursor: 6,
    });
    assert.deepEqual(deleteToLineEndAt('first\nsecond\nthird', 8), {
      text: 'first\nsethird',
      cursor: 8,
    });
    assert.deepEqual(deleteToLineStartAt('first\nsecond', 6), { text: 'first\nsecond', cursor: 6 });
    assert.deepEqual(deleteToLineEndAt('first\nsecond', 12), { text: 'first\nsecond', cursor: 12 });
  });
});
