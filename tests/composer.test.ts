import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  wrapLogicalLine,
  wrapAll,
  normSel,
  spanText,
  deleteSpan,
  posCmp,
} from '../src/ui/composer.js';

describe('composer 软换行', () => {
  it('词边界回退:断在空格后,空格留在上一行', () => {
    const rows = wrapLogicalLine('aaa bbb ccc', 7);
    assert.deepEqual(rows.map((r) => r.text), ['aaa ', 'bbb ccc']);
    assert.deepEqual(rows.map((r) => r.start), [0, 4]);
  });

  it('无空格(中文)按字符断', () => {
    const rows = wrapLogicalLine('一二三四五', 4); // 中文宽 2 → 每行 2 字
    assert.deepEqual(rows.map((r) => r.text), ['一二', '三四', '五']);
  });

  it('空行产出一条空展示行', () => {
    assert.deepEqual(wrapLogicalLine('', 10), [{ li: -1, start: 0, text: '' }]);
  });

  it('单行装得下:不拆', () => {
    assert.deepEqual(wrapLogicalLine('hello', 10).map((r) => r.text), ['hello']);
  });

  it('wrapAll 保留 logical 行号', () => {
    const rows = wrapAll(['ab cd', 'x'], 2);
    // 行0: 'ab' 'cd'? width2: 'ab '(3>2 不行)→ 'ab','cd'? 逐字:a b (2) c→溢出,breakAfter=3? 
    // 实际: 'ab','cd' 若空格断行生效;若退化 'ab',' c','d' 也合法——只断言行号单调。
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      assert.ok(
        cur.li > prev.li || (cur.li === prev.li && cur.start > prev.start),
        `rows 必须按 (li,start) 递增`,
      );
    }
    const last = rows[rows.length - 1];
    assert.equal(last?.li, 1);
  });
});

describe('composer 选区', () => {
  const lines = ['hello world', 'second line', 'third'];

  it('normSel:anchor 在前/在后都归一化,相等为 null', () => {
    assert.deepEqual(normSel({ line: 0, col: 2 }, { line: 1, col: 3 }), {
      sl: 0,
      sc: 2,
      el: 1,
      ec: 3,
    });
    assert.deepEqual(normSel({ line: 1, col: 3 }, { line: 0, col: 2 }), {
      sl: 0,
      sc: 2,
      el: 1,
      ec: 3,
    });
    assert.equal(normSel({ line: 0, col: 2 }, { line: 0, col: 2 }), null);
  });

  it('spanText:单行 / 跨行 / 到行尾', () => {
    assert.equal(spanText(lines, { sl: 0, sc: 6, el: 0, ec: 11 }), 'world');
    assert.equal(spanText(lines, { sl: 0, sc: 6, el: 2, ec: 3 }), 'world\nsecond line\nthi');
  });

  it('deleteSpan:单行删除', () => {
    const l = [...lines];
    const cur = deleteSpan(l, { sl: 0, sc: 5, el: 0, ec: 11 });
    assert.equal(l[0], 'hello');
    assert.deepEqual(cur, { line: 0, col: 5 });
  });

  it('deleteSpan:跨行折叠', () => {
    const l = [...lines];
    const cur = deleteSpan(l, { sl: 0, sc: 6, el: 2, ec: 3 });
    // 'hello ' + 'third'去掉前3字符('thi')→ 'rd'
    assert.deepEqual(l, ['hello rd']);
    assert.deepEqual(cur, { line: 0, col: 6 });
  });

  it('posCmp 行优先', () => {
    assert.ok(posCmp({ line: 0, col: 99 }, { line: 1, col: 0 }) < 0);
    assert.equal(posCmp({ line: 1, col: 3 }, { line: 1, col: 3 }), 0);
  });
});
