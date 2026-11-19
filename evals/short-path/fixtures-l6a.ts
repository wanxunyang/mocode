import type { ShortPathTask } from './types.js';

/**
 * L6 多文件功能开发(前 8 题):只给「新文件名 + 导出签名 + 行为契约」,不给实现模板。
 * 与 L3 hinted 的区别:L3 是修既有 bug(路径/复现已给),L6 是从规格写出新功能
 * (设计自由度在实现与内部结构)。verifier 静态 import 新导出 → 未实现时必然失败。
 * gold 放宽到 10 次调用(读既有模块 2-3 + 新增/集成 3-4 + verify + 余量)。
 */
export const l6TasksA: ShortPathTask[] = [
  {
    id: 'l6-01',
    title: '事件总线:优先级触发',
    level: 6,
    scenario: 'hinted',
    goal: `src/emitter.js 有一个基础的发布订阅实现(on/emit,按注册顺序触发)。
扩展它支持优先级:on(event, fn, priority = 0) —— priority 数值大的监听器先被调用,同优先级保持注册顺序;emit 返回本次被触发的监听器数量。既有 on/emit 语义不得破坏。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/emitter.js',
        content: `export function createEmitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event, value) {
      const list = listeners.get(event) ?? [];
      for (const fn of list) fn(value);
      return list.length;
    },
  };
}
`,
      },
      {
        path: 'src/audit.js',
        content: `import { createEmitter } from './emitter.js';
export function createAuditBus() {
  const bus = createEmitter();
  return bus;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createEmitter } from './src/emitter.js';
const bus = createEmitter();
const order = [];
bus.on('evt', () => order.push('low'), 1);
bus.on('evt', () => order.push('high'), 10);
bus.on('evt', () => order.push('mid'), 5);
bus.on('evt', () => order.push('low2'), 1);
const n = bus.emit('evt', null);
assert.deepEqual(order, ['high', 'mid', 'low', 'low2']);
assert.equal(n, 4);
assert.equal(bus.emit('nothing', null), 0);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-02',
    title: '配置加载:环境变量覆盖层',
    level: 6,
    scenario: 'hinted',
    goal: `src/defaults.js 定义了 DEFAULTS,src/validate.js 提供 validate(config)。
新增 src/load-config.js,导出 loadConfig(env):以 DEFAULTS 为底,读取 env 中 "APP_" 前缀的变量做覆盖(映射:APP_RETRIES → retries;APP_TIMEOUT_MS → timeoutMs;APP_VERBOSE → verbose,"true"/"1" 视为 true);数值一律转 number;覆盖后经 validate 校验并返回最终配置。env 无 APP_ 变量时返回 DEFAULTS 本身。既有模块不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/defaults.js',
        content: `export const DEFAULTS = { retries: 3, timeoutMs: 5000, verbose: false };
`,
      },
      {
        path: 'src/validate.js',
        content: `const NUMBER_KEYS = new Set(['retries', 'timeoutMs']);
const BOOLEAN_KEYS = new Set(['verbose']);

