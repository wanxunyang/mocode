import type { ShortPathTask } from './types.js';

/**
 * S1 micro:单文件小修。每个任务都是「读一眼就能改」的量级,
 * gold 路径 = read_file → edit_file(→ 可选跑一次 verifier),maxToolCalls = 3。
 * 初始状态必须无法通过 verifier,正确修改后必须通过。
 */
export const microTasks: ShortPathTask[] = [
  {
    id: 'micro-01',
    title: '重试次数常量类型错误',
    scenario: 'micro',
    level: 1,
    goal: 'config.js 里 MAX_RETRIES 的值是字符串,导致消费方算术运算出错。把它改成正确的数字类型。',
    files: [
      {
        path: 'config.js',
        content: `export const MAX_RETRIES = "3";
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { MAX_RETRIES } from './config.js';
assert.equal(typeof MAX_RETRIES, 'number', 'MAX_RETRIES must be a number');
assert.equal(MAX_RETRIES, 3);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['config.js'] },
  },
  {
    id: 'micro-02',
    title: '缺少命名导出',
    scenario: 'micro',
    level: 1,
    goal: 'index.js 从 format.js 导入 formatDate 但报错 SyntaxError,因为 formatDate 没有被导出。修复 format.js。',
    files: [
      {
        path: 'format.js',
        content: `function formatDate(date) {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}
`,
      },
      {
        path: 'index.js',
        content: `import { formatDate } from './format.js';
console.log(formatDate(new Date('2026-01-02T00:00:00Z')));
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
const mod = await import('./format.js');
assert.equal(typeof mod.formatDate, 'function', 'formatDate must be a named export');
assert.equal(mod.formatDate(new Date('2026-01-02T00:00:00Z')), '2026-01-02');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['format.js'] },
  },
  {
    id: 'micro-03',
    title: '闭区间求和少算一次',
    scenario: 'micro',
    level: 2,
    goal: 'sum.js 的 rangeSum(a, b) 应该对闭区间 [a, b] 求和,现在少算了 b。修复它。',
    files: [
      {
        path: 'sum.js',
        content: `export function rangeSum(a, b) {
  let total = 0;
  for (let i = a; i < b; i++) total += i;
  return total;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { rangeSum } from './sum.js';
assert.equal(rangeSum(1, 5), 15);
assert.equal(rangeSum(3, 3), 3);
assert.equal(rangeSum(0, 0), 0);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['sum.js'] },
  },
  {
    id: 'micro-04',
    title: '成年判定条件写反',
    scenario: 'micro',
    level: 2,
    goal: 'age.js 的 isAdult(age) 返回值和函数名语义相反(18 岁及以上算成年)。修复判断条件。',
    files: [
      {
        path: 'age.js',
        content: `export function isAdult(age) {
  return age < 18;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { isAdult } from './age.js';
assert.equal(isAdult(18), true);
assert.equal(isAdult(80), true);
assert.equal(isAdult(17), false);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['age.js'] },
  },
  {
    id: 'micro-05',
    title: '字段名拼写错误',
    scenario: 'micro',
    level: 1,
    goal: 'user.js 的 getUser() 返回对象里把 name 拼成了 nmae,消费方读不到 name。修复拼写。',
    files: [
      {
        path: 'user.js',
        content: `export function getUser() {
  return { id: 1, nmae: 'Ada' };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { getUser } from './user.js';
assert.equal(getUser().name, 'Ada');
assert.equal('nmae' in getUser(), false);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['user.js'] },
  },
  {
    id: 'micro-06',
    title: '默认参数丢失',
    scenario: 'micro',
    level: 1,
    goal: 'greet.js 的 greet() 不传参时应该输出 "Hello, there!",现在默认参数是空字符串。修复默认值。',
    files: [
      {
        path: 'greet.js',
        content: `export function greet(name = '') {
  return \`Hello, \${name}!\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { greet } from './greet.js';
assert.equal(greet(), 'Hello, there!');
assert.equal(greet('Ada'), 'Hello, Ada!');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['greet.js'] },
  },
  {
    id: 'micro-07',
    title: '排序方向反了',
    scenario: 'micro',
    level: 2,
    goal: 'sort.js 的 sortAscending(a, b) 应该升序排列,现在结果是降序。修复比较器。',
    files: [
      {
        path: 'sort.js',
        content: `export function sortAscending(numbers) {
  return [...numbers].sort((a, b) => b - a);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { sortAscending } from './sort.js';
assert.deepEqual(sortAscending([3, 1, 2]), [1, 2, 3]);
assert.deepEqual(sortAscending([]), []);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['sort.js'] },
  },
  {
    id: 'micro-08',
    title: 'slug 少了小写化',
    scenario: 'micro',
    level: 2,
    goal: 'slug.js 的 slugify() 生成的 slug 应该全小写,现在保留了大写字母。补上小写化。',
    files: [
      {
        path: 'slug.js',
        content: `export function slugify(text) {
  return text.trim().replace(/\\s+/g, '-');
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { slugify } from './slug.js';
assert.equal(slugify('Hello World'), 'hello-world');
assert.equal(slugify('  Ada  '), 'ada');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['slug.js'] },
  },
  {
    id: 'micro-09',
    title: '空数组缺空值保护',
    scenario: 'micro',
    level: 2,
    goal: 'items.js 的 firstId(items) 在空数组时应该返回 null,现在直接崩(TypeError)。补上空值保护。',
    files: [
      {
        path: 'items.js',
        content: `export function firstId(items) {
  return items[0].id;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { firstId } from './items.js';
assert.equal(firstId([]), null);
assert.equal(firstId([{ id: 7 }]), 7);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['items.js'] },
  },
  {
    id: 'micro-10',
    title: '上传上限要调到 8MB',
    scenario: 'micro',
    level: 1,
    goal: '产品要求上传上限从 4MB 调到 8MB。更新 limits.js 里的 MAX_UPLOAD_MB。',
    files: [
      {
        path: 'limits.js',
        content: `export const MAX_UPLOAD_MB = 4;
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { MAX_UPLOAD_MB } from './limits.js';
assert.equal(MAX_UPLOAD_MB, 8);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['limits.js'] },
  },
  {
    id: 'micro-11',
    title: '路径拼接丢了分隔符',
    scenario: 'micro',
    level: 1,
    goal: 'paths.js 的 joinPath(dir, file) 应该用 / 连接。dir 已以 / 结尾时直接拼接 file,避免重复分隔符。修复它。',
    files: [
      {
        path: 'paths.js',
        content: `export function joinPath(dir, file) {
  return dir + file;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { joinPath } from './paths.js';
assert.equal(joinPath('src', 'a.js'), 'src/a.js');
assert.equal(joinPath('src/', 'a.js'), 'src/a.js');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['paths.js'] },
  },
  {
    id: 'micro-12',
    title: 'has() 没返回布尔值',
    scenario: 'micro',
    level: 1,
    goal: 'has.js 的 contains(items, value) 应该返回 true/false,现在返回了元素本身。修复返回值。',
    files: [
      {
        path: 'has.js',
        content: `export function contains(items, value) {
  return items.find((item) => item === value);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { contains } from './has.js';
assert.equal(contains([1, 2], 1), true);
assert.equal(contains([1, 2], 9), false);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['has.js'] },
  },
  {
    id: 'micro-13',
    title: 'clamp 边界写反',
    scenario: 'micro',
    level: 2,
    goal: 'numeric.js 的 clamp(value, min, max) 应该把 value 限制在 [min, max] 区间,现在边界处理写反了。修复它。',
    files: [
      {
        path: 'numeric.js',
        content: `export function clamp(value, min, max) {
  return Math.min(min, Math.max(value, max));
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { clamp } from './numeric.js';
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-3, 0, 10), 0);
assert.equal(clamp(99, 0, 10), 10);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['numeric.js'] },
  },
  {
    id: 'micro-14',
    title: '少了一个 await',
    scenario: 'micro',
    level: 2,
    goal: 'config.js 的 resolveName() 返回 undefined,因为 loadConfig() 这个 Promise 没有 await。补上。',
    files: [
      {
        path: 'config.js',
        content: `export async function loadConfig() {
  return { name: 'app' };
}

export async function resolveName() {
  const config = loadConfig();
  return config.name;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { resolveName } from './config.js';
assert.equal(await resolveName(), 'app');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['config.js'] },
  },
  {
    id: 'micro-15',
    title: 'JSON 解析缺安全兜底',
    scenario: 'micro',
    level: 2,
    goal: 'parse.js 的 parseJsonSafe(text, fallback) 在非法 JSON 时应该返回 fallback,现在直接抛异常。补上兜底。',
    files: [
      {
        path: 'parse.js',
        content: `export function parseJsonSafe(text, fallback = null) {
  return JSON.parse(text);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { parseJsonSafe } from './parse.js';
assert.deepEqual(parseJsonSafe('{bad json', []), []);
assert.deepEqual(parseJsonSafe('{"a":1}'), { a: 1 });
assert.equal(parseJsonSafe('', null), null);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['parse.js'] },
  },
  {
    id: 'micro-16',
    title: '按 key 去重永远不生效',
    scenario: 'micro',
    level: 2,
    goal: 'dedupe.js 的 dedupeBy(items, key) 应该按 key 去重,但 Set.add 的返回值是 Set 本身(恒 truthy),过滤条件写错了。修复它。',
    files: [
      {
        path: 'dedupe.js',
        content: `export function dedupeBy(items, key) {
  const seen = new Set();
  return items.filter((item) => seen.add(item[key]));
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { dedupeBy } from './dedupe.js';
const items = [{ id: 1 }, { id: 1 }, { id: 2 }];
assert.equal(dedupeBy(items, 'id').length, 2);
assert.deepEqual(dedupeBy(items, 'id').map((item) => item.id), [1, 2]);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['dedupe.js'] },
  },
  {
    id: 'micro-17',
    title: '掩码尾部切错了方向',
    scenario: 'micro',
    level: 2,
    goal: 'mask.js 的 maskMiddle(text, visible = 2) 应该保留首尾各 visible 位、中间打码,现在尾部切片方向错了。修复它。',
    files: [
      {
        path: 'mask.js',
        content: `export function maskMiddle(text, visible = 2) {
  if (text.length <= visible * 2) return text;
  return \`\${text.slice(0, visible)}***\${text.slice(visible)}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { maskMiddle } from './mask.js';
assert.equal(maskMiddle('secretkey'), 'se***ey');
assert.equal(maskMiddle('secretkey', 3), 'sec***key');
assert.equal(maskMiddle('abc'), 'abc');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['mask.js'] },
  },
  {
    id: 'micro-18',
    title: '千分位分隔符位置错',
    scenario: 'micro',
    level: 2,
    goal: 'format.js 的 formatThousand(n) 应该输出千分位逗号格式(如 1234567 → "1,234,567"),现在的正则替换位置不对。修复它。',
    files: [
      {
        path: 'format.js',
        content: `export function formatThousand(n) {
  return String(n).replace(/(\\d{3})/g, '$1,');
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { formatThousand } from './format.js';
assert.equal(formatThousand(1234567), '1,234,567');
assert.equal(formatThousand(123), '123');
assert.equal(formatThousand(1000000), '1,000,000');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['format.js'] },
  },
  {
    id: 'micro-19',
    title: 'kebab 转 camel 只处理了一处',
    scenario: 'micro',
    level: 2,
    goal: 'case.js 的 kebabToCamel(text) 应该把 kebab-case 完整转成 camelCase(如 foo-bar-baz → fooBarBaz),现在只删了第一个连字符且没驼峰化。修复它。',
    files: [
      {
        path: 'case.js',
        content: `export function kebabToCamel(text) {
  return text.replace('-', '');
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { kebabToCamel } from './case.js';
assert.equal(kebabToCamel('foo-bar'), 'fooBar');
assert.equal(kebabToCamel('foo-bar-baz'), 'fooBarBaz');
assert.equal(kebabToCamel('solo'), 'solo');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['case.js'] },
  },
  {
    id: 'micro-20',
    title: '时钟显示缺补零',
    scenario: 'micro',
    level: 1,
    goal: 'clock.js 的 formatClock(minutes) 应该输出 "HH:MM" 补零格式(如 75 → "01:15"),现在小时和分钟都没补零。修复它。',
    files: [
      {
        path: 'clock.js',
        content: `export function formatClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return \`\${h}:\${m}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { formatClock } from './clock.js';
assert.equal(formatClock(75), '01:15');
assert.equal(formatClock(600), '10:00');
assert.equal(formatClock(0), '00:00');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['clock.js'] },
  },
  {
    id: 'micro-21',
    title: '遗留调试输出',
    level: 1,
    scenario: 'micro',
    goal: 'logger.js 的 compute() 里遗留了一行调试 console.log,生产环境不该有。删掉调试输出,函数行为不变。',
    files: [
      {
        path: 'logger.js',
        content: `export function compute(n) {
  console.log('DEBUG compute called with', n);
  return n * 2;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { compute } from './logger.js';
const logs = [];
const orig = console.log;
console.log = (...args) => logs.push(args.join(' '));
try {
  assert.equal(compute(2), 4);
  assert.equal(compute(0), 0);
} finally {
  console.log = orig;
}
assert.equal(logs.length, 0, \`expected no debug output, got: \${JSON.stringify(logs)}\`);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['logger.js'] },
  },
  {
    id: 'micro-22',
    title: 'var 声明风格修复',
    level: 1,
    scenario: 'micro',
    goal: 'legacy.js 用了 var 声明,项目规范要求统一 const/let。把所有 var 换掉,行为保持不变。',
    files: [
      {
        path: 'legacy.js',
        content: `export function counter() {
  var count = 0;
  var step = 1;
  count = count + step;
  return count;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { counter } from './legacy.js';
assert.equal(counter(), 1);
const src = readFileSync(new URL('./legacy.js', import.meta.url), 'utf8');
assert.equal(/\\bvar\\b/.test(src), false, 'var declarations are not allowed');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['legacy.js'] },
  },
  {
    id: 'micro-23',
    title: '错误文案拼写错误',
    level: 1,
    scenario: 'micro',
    goal: 'users.js 的 findUser() 抛出的错误文案把 User 拼成了 Usre。修正拼写,消息格式保持 "User not found: <id>"。',
    files: [
      {
        path: 'users.js',
        content: `export function findUser(id) {
  if (id !== 1) {
    throw new Error(\`Usre not found: \${id}\`);
  }
  return { id: 1, name: 'Ada' };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { findUser } from './users.js';
assert.deepEqual(findUser(1), { id: 1, name: 'Ada' });
assert.throws(() => findUser(2), /User not found: 2/);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['users.js'] },
  },
  {
    id: 'micro-24',
    title: '导出函数名拼写错误',
    level: 1,
    scenario: 'micro',
    goal: 'profile.js 把导出函数命名为 getUsre(拼错了),消费方按 getUser 导入直接报错。把函数改名为 getUser,行为不变。',
    files: [
      {
        path: 'profile.js',
        content: `export function getUsre(id) {
  return { id, name: 'Ada' };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { getUser } from './profile.js';
assert.deepEqual(getUser(1), { id: 1, name: 'Ada' });
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['profile.js'] },
  },
];
