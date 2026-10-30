/**
 * M0 反思止血护栏:
 *  - parsePlan:代码围栏(多块取最后)、尾逗号容错、null/非法返 null
 *  - runReflection:首轮不可解析 → 一次修复式重试;重试成功则正常落地;两轮都坏 →
 *    parse-failed 且带 rawParseFailure(不再无声丢整轮)
 * 隔离:chdir + 临时 HOME/USERPROFILE,使 global/project memory 与 memory.log 都落在 tmp,
 * 绝不让 gcMemories 触碰开发者真实记忆库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { runReflection, parsePlan } from '../src/memory/reflect.js';

function sse(content: string | null): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
  };
}

function isolated<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-reflect-'));
    const cwd = process.cwd();
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    process.chdir(root);
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    try {
      return await fn();
    } finally {
      __setChatCreateImpl(null);
      process.chdir(cwd);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('parsePlan: 多围栏取最后块、剥尾逗号、正常 JSON', () => {
  assert.ok(parsePlan('```json\n{"saves":[]}\n```'));
  const multi = '前文\n```json\n{"saves":[{"name":"old"}]}\n```\n后文\n```\n{"saves":[],"triples":[],}\n```';
  const p = parsePlan(multi);
  assert.ok(p);
  assert.deepEqual(p!.saves, []);
  assert.ok(parsePlan('前缀 {"updates":[]} 后缀'));
  assert.equal(parsePlan(null), null);
  assert.equal(parsePlan('完全不是 JSON'), null);
});

test(
  'runReflection: 首轮坏 JSON 触发一次修复重试,重试返回空计划 → 成功不报错',
  isolated(async () => {
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return calls === 1 ? sse('我先想想……(无 JSON)') : sse('{"saves":[],"updates":[],"forgets":[],"triples":[]}');
    });
    const r = await runReflection('user: hi');
    assert.equal(calls, 2, '应恰好重试一次');
    assert.equal(r.error, undefined);
    assert.equal(r.repairAttempted, true);
    assert.equal(r.saves, 0);
  }),
);

test(
  'runReflection: 首轮合法不重试',
  isolated(async () => {
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return sse('{"saves":[],"updates":[],"forgets":[],"triples":[]}');
    });
    const r = await runReflection('user: hi');
    assert.equal(calls, 1);
    assert.equal(r.repairAttempted, undefined);
    assert.equal(r.error, undefined);
  }),
);

test(
  'runReflection: 两轮都不可解析 → parse-failed 且 rawParseFailure 留证',
  isolated(async () => {
    __setChatCreateImpl(async () => sse('依然没有结构化输出'));
    const r = await runReflection('user: hi');
    assert.equal(r.error, 'parse-failed');
    assert.equal(r.repairAttempted, true);
    assert.ok(r.rawParseFailure && r.rawParseFailure.length > 0);
  }),
);

test(
  'runReflection: content=null(推理模型只吐 reasoning)→ 重试,仍 null 时指纹写明 content=null',
  isolated(async () => {
    __setChatCreateImpl(async () => sse(null));
    const r = await runReflection('user: hi');
    assert.equal(r.error, 'parse-failed');
    assert.match(r.rawParseFailure ?? '', /content=null/);
  }),
);

test(
  'runReflection: 后台重试预算收紧到 3 次——后端持续失败不再打满 60s 超时',
  isolated(async () => {
    // 回归:默认交互式预算 10 次、退避累计 ≈61s,恰好打满反思 60s 超时,状态栏只剩
    // 含义不明的 AbortError。连接类错误首次重试零等待,3 次预算应在毫秒级耗尽。
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      });
    });
    const startedAt = Date.now();
    const r = await runReflection('user: hi');
    assert.equal(calls, 3, '反思只允许 1 次初始 + 2 次重试');
    assert.ok(Date.now() - startedAt < 5_000, '远小于 60s 超时');
    assert.ok(r.error, '持续失败仍以错误收尾,但不再是裸 AbortError');
    assert.doesNotMatch(r.error ?? '', /AbortError|This operation was aborted/);
  }),
);

test(
  'runReflection: 外部 signal 中断 → 归类为可读的反思超时,而非 AbortError 文案',
  isolated(async () => {
    __setChatCreateImpl((_body, opts) => {
      // 模拟一个挂住的请求:signal 到期时底层 fetch 抛裸 AbortError。
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    // 必须用**被引用的** timer 驱动 abort,不能用 AbortSignal.timeout:后者的底层定时器是
    // unref() 的,事件循环一旦没有别的东西撑着(CI 全量单进程跑到这里就是这种情况)它永远
    // 不触发,测试以「Promise resolution is still pending but the event loop has already
    // resolved」挂死,并把其后 500 个用例一并 cancelled(exit code 1)。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 50);
    try {
      const r = await runReflection('user: hi', ac.signal);
      assert.match(r.error ?? '', /^反思超时/, `应归类为反思超时,实际: ${r.error}`);
    } finally {
      clearTimeout(timer);
    }
  }),
);
