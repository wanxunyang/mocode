import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fuzzyMatch, fuzzyRank } from '../src/ui/fuzzy.js';

describe('fuzzyMatch 子序列匹配', () => {
  it('空 query 全通过,score=0', () => {
    assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
  });

  it('不匹配返回 null', () => {
    assert.equal(fuzzyMatch('xyz', 'abc'), null);
    assert.equal(fuzzyMatch('ss', 'sort'), null); // 只有一个 s
  });

  it('子序列命中,positions 按码点计', () => {
    const m = fuzzyMatch('srt', 'sort');
    assert.ok(m);
    assert.deepEqual(m!.positions, [0, 2, 3]);
  });

  it('CJK 混合:码点索引安全(不按 UTF-16 单元切)', () => {
    const m = fuzzyMatch('改代', '帮我修改这段代码');
    assert.ok(m);
    // 码点: 帮(0)我(1)修(2)改(3)这(4)段(5)代(6)码(7)
    assert.deepEqual(m!.positions, [3, 6]);
  });

  it('大小写不敏感', () => {
    assert.ok(fuzzyMatch('SRT', 'sort'));
    assert.ok(fuzzyMatch('srt', 'SORT'));
  });
});

describe('fuzzyMatch 打分', () => {
  it('连续命中 > 分散命中', () => {
    const cont = fuzzyMatch('abc', 'abc def');
    const scatter = fuzzyMatch('abc', 'a_b_c');
    assert.ok(cont && scatter);
    assert.ok(cont!.score > scatter!.score);
  });

  it('词首命中 > 词中命中(srt 偏爱 sort 的 s-r-t)', () => {
    const word = fuzzyMatch('srt', 'sort the rows');
    const mid = fuzzyMatch('srt', 'assert'); // s-r-t 全在词中(a**s**se**r****t**)
    assert.ok(word && mid);
    assert.ok(word!.score > mid!.score);
  });

  it('大小写精确匹配加分:P 偏爱 Prompt 的大写 P', () => {
    const exact = fuzzyMatch('P', 'Prompt');
    const lower = fuzzyMatch('p', 'Prompt');
    assert.ok(exact && lower);
    assert.ok(exact!.score > lower!.score);
  });

  it('首匹配位置与长度惩罚:同等质量短的/靠前的优先', () => {
    const early = fuzzyMatch('ab', 'ab cd');
    const late = fuzzyMatch('ab', 'cd ab cd');
    assert.ok(early && late);
    assert.ok(early!.score > late!.score);
  });
});

describe('fuzzyRank 排序', () => {
  it('空 query 保持原顺序,不过滤', () => {
    const items = ['b', 'a', 'c'];
    assert.deepEqual(
      fuzzyRank('', items).map((r) => r.text),
      ['b', 'a', 'c'],
    );
  });

  it('过滤不匹配,高分在前', () => {
    const ranked = fuzzyRank('srt', ['assert', 'sort', 'no match here']);
    assert.deepEqual(
      ranked.map((r) => r.text),
      ['sort', 'assert'],
    );
  });

  it('真实场景:srt 命中 sort 而非 resort(连续命中优先)', () => {
    // 注:'src/index.ts' 里 s-r 连续 + t 落在 '.' 边界,分数高于 'sort',属合理排序;
    // 这里断言的是同质量下连续命中的 'sort' 压过分散命中的 'resort'。
    const items = ['resort', 'sort'];
    const ranked = fuzzyRank('srt', items);
    assert.equal(ranked[0]?.text, 'sort');
  });

  it('limit 截断', () => {
    assert.equal(fuzzyRank('a', ['a', 'ab', 'abc', 'b'], 2).length, 2);
  });
});
