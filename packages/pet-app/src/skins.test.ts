// 单测 parseSkinEntryExtras:对 manifest 单个 pet 条目里 motionFile/quips 字段的宽容解析。
// 纯函数、无文件 I/O,覆盖各种合法/非法输入的容错行为。
// 运行:npx tsx packages/pet-app/src/skins.test.ts

import { parseSkinEntryExtras } from './skins.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

// 1) motionFile 是字符串 → 保留
{
  const r = parseSkinEntryExtras({ motionFile: 'a.svg' });
  assert(r.motionFile === 'a.svg', 'motionFile 为字符串时被保留');
}

// 2) motionFile 是非字符串类型(数字/布尔/对象)→ 不设置
{
  const r1 = parseSkinEntryExtras({ motionFile: 123 });
  const r2 = parseSkinEntryExtras({ motionFile: true });
  const r3 = parseSkinEntryExtras({ motionFile: { foo: 'bar' } });
  assert(r1.motionFile === undefined, 'motionFile 为数字时不设置该字段');
  assert(r2.motionFile === undefined, 'motionFile 为布尔时不设置该字段');
  assert(r3.motionFile === undefined, 'motionFile 为对象时不设置该字段');
}

// 3) motionFile 缺失 → undefined
{
  const r = parseSkinEntryExtras({});
  assert(r.motionFile === undefined, 'motionFile 缺失时为 undefined');
}

// 4) quips 是合法对象 → 保留
{
  const r = parseSkinEntryExtras({ quips: { tired: ['a', 'b'], bored: ['c'] } });
  assert(
    JSON.stringify(r.quips) === JSON.stringify({ tired: ['a', 'b'], bored: ['c'] }),
    'quips 为合法对象时按原样保留'
  );
}

// 5) quips 不是对象(字符串/数字/数组)→ 不设置
{
  const r1 = parseSkinEntryExtras({ quips: 'nope' });
  const r2 = parseSkinEntryExtras({ quips: 123 });
  const r3 = parseSkinEntryExtras({ quips: ['a', 'b'] });
  // 注意:数组本身 typeof 是 'object' 且不为 null,但其 key 均非法(index 的 value 不是 string[]),
  // 所以最终 quips 里没有任何合法 key,因而 result.quips 应为 undefined。
  assert(r1.quips === undefined, 'quips 为字符串时不设置该字段');
  assert(r2.quips === undefined, 'quips 为数字时不设置该字段');
  assert(r3.quips === undefined, 'quips 为数组(无合法 key)时不设置该字段');
}

// 6) quips 对象里某个 key 的 value 不是字符串数组 → 该 key 被跳过,其余合法 key 保留
{
  const r = parseSkinEntryExtras({ quips: { tired: 'not an array', bored: ['ok'] } });
  assert(r.quips !== undefined, 'quips 存在合法 key 时应设置该字段');
  assert(r.quips!.tired === undefined, '非法 key(tired)被跳过');
  assert(
    JSON.stringify(r.quips!.bored) === JSON.stringify(['ok']),
    '合法 key(bored)被保留'
  );
}

// 7) quips 数组混有非字符串元素 → 该 key 整体被跳过
{
  const r = parseSkinEntryExtras({ quips: { tired: ['ok', 123] } });
  assert(r.quips === undefined, '数组元素含非字符串时,该 key 被跳过,quips 无合法 key 因而为 undefined');
}

// 8) quips 是空对象 → 不设置
{
  const r = parseSkinEntryExtras({ quips: {} });
  assert(r.quips === undefined, 'quips 为空对象(无合法 key)时不设置该字段');
}

// 9) motionFile/quips 都缺失 → 正常返回 {}
{
  const r = parseSkinEntryExtras({ id: 'x', file: 'x.svg', name: 'X' });
  assert(r.motionFile === undefined, '其余字段解析不受影响时,motionFile 仍为 undefined');
  assert(r.quips === undefined, '其余字段解析不受影响时,quips 仍为 undefined');
  assert(Object.keys(r).length === 0, '两字段皆缺失时返回空对象 {}');
}

console.log(`\nOK: ${passed} passed, 0 failed`);
