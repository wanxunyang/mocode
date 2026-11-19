import type { ShortPathTask } from './types.js';

/**
 * S3 warm:两段式会话。第一轮(warmupGoal)让 agent 真实阅读代码建立上下文,不计分;
 * 第二轮(goal)在同一段 history 上追加一个小改动任务,计分。
 * gold 前提:第二轮上下文已就绪,合理路径是「直接 edit(→ verify)」,maxToolCalls = 3。
 * 测的是:上下文已经存在,agent 还要不要重新把文件读一遍甚至全树探索。
 * 预热轮发生任何 mutation 都判失败(预热必须只读)。
 */
export const warmTasks: ShortPathTask[] = [
  {
    id: 'warm-01',
    title: '购物车货币单位切换',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '阅读 src/cart.js,搞清楚小计(subtotal)和货币单位是怎么输出的,然后告诉我当前用的货币符号是什么。不要修改任何文件。',
    goal: '把 src/cart.js 输出货币时用的 "USD" 全部改成 "CNY",其他逻辑不变。',
    files: [
      {
        path: 'src/cart.js',
        content: `const RATES = { apple: 3.5, banana: 2, cherry: 12 };

export function subtotal(items) {
  return items.reduce((sum, item) => sum + RATES[item.name] * item.qty, 0);
}

export function formatMoney(amount) {
  return \`USD \${amount.toFixed(2)}\`;
}

export function receipt(items) {
  return \`total: \${formatMoney(subtotal(items))}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { receipt, subtotal } from './src/cart.js';
assert.equal(subtotal([{ name: 'apple', qty: 2 }]), 7);
assert.equal(receipt([{ name: 'apple', qty: 2 }]), 'total: CNY 7.00');
assert.equal(receipt([{ name: 'banana', qty: 1 }]).includes('USD'), false);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/cart.js'] },
  },
  {
    id: 'warm-02',
    title: '问候语默认称呼更换',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/greet.js 和 src/farewell.js,说明这两个模块各自在不传名字时的默认称呼。不要修改任何文件。',
    goal: '把 src/greet.js 里 greet() 的默认称呼从 "guest" 换成 "friend",farewell.js 保持不变。',
    files: [
      {
        path: 'src/greet.js',
        content: `export function greet(name = 'guest') {
  return \`Welcome, \${name}!\`;
}
`,
      },
      {
        path: 'src/farewell.js',
        content: `export function farewell(name = 'stranger') {
  return \`Goodbye, \${name}!\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { greet } from './src/greet.js';
import { farewell } from './src/farewell.js';
assert.equal(greet(), 'Welcome, friend!');
assert.equal(greet('Ada'), 'Welcome, Ada!');
assert.equal(farewell(), 'Goodbye, stranger!');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/greet.js'] },
  },
  {
    id: 'warm-03',
    title: 'slug 分隔符更换',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/slug.js,告诉我 slugify() 用什么字符连接单词、会做哪些归一化。不要修改任何文件。',
    goal: 'src/slug.js 的 slugify() 分隔符从 "-" 换成 "_",归一化逻辑保持不变。',
    files: [
      {
        path: 'src/slug.js',
        content: `export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/\\s+/g, '-');
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { slugify } from './src/slug.js';
assert.equal(slugify('Hello World'), 'hello_world');
assert.equal(slugify('  Ada  Lovelace '), 'ada_lovelace');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/slug.js'] },
  },
  {
    id: 'warm-04',
    title: '购物车上限调整',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/inventory.js,搞清楚购物车最多允许放几件商品、超限时抛什么错。不要修改任何文件。',
    goal: '把 src/inventory.js 的购物车上限从 10 件调整到 20 件,超限错误类型保持不变。',
    files: [
      {
        path: 'src/inventory.js',
        content: `export const MAX_ITEMS = 10;

export function assertCapacity(count) {
  if (count > MAX_ITEMS) {
    throw new RangeError(\`cart holds at most \${MAX_ITEMS} items\`);
  }
  return true;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { assertCapacity, MAX_ITEMS } from './src/inventory.js';
assert.equal(MAX_ITEMS, 20);
assert.equal(assertCapacity(20), true);
assert.throws(() => assertCapacity(21), RangeError);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/inventory.js'] },
  },
  {
    id: 'warm-05',
    title: '榜单排序方向切换',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/leaderboard.js,说明 topScores() 现在按什么方向排序、返回前几名。不要修改任何文件。',
    goal: 'src/leaderboard.js 的 topScores() 改为升序返回(分数低的在前),仍然只返回前 3 名。',
    files: [
      {
        path: 'src/leaderboard.js',
        content: `export function topScores(scores) {
  return [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { topScores } from './src/leaderboard.js';
const input = [{ name: 'a', score: 5 }, { name: 'b', score: 1 }, { name: 'c', score: 9 }, { name: 'd', score: 3 }];
assert.deepEqual(topScores(input), [
  { name: 'b', score: 1 },
  { name: 'd', score: 3 },
  { name: 'a', score: 5 },
]);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/leaderboard.js'] },
  },
  {
    id: 'warm-06',
    title: '日志日期格式切换',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/logger.js,说明 timestamp() 当前输出的日期格式是什么。不要修改任何文件。',
    goal: '把 src/logger.js 的 timestamp() 输出格式从 ISO 的 "YYYY-MM-DD" 换成 "YYYY/MM/DD",其余不变。',
    files: [
      {
        path: 'src/logger.js',
        content: `export function timestamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function logLine(message, date = new Date()) {
  return \`[\${timestamp(date)}] \${message}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { logLine, timestamp } from './src/logger.js';
const d = new Date('2026-03-09T12:00:00Z');
assert.equal(timestamp(d), '2026/03/09');
assert.equal(logLine('boot', d), '[2026/03/09] boot');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/logger.js'] },
  },
  {
    id: 'warm-07',
    title: '统计函数别名导出',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/stats.js,列出它导出的所有函数和各自的作用。不要修改任何文件。',
    goal: 'src/stats.js 新增导出别名 average = mean(保持 mean 本身导出不变),供新消费方渐进迁移。',
    files: [
      {
        path: 'src/stats.js',
        content: `export function mean(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

export function max(numbers) {
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import * as stats from './src/stats.js';
assert.equal(typeof stats.mean, 'function');
assert.equal(typeof stats.average, 'function', 'average alias must be exported');
assert.equal(stats.average, stats.mean);
assert.equal(stats.average([2, 4]), 3);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/stats.js'] },
  },
  {
    id: 'warm-08',
    title: '密码强度阈值放宽',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/password.js,搞清楚 strength() 的打分规则和 "strong" 的判定阈值。不要修改任何文件。',
    goal: 'src/password.js 里判定 "strong" 的最小长度从 12 放宽到 10,打分规则本身不变。',
    files: [
      {
        path: 'src/password.js',
        content: `export function strength(password) {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (password.length >= 12) score += 1;
  if (score >= 4) return 'strong';
  if (score >= 2) return 'medium';
  return 'weak';
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { strength } from './src/password.js';
assert.equal(strength('abcdefgh1!'), 'strong', '10 chars with 3 rule points must be strong');
assert.equal(strength('Ab1!abcdefgh'), 'strong', '12 chars meeting all rules must stay strong');
assert.equal(strength('Ab1!aaa'), 'medium');
assert.equal(strength('abc'), 'weak');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/password.js'] },
  },
  {
    id: 'warm-09',
    title: '税率调整(带干扰文件)',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '阅读 src/tax.js 和 src/shipping.js,说明各自由哪个常量控制费率、两个费率分别用在哪里。不要修改任何文件。',
    goal: '把 src/tax.js 的税率常量从 0.1 调整为 0.08。src/shipping.js 保持不变。',
    files: [
      {
        path: 'src/tax.js',
        content: `export const TAX_RATE = 0.1;

export function withTax(amount) {
  return Math.round(amount * (1 + TAX_RATE) * 100) / 100;
}
`,
      },
      {
        path: 'src/shipping.js',
        content: `export const SHIPPING_RATE = 0.05;

export function withShipping(amount) {
  return Math.round(amount * (1 + SHIPPING_RATE) * 100) / 100;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { TAX_RATE, withTax } from './src/tax.js';
import { SHIPPING_RATE, withShipping } from './src/shipping.js';
assert.equal(TAX_RATE, 0.08);
assert.equal(withTax(100), 108);
assert.equal(SHIPPING_RATE, 0.05, 'shipping must stay unchanged');
assert.equal(withShipping(100), 105);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/tax.js'] },
  },
  {
    id: 'warm-10',
    title: '币种符号查找加兜底',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '追一下 src/index.js → src/price.js → src/currency.js 的调用链,说明价格格式化时币种符号是从哪来的、未知币种会发生什么。不要修改任何文件。',
    goal: '给 src/currency.js 的 symbolFor(code) 增加第二个可选参数 fallback(默认 "$"):未知币种时返回 fallback 而不是抛错。已知币种行为不变。',
    files: [
      {
        path: 'src/currency.js',
        content: `const SYMBOLS = { USD: '$', EUR: '€', CNY: '¥' };

export function symbolFor(code) {
  if (!(code in SYMBOLS)) {
    throw new Error(\`unknown currency: \${code}\`);
  }
  return SYMBOLS[code];
}
`,
      },
      {
        path: 'src/price.js',
        content: `import { symbolFor } from './currency.js';
export function formatPrice(amount, code) {
  return \`\${symbolFor(code)}\${amount.toFixed(2)}\`;
}
`,
      },
      {
        path: 'src/index.js',
        content: `import { formatPrice } from './price.js';
export function checkoutLine(amount, code) {
  return \`pay \${formatPrice(amount, code)}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { symbolFor } from './src/currency.js';
assert.equal(symbolFor('USD'), '$');
assert.equal(symbolFor('EUR'), '€');
assert.equal(symbolFor('XYZ'), '$', 'unknown code falls back to $');
assert.equal(symbolFor('XYZ', '¤'), '¤', 'explicit fallback wins');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/currency.js'] },
  },
  {
    id: 'warm-11',
    title: '宽松解析的空串语义',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '阅读 src/strict.js 和 src/lenient.js,对比两个解析器对合法输入、空串、非法输入分别返回什么。不要修改任何文件。',
    goal: 'src/lenient.js 的 lenientParse("") 目前返回 null,改成返回 0;其他行为(合法输入取数值、非法输入返回 null)保持不变。',
    files: [
      {
        path: 'src/strict.js',
        content: `export function strictParse(text) {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new TypeError(\`not a number: \${text}\`);
  }
  return value;
}
`,
      },
      {
        path: 'src/lenient.js',
        content: `export function lenientParse(text) {
  if (text === '') {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { lenientParse } from './src/lenient.js';
import { strictParse } from './src/strict.js';
assert.equal(lenientParse(''), 0);
assert.equal(lenientParse('42'), 42);
assert.equal(lenientParse('abc'), null);
assert.throws(() => strictParse('abc'), TypeError, 'strict parser must stay strict');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/lenient.js'] },
  },
  {
    id: 'warm-12',
    title: '百分比整数除法归零',
    scenario: 'warm',
    level: 4,
    warmupGoal: 'src/rate.js 的 percent(part, total) 对 percent(1, 3) 返回 0。只解释原因,不要修改任何文件。',
    goal: '修复 src/rate.js 的 percent(part, total):返回四舍五入到两位小数的百分比数值,percent(1, 3) 应为 33.33,percent(1, 2) 应为 50。total 为 0 时返回 0。',
    files: [
      {
        path: 'src/rate.js',
        content: `export function percent(part, total) {
  if (total === 0) return 0;
  return (part / total) * 100;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { percent } from './src/rate.js';
assert.equal(percent(1, 3), 33.33);
assert.equal(percent(1, 2), 50);
assert.equal(percent(0, 10), 0);
assert.equal(percent(5, 0), 0);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/rate.js'] },
  },
  {
    id: 'warm-13',
    title: '按测试补实现(防作弊布局)',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '阅读 verify-palette.test.mjs,列出它对 src/palette.js 的全部期望,并指出当前哪几条会失败。不要修改任何文件。',
    goal: '只修改 src/palette.js,让 verify-palette.test.mjs 全部通过。不要修改测试文件本身。',
    files: [
      {
        path: 'src/palette.js',
        content: `export function tone(kind) {
  const tones = { info: '#3b82f6', success: '#22c55e' };
  return tones[kind] ?? tones.info;
}

export function allTones() {
  return ['info', 'success'];
}
`,
      },
      {
        path: 'verify-palette.test.mjs',
        content: `import assert from 'node:assert/strict';
import { tone, allTones } from './src/palette.js';
assert.equal(tone('info'), '#3b82f6');
assert.equal(tone('success'), '#22c55e');
assert.equal(tone('warn'), '#f59e0b', 'warn tone must exist');
assert.equal(tone('unknown'), '#3b82f6', 'unknown kinds fall back to info');
assert.deepEqual(allTones(), ['info', 'success', 'warn']);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify-palette.test.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/palette.js'] },
  },
  {
    id: 'warm-14',
    title: '配置 schema 增加新键',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '阅读 src/config.js,说明 DEFAULTS 有哪些键、validate() 对未知键和错误类型分别怎么处理。不要修改任何文件。',
    goal: '给 src/config.js 的 DEFAULTS 增加 timeoutMs: 5000,并让 validate() 接受这个新键(必须是非负有限数字,否则抛 TypeError)。既有键的校验行为不变。',
    files: [
      {
        path: 'src/config.js',
        content: `export const DEFAULTS = { retries: 3, verbose: false };

const NUMBER_KEYS = new Set(['retries']);
const BOOLEAN_KEYS = new Set(['verbose']);

export function validate(config) {
  for (const [key, value] of Object.entries(config)) {
    if (!NUMBER_KEYS.has(key) && !BOOLEAN_KEYS.has(key)) {
      throw new TypeError(\`unknown config key: \${key}\`);
    }
    if (NUMBER_KEYS.has(key) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new TypeError(\`\${key} must be a finite number\`);
    }
    if (BOOLEAN_KEYS.has(key) && typeof value !== 'boolean') {
      throw new TypeError(\`\${key} must be a boolean\`);
    }
  }
  return true;
}

export function defaults() {
  return { ...DEFAULTS };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { DEFAULTS, defaults, validate } from './src/config.js';
assert.equal(DEFAULTS.timeoutMs, 5000);
assert.equal(defaults().timeoutMs, 5000);
assert.equal(validate({ timeoutMs: 3000 }), true);
assert.throws(() => validate({ timeoutMs: 'soon' }), TypeError);
assert.throws(() => validate({ timeoutMs: -1 }), TypeError);
assert.equal(validate({ retries: 2 }), true, 'existing keys must keep validating');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/config.js'] },
  },
  {
    id: 'warm-15',
    title: '错误文案更新',
    scenario: 'warm',
    level: 4,
    warmupGoal:
      '阅读 src/errors.js,列出全部错误码和对应文案,说明 messageFor() 对未知错误码返回什么。不要修改任何文件。',
    goal: "把 src/errors.js 里 'TIMEOUT' 的文案从 'Request timed out' 改成 'Request timed out after 30s',其他错误码不变,未知错误码行为不变。",
    files: [
      {
        path: 'src/errors.js',
        content: `const MESSAGES = {
  TIMEOUT: 'Request timed out',
  NETWORK: 'Network unreachable',
  AUTH: 'Authentication failed',
};

export function messageFor(code) {
  return MESSAGES[code] ?? 'Unknown error';
}

export function codes() {
  return Object.keys(MESSAGES);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { codes, messageFor } from './src/errors.js';
assert.equal(messageFor('TIMEOUT'), 'Request timed out after 30s');
assert.equal(messageFor('NETWORK'), 'Network unreachable');
assert.equal(messageFor('WHATEVER'), 'Unknown error');
assert.deepEqual(codes(), ['TIMEOUT', 'NETWORK', 'AUTH']);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/errors.js'] },
  },
  {
    id: 'warm-16',
    title: '状态机新增取消态',
    scenario: 'warm',
    level: 4,
    warmupGoal: '阅读 src/status.js,列出全部状态值和 isTerminal() 的判断逻辑。不要修改任何文件。',
    goal: "给 src/status.js 新增状态 CANCELED: 'canceled',并让 isTerminal() 把 'canceled' 也视为终态。既有状态与判断不变。",
    files: [
      {
        path: 'src/status.js',
        content: `export const STATUS = {
  TODO: 'todo',
  DOING: 'doing',
  DONE: 'done',
};

const TERMINAL = new Set([STATUS.DONE]);

export function isTerminal(status) {
  return TERMINAL.has(status);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { STATUS, isTerminal } from './src/status.js';
assert.equal(STATUS.CANCELED, 'canceled');
assert.equal(isTerminal('canceled'), true);
assert.equal(isTerminal('done'), true);
assert.equal(isTerminal('doing'), false);
assert.equal(isTerminal('todo'), false);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 3 },
    expected: { files: ['src/status.js'] },
  },
];
