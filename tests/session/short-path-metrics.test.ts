/**
 * 短路径效率归约器(src/session/short-path-metrics.ts)的纯函数单测。
 *
 * 覆盖四类判定:
 *  1. 理想短路径:1 次模型请求 + 1 读 + 1 改 → 首改前请求/读数都为 1;
 *  2. 冗余:相同(工具, argumentHash)的重复只读调用逐次计入 repeatedIdenticalReadOnlyCalls;
 *  3. 边界:整轮无 mutation 时首改指标为 null;失败的 model_end 不计请求数;
 *  4. 改后探索:postEditReadOnlyCalls 只统计首个 mutation 之后的只读调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countReadOnlyCalls, reduceShortPathEfficiency } from '../../src/session/short-path-metrics.js';
import type { AgentTraceEvent } from '../../src/session/trace.js';

let seq = 0;

function ev(type: AgentTraceEvent['type'], data: Record<string, unknown>, step?: number): AgentTraceEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    eventId: `evt-${seq}`,
    ts: new Date().toISOString(),
    sessionId: 'test',
    turnId: 0,
    type,
    data,
    ...(step === undefined ? {} : { step }),
  };
}

function modelEnd(overrides: Record<string, unknown> = {}): AgentTraceEvent {
  return ev('model_end', {
    status: 'success',
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    ...overrides,
  });
}

function readCall(fingerprint: string, tool = 'read_file'): AgentTraceEvent[] {
  return [
    ev('tool_call_start', { tool, argumentHash: fingerprint }),
    ev('tool_call_end', { tool, argumentHash: fingerprint, status: 'success', changedFiles: [] }),
  ];
}

function mutationCall(tool = 'edit_file', files = ['src/a.js']): AgentTraceEvent[] {
  return [
    ev('tool_call_start', { tool, argumentHash: `m-${tool}` }),
    ev('tool_call_end', { tool, argumentHash: `m-${tool}`, status: 'success', changedFiles: files }),
  ];
}

test('理想短路径:读一次就改,首改前只有 1 个模型请求和 1 次只读', () => {
  const events = [
    ev('turn_start', {}),
    modelEnd(),
    ...readCall('hash-file-a'),
    ...mutationCall(),
    modelEnd({ promptTokens: 200, completionTokens: 20, totalTokens: 220 }),
    ev('turn_end', { durationMs: 1500 }),
  ];
  const m = reduceShortPathEfficiency(events);
  assert.equal(m.toolCalls, 2);
  assert.equal(m.readOnlyCalls, 1);
  assert.equal(m.mutationCalls, 1);
  assert.equal(m.modelRequests, 2);
  assert.equal(m.requestsBeforeFirstEdit, 1);
  assert.equal(m.readCallsBeforeFirstEdit, 1);
  assert.equal(m.repeatedIdenticalReadOnlyCalls, 0);
  assert.equal(m.postEditReadOnlyCalls, 0);
  assert.equal(m.promptTokens, 300);
  assert.equal(m.completionTokens, 30);
  assert.equal(m.totalTokens, 330);
  assert.equal(m.durationMs, 1500);
});

test('相同参数指纹的重复只读调用逐次计冗余,不同指纹不计', () => {
  const events = [
    ...readCall('same'),
    ...readCall('same'),
    ...readCall('same'),
    ...readCall('other'),
    ...readCall('same', 'grep'),
  ];
  const m = reduceShortPathEfficiency(events);
  assert.equal(m.readOnlyCalls, 5);
  // read_file:same 出现 3 次 → 2 次冗余;grep:same 是不同 key,不算。
  assert.equal(m.repeatedIdenticalReadOnlyCalls, 2);
});

test('整轮无 mutation:首改指标为 null', () => {
  const events = [modelEnd(), ...readCall('a'), ...readCall('a'), modelEnd()];
  const m = reduceShortPathEfficiency(events);
  assert.equal(m.requestsBeforeFirstEdit, null);
  assert.equal(m.readCallsBeforeFirstEdit, null);
  assert.equal(m.mutationCalls, 0);
});

test('失败的 model_end 不计请求数也不计 token', () => {
  const events = [
    modelEnd({ status: 'error', promptTokens: 999, completionTokens: 999, totalTokens: 999 }),
    modelEnd(),
    ...mutationCall(),
  ];
  const m = reduceShortPathEfficiency(events);
  assert.equal(m.modelRequests, 1);
  assert.equal(m.promptTokens, 100);
  assert.equal(m.requestsBeforeFirstEdit, 1);
});

test('改后再探索计入 postEditReadOnlyCalls,不影响首改前指标', () => {
  const events = [
    modelEnd(),
    ...mutationCall(),
    ...readCall('after-1'),
    ...readCall('after-1'),
    ...readCall('after-2', 'glob'),
  ];
  const m = reduceShortPathEfficiency(events);
  assert.equal(m.requestsBeforeFirstEdit, 1);
  assert.equal(m.readCallsBeforeFirstEdit, 0);
  assert.equal(m.postEditReadOnlyCalls, 3);
  assert.equal(m.repeatedIdenticalReadOnlyCalls, 1);
});

test('多文件 mutation 与 cached token 拆分', () => {
  const events = [modelEnd({ cachedTokens: 40 }), ...mutationCall('write_file', ['a.js', 'b.js'])];
  const m = reduceShortPathEfficiency(events);
  assert.equal(m.mutationCalls, 1);
  assert.equal(m.cachedTokens, 40);
});

test('countReadOnlyCalls 统计含 glob/grep 的全部只读调用', () => {
  const events = [
    ...readCall('1'),
    ...readCall('2', 'grep'),
    ...readCall('3', 'glob'),
    ...mutationCall(),
    ...readCall('4'),
  ];
  assert.equal(countReadOnlyCalls(events), 4);
});

test('阶段计量区分路由、主模型重试、改后命令和末次收尾', () => {
  const events = [
    ev('tool_route', { latencyMs: 30 }),
    ev('model_end', { status: 'error', durationMs: 40 }, 0),
    ev('model_retry', {}, 0),
    { ...modelEnd({ cachedTokens: 80, durationMs: 100 }), step: 0 },
    ...mutationCall(),
    { ...modelEnd({ cachedTokens: 80, durationMs: 70 }), step: 1 },
    ev('tool_call_start', { tool: 'run_command' }),
    ev('tool_call_end', { tool: 'run_command', status: 'success', durationMs: 25 }),
    { ...modelEnd({ cachedTokens: 80, durationMs: 60 }), step: 2 },
    ev('short_path_completion', { status: 'fallback', reason: 'user_update' }),
  ];
  assert.deepEqual(reduceShortPathEfficiency(events).phases, {
    routeDurationMs: 30,
    modelAttempts: 5,
    modelDurationMs: 230,
    uncachedPromptTokens: 60,
    postEditCommands: 1,
    postEditCommandDurationMs: 25,
    finalModelRequests: 1,
    finalModelDurationMs: 60,
    completion: 'fallback',
    fallbackReason: 'user_update',
  });
  const automatic = reduceShortPathEfficiency([
    ...events.slice(0, -2),
    ev('short_path_completion', { status: 'completed' }),
  ]);
  assert.equal(automatic.phases?.completion, 'automatic');
  assert.equal(automatic.phases?.finalModelRequests, 0);
  assert.equal(
    reduceShortPathEfficiency([modelEnd({ cachedTokens: 90 }), modelEnd()]).phases?.uncachedPromptTokens,
    null,
  );
});
