import type { ShortPathTask } from './types.js';

/**
 * S2 hinted:2-3 个文件的迷你仓库,任务文本自带精确文件路径与失败证据(报错/堆栈/复现)。
 * gold 路径 = 直奔提示文件 read → edit(→ verify),maxToolCalls = 4。
 * 测的是:提示已经在任务里,agent 还要不要全树 glob/grep 绕一圈。
 */
export const hintedTasks: ShortPathTask[] = [
  {
    id: 'hint-01',
    title: '跨年周边计算错误',
    scenario: 'hinted',
    level: 3,
    goal: `src/format.js 的 weekLabel(date) 在跨年那一周返回错误的年份后缀。
复现:weekLabel(new Date('2026-01-01T00:00:00Z')) 返回 "Week 1 (2025)",应该是 "Week 1 (2026)"。
修复 src/format.js。`,
    files: [
      {
        path: 'src/format.js',
        content: `export function weekLabel(date) {
  const dateObj = new Date(date);
  const startOfYear = new Date(Date.UTC(dateObj.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dateObj - startOfYear) / 86400000 + startOfYear.getUTCDay() + 1) / 7);
  // 已知问题:这里用了 dateObj.getUTCFullYear() - 1,跨年第一周会拿到上一年的年份。
  const year = dateObj.getUTCFullYear() - 1;
  return \`Week \${week} (\${year})\`;
}
`,
      },
      {
        path: 'src/main.js',
        content: `import { weekLabel } from './format.js';
export function banner(date) {
  return \`[Error] \${weekLabel(date)}: disk almost full\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { weekLabel } from './src/format.js';
assert.equal(weekLabel(new Date('2026-01-01T00:00:00Z')), 'Week 1 (2026)');
assert.equal(weekLabel(new Date('2026-06-15T00:00:00Z')).endsWith('(2026)'), true);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/format.js'] },
  },
  {
    id: 'hint-02',
    title: '折扣函数污染入参',
    scenario: 'hinted',
    level: 3,
    goal: `src/cart.js 的 applyDiscount(cart, rate) 不应该修改传入的 cart 对象,但它现在直接改了 total 字段。
复现:
  const cart = { total: 100 };
  applyDiscount(cart, 0.5);
  cart.total === 50  // 期望仍是 100
修复 src/cart.js,让它返回新对象。`,
    files: [
      {
        path: 'src/cart.js',
        content: `export function applyDiscount(cart, rate) {
  cart.total = cart.total * (1 - rate);
  return cart;
}
`,
      },
      {
        path: 'src/summary.js',
        content: `import { applyDiscount } from './cart.js';
export function discountedSummary(cart, rate) {
  const discounted = applyDiscount(cart, rate);
  return \`pay \${discounted.total}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { applyDiscount } from './src/cart.js';
const cart = { total: 100 };
const discounted = applyDiscount(cart, 0.5);
assert.equal(cart.total, 100, 'input cart must not be mutated');
assert.equal(discounted.total, 50);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/cart.js'] },
  },
  {
    id: 'hint-03',
    title: '时长解析只取了最后一段',
    scenario: 'hinted',
    level: 3,
    goal: `src/parser.js 的 parseDuration("1h30m") 应该返回 5400(秒),现在只解析了最后一段返回 30。
复现:parseDuration('1h30m') === 30,期望 5400;parseDuration('2m') === 120 保持正确。
修复 src/parser.js,让多个时间段累加。`,
    files: [
      {
        path: 'src/parser.js',
        content: `const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(input) {
  const match = input.trim().match(/^(\\d+)([smhd])$/);
  if (!match) return null;
  return Number(match[1]) * UNITS[match[2]];
}
`,
      },
      {
        path: 'src/schedule.js',
        content: `import { parseDuration } from './parser.js';
export function intervalSeconds(spec) {
  return parseDuration(spec) ?? 60;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { parseDuration } from './src/parser.js';
assert.equal(parseDuration('2m'), 120);
assert.equal(parseDuration('1h30m'), 5400);
assert.equal(parseDuration('1d2h3m4s'), 93784);
assert.equal(parseDuration('abc'), null);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/parser.js'] },
  },
  {
    id: 'hint-04',
    title: '退避上限太小',
    scenario: 'hinted',
    level: 3,
    goal: `src/retry.js 的 backoffDelay(attempt) 指数退避的上限被写成了 100ms,需求是上限 5000ms。
调用方报错:重试第 8 次时 delay 仍然是 100,外部 API 限流没有恢复。
复现:backoffDelay(8) === 100,期望 5000;backoffDelay(1) === 100(100 * 2^0)保持正确。
修复 src/retry.js 的上限。`,
    files: [
      {
        path: 'src/retry.js',
        content: `const BASE_MS = 100;

export function backoffDelay(attempt) {
  return Math.min(BASE_MS * 2 ** (attempt - 1), 100);
}
`,
      },
      {
        path: 'src/client.js',
        content: `import { backoffDelay } from './retry.js';
export function nextRetryIn(attempt) {
  return \`retry in \${backoffDelay(attempt)}ms\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { backoffDelay } from './src/retry.js';
assert.equal(backoffDelay(1), 100);
assert.equal(backoffDelay(3), 400);
assert.equal(backoffDelay(8), 5000);
assert.equal(backoffDelay(20), 5000);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/retry.js'] },
  },
  {
    id: 'hint-05',
    title: 'CSV 引号内逗号被切断',
    scenario: 'hinted',
    level: 3,
    goal: `src/csv.js 的 parseCsvLine(line) 没有处理双引号内的逗号。
复现:parseCsvLine('"a,b",c') 返回 ['"a', 'b"', 'c'],期望 ['a,b', 'c'](引号在返回值里要剥掉)。
修复 src/csv.js。`,
    files: [
      {
        path: 'src/csv.js',
        content: `export function parseCsvLine(line) {
  return line.split(',').map((field) => field.trim());
}
`,
      },
      {
        path: 'src/table.js',
        content: `import { parseCsvLine } from './csv.js';
export function headerFields(line) {
  return parseCsvLine(line).length;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { parseCsvLine } from './src/csv.js';
assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);
assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/csv.js'] },
  },
  {
    id: 'hint-06',
    title: 'debounce 永远不触发',
    scenario: 'hinted',
    level: 3,
    goal: `src/debounce.js 的 debounce(fn, wait) 创建的函数永远不执行:定时器被反复重建,但没有在停止触发后放行最后一次调用。
症状:连续调用 3 次后等待 50ms,fn 一次都没被调用,期望恰好调用 1 次。
修复 src/debounce.js。`,
    files: [
      {
        path: 'src/debounce.js',
        content: `export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    // 缺陷:每次调用都立即执行,防抖完全不生效(定时器只是摆设)。
    fn(...args);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {}, wait);
  };
}
`,
      },
      {
        path: 'src/search.js',
        content: `import { debounce } from './debounce.js';
export function createSearchHandler(onSearch) {
  return debounce(onSearch, 20);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { debounce } from './src/debounce.js';

const calls = [];
const debounced = debounce((v) => calls.push(v), 20);
debounced('a');
debounced('b');
debounced('c');
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(calls.length, 1, \`expected exactly one call, got \${calls.length}\`);
assert.equal(calls[0], 'c', 'the last invocation must win');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/debounce.js'] },
  },
  {
    id: 'hint-07',
    title: 'flatten 丢掉嵌套数组元素',
    scenario: 'hinted',
    level: 3,
    goal: `src/depth.js 的 flattenDeep(value) 应该把任意深度嵌套的数组拍平,但当前实现遇到数组时直接丢弃了元素。
复现:flattenDeep([1, [2, [3]], 4]) 返回 [1, 4],期望 [1, 2, 3, 4]。
修复 src/depth.js。`,
    files: [
      {
        path: 'src/depth.js',
        content: `export function flattenDeep(value) {
  if (!Array.isArray(value)) return [value];
  return value.filter((item) => !Array.isArray(item));
}
`,
      },
      {
        path: 'src/tree.js',
        content: `import { flattenDeep } from './depth.js';
export function collectIds(tree) {
  return flattenDeep(tree).filter((item) => typeof item === 'number');
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { flattenDeep } from './src/depth.js';
assert.deepEqual(flattenDeep([1, [2, [3]], 4]), [1, 2, 3, 4]);
assert.deepEqual(flattenDeep([]), []);
assert.deepEqual(flattenDeep(7), [7]);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/depth.js'] },
  },
  {
    id: 'hint-08',
    title: '缓存 TTL 边界提前过期',
    scenario: 'hinted',
    level: 3,
    goal: `src/cache.js 的 TTL 判断用了错误的不等号:age === ttl 时(恰好到期那一刻)条目被判为过期,需求是恰好等于 TTL 时仍命中。
复现:写入后立刻用与 TTL 完全相同的时间读取,返回 undefined,期望是缓存值。
修复 src/cache.js 里的比较。`,
    files: [
      {
        path: 'src/cache.js',
        content: `export function createTtlCache(now = () => Date.now()) {
  const store = new Map();
  return {
    set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      const age = entry.expiresAt - now();
      if (age <= 0) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
  };
}
`,
      },
      {
        path: 'src/session.js',
        content: `import { createTtlCache } from './cache.js';
export function createSessionStore(clock) {
  return createTtlCache(clock);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createTtlCache } from './src/cache.js';

let t = 1000;
const cache = createTtlCache(() => t);
cache.set('k', 'v', 500);
assert.equal(cache.get('k'), 'v');
t = 1500; // 恰好到达 TTL:仍应命中
assert.equal(cache.get('k'), 'v', 'entry at exactly TTL must still hit');
t = 1501; // 超过 TTL:应过期
assert.equal(cache.get('k'), undefined);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/cache.js'] },
  },
  {
    id: 'hint-09',
    title: '深层取值崩溃(带堆栈)',
    scenario: 'hinted',
    level: 3,
    goal: `线上报了 TypeError,堆栈指向 src/resolve.js 的 pluck:
  TypeError: Cannot read properties of undefined (reading 'role')
      at pluck (src/resolve.js:2:39)
spec:路径中任何一段缺失时 pluck 应该返回 undefined,而不是抛 TypeError。
复现:pluck({ user: { name: 'a' } }, 'user.role') 应返回 undefined。
修复 src/resolve.js。`,
    files: [
      {
        path: 'src/resolve.js',
        content: `export function pluck(obj, path) {
  return path.split('.').reduce((acc, key) => acc[key], obj);
}
`,
      },
      {
        path: 'src/greeting.js',
        content: `import { pluck } from './resolve.js';
export function roleGreeting(user) {
  return \`hello \${pluck(user, 'user.role') ?? 'guest'}\`;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { pluck } from './src/resolve.js';
assert.equal(pluck({ user: { role: 'admin' } }, 'user.role'), 'admin');
assert.equal(pluck({ user: { name: 'a' } }, 'user.role'), undefined);
assert.equal(pluck({}, 'user.role'), undefined);
assert.equal(pluck({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/resolve.js'] },
  },
  {
    id: 'hint-10',
    title: '双重循环遍历优先级反了',
    scenario: 'hinted',
    level: 3,
    goal: `src/match.js 的 firstShared(left, right) 应该按 left 的顺序找到第一个也出现在 right 里的元素,现在嵌套循环的遍历优先级写反了,按 right 的顺序返回。
复现:firstShared(['x', 'y', 'z'], ['z', 'y']) 返回 'z',期望 'y'。
代码评审还指出:数据量大时双重循环应该换成 Set 一次命中。修复 src/match.js(行为以 left 优先为准)。`,
    files: [
      {
        path: 'src/match.js',
        content: `export function firstShared(left, right) {
  for (const r of right) {
    for (const l of left) {
      if (l === r) return r;
    }
  }
  return null;
}
`,
      },
      {
        path: 'src/feed.js',
        content: `import { firstShared } from './match.js';
export function pickTag(mine, hot) {
  return firstShared(mine, hot) ?? 'general';
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { firstShared } from './src/match.js';
assert.equal(firstShared(['x', 'y', 'z'], ['z', 'y']), 'y');
assert.equal(firstShared(['a'], ['a']), 'a');
assert.equal(firstShared(['a'], ['b']), null);
assert.equal(firstShared([], ['b']), null);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/match.js'] },
  },
  {
    id: 'hint-11',
    title: '查询参数没编码',
    scenario: 'hinted',
    level: 3,
    goal: `src/url.js 的 buildSearchUrl(base, query) 拼查询参数时没有做 URL 编码,带空格或 & 的关键词会生成坏链接。
复现:buildSearchUrl('https://a.dev/s', 'hello world&lang=zh') 期望
  'https://a.dev/s?q=hello%20world%26lang%3Dzh'
修复 src/url.js。`,
    files: [
      {
        path: 'src/url.js',
        content: `export function buildSearchUrl(base, query) {
  return \`\${base}?q=\${query}\`;
}
`,
      },
      {
        path: 'src/link.js',
        content: `import { buildSearchUrl } from './url.js';
export function searchLink(query) {
  return buildSearchUrl('https://a.dev/s', query);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { buildSearchUrl } from './src/url.js';
assert.equal(buildSearchUrl('https://a.dev/s', 'hello world&lang=zh'), 'https://a.dev/s?q=hello%20world%26lang%3Dzh');
assert.equal(buildSearchUrl('https://a.dev/s', 'plain'), 'https://a.dev/s?q=plain');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/url.js'] },
  },
  {
    id: 'hint-12',
    title: '邮箱去重大小写不归一',
    scenario: 'hinted',
    level: 3,
    goal: `src/subscribers.js 的 uniqueEmails(emails) 做订阅去重,但 "A@x.com" 和 "a@x.com" 被当成了两个人。
spec:大小写不敏感去重,保留首次出现的原始写法,输出顺序不变。
复现:uniqueEmails(['A@x.com', 'a@x.com', 'B@x.com']) 期望 ['A@x.com', 'B@x.com']。
修复 src/subscribers.js。`,
    files: [
      {
        path: 'src/subscribers.js',
        content: `export function uniqueEmails(emails) {
  return [...new Set(emails)];
}
`,
      },
      {
        path: 'src/report.js',
        content: `import { uniqueEmails } from './subscribers.js';
export function subscriberCount(emails) {
  return uniqueEmails(emails).length;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { uniqueEmails } from './src/subscribers.js';
assert.deepEqual(uniqueEmails(['A@x.com', 'a@x.com', 'B@x.com']), ['A@x.com', 'B@x.com']);
assert.deepEqual(uniqueEmails(['b@x.com', 'B@x.COM']), ['b@x.com']);
assert.deepEqual(uniqueEmails([]), []);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/subscribers.js'] },
  },
  {
    id: 'hint-13',
    title: '二分插入点返回值错',
    scenario: 'hinted',
    level: 3,
    goal: `src/bisect.js 的 insertIndex(sorted, value) 应该返回保持升序的插入下标,现在返回了错误的边界变量。
复现:insertIndex([1, 3, 5], 4) 返回 1,期望 2;insertIndex([1, 3, 5], 9) 返回 2,期望 3。
修复 src/bisect.js 的返回值(二分主循环本身是对的)。`,
    files: [
      {
        path: 'src/bisect.js',
        content: `export function insertIndex(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}
`,
      },
      {
        path: 'src/insert.js',
        content: `import { insertIndex } from './bisect.js';
export function insertSorted(sorted, value) {
  sorted.splice(insertIndex(sorted, value), 0, value);
  return sorted;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { insertIndex } from './src/bisect.js';
assert.equal(insertIndex([1, 3, 5], 4), 2);
assert.equal(insertIndex([1, 3, 5], 9), 3);
assert.equal(insertIndex([1, 3, 5], 0), 0);
assert.equal(insertIndex([], 7), 0);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/bisect.js'] },
  },
  {
    id: 'hint-14',
    title: '事件监听器卸载没实现',
    scenario: 'hinted',
    level: 3,
    goal: `内存告警:src/bus.js 的 createBus() 里 off(event, fn) 是空实现,监听器注册后永远卸不掉。
spec:on/off/emit 语义齐全,off 之后 emit 不再调用该监听器,count 反映剩余数量。
修复 src/bus.js 的 off(其余函数不用动)。`,
    files: [
      {
        path: 'src/bus.js',
        content: `export function createBus() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    off(event, fn) {
      // 缺陷:卸载逻辑没实现。
      return;
    },
    emit(event, value) {
      for (const fn of listeners.get(event) ?? []) fn(value);
    },
    count(event) {
      return (listeners.get(event) ?? []).length;
    },
  };
}
`,
      },
      {
        path: 'src/widget.js',
        content: `import { createBus } from './bus.js';
export function createWidget() {
  const bus = createBus();
  return { bus };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createBus } from './src/bus.js';
const bus = createBus();
const seen = [];
const handler = (v) => seen.push(v);
bus.on('tick', handler);
bus.emit('tick', 1);
bus.off('tick', handler);
bus.emit('tick', 2);
assert.deepEqual(seen, [1]);
assert.equal(bus.count('tick'), 0);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/bus.js'] },
  },
  {
    id: 'hint-15',
    title: '并发任务一败全败',
    scenario: 'hinted',
    level: 3,
    goal: `src/fetchall.js 的 fetchAll(tasks) 接收一组无参异步任务函数。调用每个函数,按输入顺序收集结果为 [{ ok, value } | { ok, error }] 数组并始终 resolve。任务以 Error 拒绝时,error 取其 message;其他拒绝值原样保留。
复现:三个任务分别返回值 1、拒绝 Error('boom')、返回值 3 时,期望得到 [{ok:true,value:1},{ok:false,error:'boom'},{ok:true,value:3}]。
修复 src/fetchall.js(用 allSettled 语义)。`,
    files: [
      {
        path: 'src/fetchall.js',
        content: `export async function fetchAll(tasks) {
  return Promise.all(tasks);
}
`,
      },
      {
        path: 'src/batch.js',
        content: `import { fetchAll } from './fetchall.js';
export async function batchSummary(tasks) {
  const results = await fetchAll(tasks);
  return results.filter((r) => r && r.ok).length;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { fetchAll } from './src/fetchall.js';
const boom = () => Promise.reject(new Error('boom'));
const ok = (v) => Promise.resolve(v);
const results = await fetchAll([() => ok(1), boom, () => ok(3)]);
assert.deepEqual(results, [
  { ok: true, value: 1 },
  { ok: false, error: 'boom' },
  { ok: true, value: 3 },
]);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/fetchall.js'] },
  },
  {
    id: 'hint-16',
    title: 'LRU 命中不刷新新鲜度',
    scenario: 'hinted',
    level: 3,
    goal: `src/lru.js 的 createLru(capacity) 实现最近最少使用缓存,但 get() 命中时没有把条目刷新为最新,导致淘汰顺序错。
复现:容量 2,依次 set a、set b、get a、set c,期望 keys() 为 ['a', 'c'](b 被淘汰);现在 a 被淘汰了。
修复 src/lru.js 的 get。`,
    files: [
      {
        path: 'src/lru.js',
        content: `export function createLru(capacity) {
  const store = new Map();
  return {
    get(key) {
      // 缺陷:命中时没有刷新新鲜度。
      return store.get(key);
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      if (store.size > capacity) store.delete(store.keys().next().value);
    },
    keys() {
      return [...store.keys()];
    },
  };
}
`,
      },
      {
        path: 'src/page.js',
        content: `import { createLru } from './lru.js';
export function createPageCache() {
  return createLru(2);
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createLru } from './src/lru.js';
const lru = createLru(2);
lru.set('a', 1);
lru.set('b', 2);
assert.equal(lru.get('a'), 1);
lru.set('c', 3);
assert.deepEqual(lru.keys(), ['a', 'c'], 'b must be evicted, not a');
assert.equal(lru.get('b'), undefined);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 4 },
    expected: { files: ['src/lru.js'] },
  },
];
