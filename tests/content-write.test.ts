import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as content from '../src/ui/content.js';

const RESET = '\x1B[0m';
const row = (text: string): string => `${text}${RESET}`;
const snapshot = (): string[] => content.sliceFromEnd(0, content.totalRows());

afterEach(() => content.reset());

describe('content 中段物理行编辑', () => {
  it('insertAfter/deleteFrom 保持物理行数、绝对映射和当前待写行一致', () => {
    content.feedChar('alpha');
    content.breakRow();
    content.feedChar('beta');
    content.breakRow();
    content.feedChar('tail-current');

    const currentBefore = content.currentRowRaw();
    content.insertAfter(0, [row('inserted-1'), row('inserted-2')]);

    assert.equal(snapshot().length, content.totalRows());
    assert.equal(content.committedRows(), 4);
    assert.equal(content.totalRows(), 5);
    assert.equal(content.currentRowRaw(), currentBefore);
    assert.deepEqual(snapshot(), [
      row('alpha'),
      row('inserted-1'),
      row('inserted-2'),
      row('beta'),
      row('tail-current'),
    ]);
    for (let index = 0; index < content.totalRows(); index++) {
      assert.equal(content.lineAt(index), snapshot()[index], `lineAt(${index}) 应与物理缓冲映射一致`);
    }

    content.deleteFrom(1, 2);

    assert.equal(snapshot().length, content.totalRows());
    assert.equal(content.committedRows(), 2);
    assert.equal(content.totalRows(), 3);
    assert.equal(content.currentRowRaw(), currentBefore);
    assert.deepEqual(snapshot(), [row('alpha'), row('beta'), row('tail-current')]);
  });

  it('边界插入与越尾删除只影响实际命中的已提交行', () => {
    content.feedChar('middle');
    content.breakRow();
    content.feedChar('current');

    content.insertAfter(-1, [row('before')]);
    content.insertAfter(999, [row('after')]);
    assert.deepEqual(snapshot(), [row('before'), row('middle'), row('after'), row('current')]);

    content.deleteFrom(1, 99);
    assert.equal(content.committedRows(), 1);
    assert.equal(content.currentRowRaw(), 'current');
    assert.deepEqual(snapshot(), [row('before'), row('current')]);
  });
});
