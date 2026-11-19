import type { ShortPathTask } from './types.js';

/** L6 多文件功能开发(后 8 题),规格约定同 fixtures-l6a.ts。 */
export const l6TasksB: ShortPathTask[] = [
  {
    id: 'l6-09',
    title: '滑动窗口限流器',
    level: 6,
    scenario: 'hinted',
    goal: `src/client.js 的 send() 需要上游限流保护。新增 src/rate-limit.js,导出 createRateLimiter({ max, windowMs, now = () => Date.now() }):
返回 { allow() }——滑动窗口语义:窗口内放行数不超过 max(窗口以每次 allow 的当前时间动态前移);超限返回 false 且不影响已放行额度。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/client.js',
        content: `let sent = 0;

export function send(payload) {
  sent += 1;
  return { payload, sent };
}

export function sentCount() {
  return sent;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createRateLimiter } from './src/rate-limit.js';
let t = 1000;
const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
assert.equal(limiter.allow(), true);
assert.equal(limiter.allow(), true);
assert.equal(limiter.allow(), true);
assert.equal(limiter.allow(), false, '4th call inside the window must be rejected');
t = 1500;
assert.equal(limiter.allow(), false, 'sliding window still counts earlier admits');
t = 2100;
assert.equal(limiter.allow(), true, 'first admit falls out of the window');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-10',
    title: '表格渲染',
    level: 6,
    scenario: 'hinted',
    goal: `src/data.js 提供订单样例数据。新增 src/table.js,导出 renderTable(rows, columns):
columns 形如 [{ key, title }];输出首行为表头(title),数据行按 key 取值;每列宽度 = 该列所有单元格的最大显示宽度,左对齐,单元格间以 " | " 分隔;不含行尾分隔符。数字列右对齐不算(统一左对齐,保持简单)。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/data.js',
        content: `export const ORDERS = [
  { id: 1, item: 'apple', qty: 3 },
  { id: 22, item: 'banana', qty: 12 },
  { id: 7, item: 'cherry', qty: 130 },
];

export const ORDER_COLUMNS = [
  { key: 'id', title: 'ID' },
  { key: 'item', title: 'Item' },
  { key: 'qty', title: 'Qty' },
];
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { renderTable } from './src/table.js';
import { ORDERS, ORDER_COLUMNS } from './src/data.js';
const out = renderTable(ORDERS, ORDER_COLUMNS);
const lines = out.split('\\n');
assert.equal(lines.length, 4, 'header + 3 rows');
assert.equal(lines[0], 'ID | Item   | Qty');
assert.equal(lines[1], '1  | apple  | 3');
assert.equal(lines[2], '22 | banana | 12');
assert.equal(lines[3], '7  | cherry | 130');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-11',
    title: '四则运算求值器',
    level: 6,
    scenario: 'hinted',
    goal: `src/tokenizer.js 能把表达式拆成 token 数组。新增 src/evaluate.js,导出 evaluate(expr):
支持 + - * / 与括号、正整数运算,遵循优先级(* / 高于 + -),除法结果向下取整;非法字符抛 SyntaxError。可以重组 tokenizer 的输出,也可以独立实现,但 src/tokenizer.js 不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/tokenizer.js',
        content: `const TOKEN_RE = /\\d+|[()+\\-*/]/g;

export function tokenize(expr) {
  return expr.match(TOKEN_RE) ?? [];
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { evaluate } from './src/evaluate.js';
assert.equal(evaluate('1 + 2 * 3'), 7);
assert.equal(evaluate('(1 + 2) * 3'), 9);
assert.equal(evaluate('10 / 3'), 3);
assert.equal(evaluate('2 * (3 + 4) - 5'), 9);
assert.throws(() => evaluate('2 & 3'), SyntaxError);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-12',
    title: '状态机守卫',
    level: 6,
    scenario: 'hinted',
    goal: `src/transitions.js 声明了订单状态的合法迁移表。新增 src/machine.js,导出 createMachine(initial):
返回 { state(), can(event), fire(event) }——迁移表形如 { state: { event: next } };can 报告当前状态下该事件是否合法;fire 执行迁移并返回新状态,非法迁移抛 Error 且状态不变。迁移表不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/transitions.js',
        content: `export const TRANSITIONS = {
  draft: { submit: 'review', cancel: 'canceled' },
  review: { approve: 'done', reject: 'draft' },
  done: {},
  canceled: {},
};
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createMachine } from './src/machine.js';
const m = createMachine('draft');
assert.equal(m.state(), 'draft');
assert.equal(m.can('submit'), true);
assert.equal(m.can('approve'), false);
assert.equal(m.fire('submit'), 'review');
assert.equal(m.state(), 'review');
assert.equal(m.fire('reject'), 'draft');
assert.equal(m.fire('cancel'), 'canceled');
assert.throws(() => m.fire('submit'), Error);
assert.equal(m.state(), 'canceled', 'state must not change on illegal event');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-13',
    title: 'DI 容器单例域',
    level: 6,
    scenario: 'hinted',
    goal: `src/container.js 有 register/get 基础能力(每次 get 都重新构造)。
扩展它支持单例域:新增 singleton(name, factory) 注册(实例懒构造),同一 name 的 get 返回同一实例;既有 register/get 行为不变。可以修改 src/container.js 本体,也可以新增模块,但导出面必须保持:register/get/singleton 都从 src/container.js 导出。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/container.js',
        content: `export function createContainer() {
  const factories = new Map();
  return {
    register(name, factory) {
      factories.set(name, factory);
    },
    get(name) {
      const factory = factories.get(name);
      if (!factory) throw new Error(\`unknown service: \${name}\`);
      return factory();
    },
  };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createContainer } from './src/container.js';
const c = createContainer();
let constructed = 0;
c.register('plain', () => ({ n: ++constructed }));
assert.notEqual(c.get('plain'), c.get('plain'), 'transient scope constructs per get');
c.singleton('single', () => ({ n: ++constructed }));
assert.equal(c.get('single'), c.get('single'), 'singleton returns the same instance');
assert.throws(() => c.get('missing'), Error);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-14',
    title: '指数退避策略',
    level: 6,
    scenario: 'hinted',
    goal: `src/http.js 的请求层需要可插拔的退避策略。新增 src/backoff.js,导出 createBackoff({ baseMs, factor = 2, maxMs = 60000, jitterRatio = 0, rand = Math.random }):
返回 { next(attempt) }——第 attempt 次(从 1 起)的基础延迟为 baseMs * factor^(attempt-1),封顶 maxMs;jitterRatio > 0 时在 [1-r, 1+r] 区间内用 rand() 抖动,取整;jitterRatio 为 0 时返回精确基础延迟。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/http.js',
        content: `const RETRYABLE = new Set(['TIMEOUT', 'RATE_LIMITED']);

export function isRetryable(code) {
  return RETRYABLE.has(code);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createBackoff } from './src/backoff.js';
const plain = createBackoff({ baseMs: 100 });
assert.equal(plain.next(1), 100);
assert.equal(plain.next(3), 400);
assert.equal(plain.next(20), 60000, 'capped at maxMs');
const jittered = createBackoff({ baseMs: 100, jitterRatio: 0.5, rand: () => 0.5 });
assert.equal(jittered.next(2), 200, 'rand=0.5 keeps the base delay');
const spread = createBackoff({ baseMs: 100, jitterRatio: 0.5, rand: () => 1 });
assert.equal(spread.next(2), 300, 'rand=1 gives +50%');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-15',
    title: '日志合并',
    level: 6,
    scenario: 'hinted',
    goal: `src/log.js 定义了日志条目结构与展示函数。新增 src/merge-logs.js,导出 mergeLogs(a, b):
两条日志流(各为按时间升序的条目数组)合并为一条升序数组;ts 相同的条目保留先出现在 a 中的;完全相同的条目(id 相同)去重,保留首个。src/log.js 不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/log.js',
        content: `export function formatEntry(entry) {
  return \`[\${entry.ts}] #\${entry.id} \${entry.message}\`;
}

export function formatAll(entries) {
  return entries.map(formatEntry);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { mergeLogs } from './src/merge-logs.js';
const e = (id, ts, message) => ({ id, ts, message });
const a = [e(1, '10:00', 'a-first'), e(3, '10:05', 'a-mid'), e(4, '10:10', 'dup')];
const b = [e(2, '10:02', 'b-first'), e(4, '10:10', 'dup'), e(5, '10:03', 'b-late')];
const merged = mergeLogs(a, b);
assert.deepEqual(
  merged.map((entry) => entry.id),
  [1, 2, 5, 3, 4],
  'sorted by ts, ts-tie keeps a first, duplicate id deduped',
);
assert.deepEqual(mergeLogs([], b).map((entry) => entry.id), [2, 5, 4]);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-16',
    title: '特性开关求值',
    level: 6,
    scenario: 'hinted',
    goal: `src/config.js 里的 FLAGS 是布尔或函数型开关的注册表(函数型接收 context)。新增 src/flags.js,导出 isEnabled(flags, name, context = {}):
未注册的开关返回 false;布尔开关直接取值;函数开关用 context 调用求值;求值抛错时按 false 处理并吞掉错误。src/config.js 不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/config.js',
        content: `export const FLAGS = {
  'ui.dark-mode': true,
  'ui.beta-panel': false,
  'billing.enterprise': (context) => context.plan === 'enterprise',
  'risky.experiment': (context) => {
    if (context.throwUp) throw new Error('switch evaluation failed');
    return true;
  },
};
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { isEnabled } from './src/flags.js';
import { FLAGS } from './src/config.js';
assert.equal(isEnabled(FLAGS, 'ui.dark-mode'), true);
assert.equal(isEnabled(FLAGS, 'ui.beta-panel'), false);
assert.equal(isEnabled(FLAGS, 'unknown.flag'), false);
assert.equal(isEnabled(FLAGS, 'billing.enterprise', { plan: 'enterprise' }), true);
assert.equal(isEnabled(FLAGS, 'billing.enterprise', { plan: 'starter' }), false);
assert.equal(isEnabled(FLAGS, 'risky.experiment', { throwUp: true }), false, 'throwing switch reads as disabled');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
];
