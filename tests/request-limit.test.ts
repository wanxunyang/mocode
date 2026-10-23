// 请求体字节预算:度量、上限来源(显式配置 > 学习值 > 不限制)与学习规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../src/llm/index.js';
import {
  estimateRequestBytes,
  explicitRequestLimitBytes,
  learnRequestByteLimit,
  REQUEST_BYTES_TRIGGER_RATIO,
  requestByteLimit,
  resetRequestLimitCache,
} from '../src/context/request-limit.js';

const BASE = 'http://localhost:8080';

/** 共享进程:env 与模块级缓存逐次 set/restore。 */
function withIsolatedEnv(fn: (cacheFile: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-reqlimit-'));
  const cacheFile = path.join(dir, 'request-limits.json');
  const prevCache = process.env.MOCODE_REQUEST_LIMIT_CACHE;
  const prevMax = process.env.MOCODE_REQUEST_MAX_KB;
  process.env.MOCODE_REQUEST_LIMIT_CACHE = cacheFile;
  delete process.env.MOCODE_REQUEST_MAX_KB;
  resetRequestLimitCache();
  try {
    fn(cacheFile);
  } finally {
    if (prevCache === undefined) delete process.env.MOCODE_REQUEST_LIMIT_CACHE;
    else process.env.MOCODE_REQUEST_LIMIT_CACHE = prevCache;
    if (prevMax === undefined) delete process.env.MOCODE_REQUEST_MAX_KB;
    else process.env.MOCODE_REQUEST_MAX_KB = prevMax;
    resetRequestLimitCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('触发系数只有一个:0.8', () => {
  assert.equal(REQUEST_BYTES_TRIGGER_RATIO, 0.8);
});

test('estimateRequestBytes: 图片按 data URL 长度计,文本按 UTF-8 字节计', () => {
  const url = `data:image/png;base64,${'A'.repeat(100_000)}`;
  const withImage: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url } },
      ],
    } as ChatMessage,
  ];
  const bytes = estimateRequestBytes(withImage, []);
  assert.ok(bytes >= url.length && bytes < url.length + 500, `实际 ${bytes}`);

  // 中文 3 字节/字:字节数必须大于字符数,否则 CJK 会被低估。
  const cjk: ChatMessage[] = [{ role: 'user', content: '字'.repeat(1000) } as ChatMessage];
  assert.ok(estimateRequestBytes(cjk, []) >= 3000);
});

test('estimateRequestBytes: 计入工具 schema 与 tool_calls,且永不抛错', () => {
  const tools = [
    { type: 'function', function: { name: 't', description: 'd'.repeat(2000), parameters: { type: 'object' } } },
  ] as never;
  const base = estimateRequestBytes([], []);
  assert.ok(estimateRequestBytes([], tools) >= base + 2000);
  const weird = [null, { role: 'assistant', content: null, tool_calls: [{}] }, { role: 'user', content: [null, 1] }];
  assert.doesNotThrow(() => estimateRequestBytes(weird as never, []));
});

test('requestByteLimit: 无配置无学习值 → 0(不限制,直连官方 API 不丢图)', () => {
  withIsolatedEnv(() => {
    assert.equal(explicitRequestLimitBytes(), 0);
    assert.equal(requestByteLimit(BASE), 0);
  });
});

test('requestByteLimit: 显式 MOCODE_REQUEST_MAX_KB 优先于学习值;空串/非法/0 视为未配置', () => {
  withIsolatedEnv(() => {
    learnRequestByteLimit(BASE, 1_000_000);
    process.env.MOCODE_REQUEST_MAX_KB = '900';
    assert.equal(requestByteLimit(BASE), 900 * 1024);
    for (const bad of ['', '  ', 'abc', '0', '-5']) {
      process.env.MOCODE_REQUEST_MAX_KB = bad;
      assert.equal(explicitRequestLimitBytes(), 0, `"${bad}" 应视为未配置`);
      assert.equal(requestByteLimit(BASE), 1_000_000, '回落到学习值');
    }
  });
});

test('learnRequestByteLimit: 取历史最小值,小样本不学,按 baseURL 隔离', () => {
  withIsolatedEnv(() => {
    assert.equal(learnRequestByteLimit(BASE, 1_000_000), 1_000_000);
    assert.equal(learnRequestByteLimit(BASE, 2_000_000), 1_000_000, '更大的失败样本不上调');
    assert.equal(learnRequestByteLimit(BASE, 800_000), 800_000, '更小的失败样本下调');
    assert.equal(learnRequestByteLimit(BASE, 1000), 800_000, '< 64KiB 不可能是字节上限,忽略');
    assert.equal(requestByteLimit(BASE), 800_000);
    assert.equal(requestByteLimit('https://api.example.com/v1'), 0, '其他 baseURL 不受影响');
  });
});

test('learnRequestByteLimit: 持久化到磁盘、只存 baseURL 摘要,重置内存缓存后仍能读回', () => {
  withIsolatedEnv((cacheFile) => {
    learnRequestByteLimit(`${BASE}/secret-token-123`, 700_000);
    const raw = fs.readFileSync(cacheFile, 'utf8');
    assert.ok(!raw.includes('secret-token-123'), 'URL 明文不得落盘');
    resetRequestLimitCache();
    assert.equal(requestByteLimit(`${BASE}/secret-token-123`), 700_000);
  });
});