export function validate(config) {
  for (const [key, value] of Object.entries(config)) {
    if (NUMBER_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(\`\${key} must be a number\`);
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new TypeError(\`\${key} must be a boolean\`);
    } else {
      throw new TypeError(\`unknown config key: \${key}\`);
    }
  }
  return true;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { loadConfig } from './src/load-config.js';
assert.deepEqual(loadConfig({}), { retries: 3, timeoutMs: 5000, verbose: false });
assert.deepEqual(loadConfig({ APP_RETRIES: '7', APP_TIMEOUT_MS: '2500' }), { retries: 7, timeoutMs: 2500, verbose: false });
assert.deepEqual(loadConfig({ APP_VERBOSE: 'true' }), { retries: 3, timeoutMs: 5000, verbose: true });
assert.deepEqual(loadConfig({ APP_VERBOSE: '0' }), { retries: 3, timeoutMs: 5000, verbose: false });
assert.throws(() => loadConfig({ APP_RETRIES: 'abc' }), TypeError);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-03',
    title: '中间件管道',
    level: 6,
    scenario: 'hinted',
    goal: `src/server.js 的 handle() 目前直接调用单台 processor。引入中间件机制:新增 src/pipeline.js,导出 createPipeline()。
createPipeline() 返回 { use(fn), run(input) }:use 按注册顺序登记形如 (input, next) => string 的中间件;run 从 input 出发依序穿过所有中间件(next() 返回下一层的输出,最内层为恒等函数),返回最终结果。再把 src/server.js 的 handle 改为经由 pipeline(保留既有行为:无中间件时输出不变)。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/server.js',
        content: `export function handle(input, processor = (s) => s) {
  return processor(input);
}
`,
      },
      {
        path: 'src/plugins.js',
        content: `export const UPPER = (s) => s.toUpperCase();
export const TRIM = (s) => s.trim();
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createPipeline } from './src/pipeline.js';
const pipe = createPipeline();
pipe.use((input, next) => next().trim());
pipe.use((input, next) => next().toUpperCase());
pipe.use((input, next) => '[' + next() + ']');
assert.equal(pipe.run('  hello  '), '[HELLO]');
assert.equal(createPipeline().run('plain'), 'plain');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-04',
    title: '重试队列:失败重排',
    level: 6,
    scenario: 'hinted',
    goal: `src/worker.js 提供了 runTask(task) 的任务抽象(同步成功/抛错)。新增 src/retry-queue.js,导出 createRetryQueue({ maxAttempts })。
createRetryQueue 返回 { push(task), drain() }:push 入队任务(形如 { name, run: () => string });drain 依序执行,成功的记录结果,失败的重试直至 maxAttempts 次仍失败则记为 dead。drain 返回 { results: [{ name, output }], dead: [{ name, error }] }。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/worker.js',
        content: `export function runTask(task) {
  return task.run();
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createRetryQueue } from './src/retry-queue.js';

const flaky = (() => {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return 'recovered';
  };
})();

const queue = createRetryQueue({ maxAttempts: 3 });
queue.push({ name: 'flaky', run: flaky });
queue.push({ name: 'good', run: () => 'fine' });
queue.push({ name: 'dead', run: () => { throw new Error('permanent'); } });
const report = queue.drain();
assert.deepEqual(report.results, [
  { name: 'flaky', output: 'recovered' },
  { name: 'good', output: 'fine' },
]);
assert.equal(report.dead.length, 1);
assert.equal(report.dead[0].name, 'dead');
assert.match(report.dead[0].error, /permanent/);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-05',
    title: 'TTL 缓存装饰器',
    level: 6,
    scenario: 'hinted',
    goal: `src/api.js 的 fetchProfile(id) 是昂贵的远端调用。新增 src/cached.js,导出 withTtl(fn, ttlMs, now = () => Date.now()):
返回一个包装函数,相同实参(单参数,原始值)在 ttl 内命中缓存直接返回上次结果,不重复调用 fn;过期后重新调用并刷新。缓存不跨不同实参共享。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/api.js',
        content: `let calls = 0;

export function fetchProfile(id) {
  calls += 1;
  return { id, rev: calls };
}

export function fetchCallCount() {
  return calls;
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { fetchProfile, fetchCallCount } from './src/api.js';
import { withTtl } from './src/cached.js';

let t = 1000;
const cached = withTtl(fetchProfile, 500, () => t);
const first = cached(7);
assert.equal(cached(7).id, 7);
assert.equal(fetchCallCount(), 1, 'second call within TTL must be served from cache');
t = 1600;
const refreshed = cached(7);
assert.notEqual(refreshed.rev, first.rev, 'expired entry must refetch');
assert.equal(fetchCallCount(), 2);
assert.equal(cached(8).id, 8);
assert.equal(fetchCallCount(), 3, 'different argument must not share cache');
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-06',
    title: '命令行解析器',
    level: 6,
    scenario: 'hinted',
    goal: `src/registry.js 维护合法子命令集合。新增 src/parse-command.js,导出 parseCommand(line):
把 "cmd --flag value --bool a b" 解析为 { name, flags, args }——name 为首个 token;-- 开头为 flag,后随非 -- token 则为带值 flag(否则布尔 true);其余 token 进 args(保持顺序)。未知子命令抛 SyntaxError。src/registry.js 不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/registry.js',
        content: `export const COMMANDS = new Set(['deploy', 'rollback', 'status']);
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { parseCommand } from './src/parse-command.js';
const parsed = parseCommand('deploy --env prod --verbose a b');
assert.equal(parsed.name, 'deploy');
assert.deepEqual(parsed.flags, { env: 'prod', verbose: true });
assert.deepEqual(parsed.args, ['a', 'b']);
assert.throws(() => parseCommand('destroy --force'), SyntaxError);
assert.deepEqual(parseCommand('status').flags, {});
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-07',
    title: '序列化往返',
    level: 6,
    scenario: 'hinted',
    goal: `src/schema.js 定义了 User 的字段契约。新增 src/serialize.js,导出 toJSON(user) 与 fromJSON(json):
toJSON 把 camelCase 的 user 对象转成 snake_case 的 JSON 字符串(含 indent 2);fromJSON 做逆向解析并还原 camelCase 对象。往返必须无损;未知字段忽略。src/schema.js 不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/schema.js',
        content: `export const USER_FIELDS = ['id', 'displayName', 'createdAt'];
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { toJSON, fromJSON } from './src/serialize.js';
const user = { id: 1, displayName: 'Ada', createdAt: '2026-01-01', secret: 'drop-me' };
const json = toJSON(user);
assert.equal(JSON.parse(json).display_name, 'Ada');
assert.equal(JSON.parse(json).secret, undefined);
assert.deepEqual(fromJSON(json), { id: 1, displayName: 'Ada', createdAt: '2026-01-01' });
assert.deepEqual(fromJSON(toJSON({ id: 2, displayName: 'Bob', createdAt: '' })), { id: 2, displayName: 'Bob', createdAt: '' });
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
  {
    id: 'l6-08',
    title: '插件系统',
    level: 6,
    scenario: 'hinted',
    goal: `src/app.js 的 createApp() 有一个能力注册表(capabilities Set)与 expose(name) 方法。
新增 src/plugins.js,导出 registerPlugin(app, plugin) 与 pluginNames(app):plugin 形如 { name, setup(app) },register 调用 setup 并把 plugin.name 记入 app 能力表(名字加 "plugin:" 前缀);pluginNames 返回已注册插件名数组。重复注册同名插件抛 Error。src/app.js 不得修改。
完成后运行 node verify.mjs 自查。`,
    files: [
      {
        path: 'src/app.js',
        content: `export function createApp() {
  const capabilities = new Set();
  return {
    expose(name) {
      capabilities.add(name);
    },
    has(name) {
      return capabilities.has(name);
    },
    _capabilities: capabilities,
  };
}
`,
      },
      {
        path: 'verify.mjs',
        content: `import assert from 'node:assert/strict';
import { createApp } from './src/app.js';
import { registerPlugin, pluginNames } from './src/plugins.js';
const app = createApp();
const installed = [];
registerPlugin(app, { name: 'logger', setup(a) { installed.push(a.has('plugin:logger')); } });
registerPlugin(app, { name: 'cache', setup() {} });
assert.deepEqual(pluginNames(app), ['logger', 'cache']);
assert.equal(app.has('plugin:logger'), true);
assert.deepEqual(installed, [true]);
assert.throws(() => registerPlugin(app, { name: 'logger', setup() {} }), Error);
console.log('ok');
`,
      },
    ],
    verificationCommand: 'node verify.mjs',
    gold: { maxToolCalls: 10, maxRequestsBeforeFirstEdit: 5 },
  },
];
