/**
 * L2 错误层:参数校验失败时把「已知编辑目标」回灌给模型。
 * 1. knownEditTargets:只返回仍新鲜的 read_file 目标 (path+hash),文件被改动后失效;
 * 2. executeToolOutcome:INVALID_ARGUMENTS 时追加调用方注入的 argumentErrorHint,
 *    成功执行与其他错误码不受影响。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createContextState } from '../src/session/compact.js';
import { recordArtifact, invalidateArtifacts, knownEditTargets } from '../src/context/index.js';
import type { ChatMessage } from '../src/llm/index.js';
import { executeToolOutcome, registerToolsExtension, clearToolsExtension } from '../src/tools/registry.js';

const EXT_SOURCE = 'argument-error-hint-test';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

/** 构造一次成功 read_file 的最小 history:assistant.tool_calls + 配对 tool 消息。 */
function readArtifactMessages(callId: string, path: string, hash: string): ChatMessage[] {
  return [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path }) },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      content: `[artifact source=read_file path=${path} hash=${hash}]\n     1\tline one`,
    },
  ];
}

function recordRead(
  state: ReturnType<typeof createContextState>,
  callId: string,
  path: string,
  hash: string,
): ChatMessage[] {
  const history = readArtifactMessages(callId, path, hash);
  recordArtifact(state, history, 2, String((history[2] as { content?: unknown }).content), true);
  return history;
}

after(() => {
  clearToolsExtension(EXT_SOURCE);
});

test('knownEditTargets: 返回仍新鲜的 read_file 目标 (path + hash)', () => {
  const state = createContextState();
  recordRead(state, 'call_a', 'src/alpha.ts', HASH_A);
  recordRead(state, 'call_b', 'src/beta.ts', HASH_B);

  const targets = knownEditTargets(state);
  assert.equal(targets.length, 2);
  const byHash = new Map(targets.map((item) => [item.hash, item.path]));
  assert.ok(byHash.get(HASH_A)?.endsWith('alpha.ts'));
  assert.ok(byHash.get(HASH_B)?.endsWith('beta.ts'));
});

test('knownEditTargets: 文件被改动失效后不再返回', () => {
  const state = createContextState();
  const history = recordRead(state, 'call_stale', 'src/gamma.ts', HASH_A);
  const canonical = knownEditTargets(state)[0]?.path;
  assert.ok(canonical);
  invalidateArtifacts(state, history, [canonical]);
  assert.equal(knownEditTargets(state).length, 0);
});

test('knownEditTargets: limit 生效且至少返回 1 条', () => {
  const state = createContextState();
  recordRead(state, 'call_l1', 'src/one.ts', HASH_A);
  recordRead(state, 'call_l2', 'src/two.ts', HASH_B);
  recordRead(state, 'call_l3', 'src/three.ts', `sha256:${'c'.repeat(64)}`);
  assert.equal(knownEditTargets(state, 2).length, 2);
});

test('executeToolOutcome: INVALID_ARGUMENTS 时追加 argumentErrorHint', async () => {
  registerToolsExtension(EXT_SOURCE, [
    {
      name: 'hint_probe',
      description: 'probe tool for argument error hint tests',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async () => 'ok',
    },
  ]);

  const hint = 'HINT: path=src/known.ts expected_hash=' + HASH_A;

  const withHint = await executeToolOutcome('hint_probe', '{}', undefined, { argumentErrorHint: hint });
  assert.equal(withHint.code, 'INVALID_ARGUMENTS');
  assert.ok(withHint.output.includes('缺少必填字段'));
  assert.ok(withHint.output.includes(hint));

  const withoutHint = await executeToolOutcome('hint_probe', '{}');
  assert.equal(withoutHint.code, 'INVALID_ARGUMENTS');
  assert.ok(!withoutHint.output.includes(hint));
});

test('executeToolOutcome: 参数合法时正常执行,不泄露 hint', async () => {
  const hint = 'HINT: must not leak on success';
  const ok = await executeToolOutcome('hint_probe', JSON.stringify({ path: 'x.ts' }), undefined, {
    argumentErrorHint: hint,
  });
  assert.equal(ok.status, 'success');
  assert.ok(!ok.output.includes(hint));
});
