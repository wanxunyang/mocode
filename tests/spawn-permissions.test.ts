import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAgent } from '../src/agent/spawn.js';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { findSkill, invalidateSkillsCache } from '../src/skills/index.js';
import { renderSkillBody, runSkill } from '../src/skills/runner.js';
import { mapSkillTools } from '../src/skills/toolmap.js';
import '../src/tools/builtins/index.js';

interface CapturedRequest {
  tools?: Array<{ function: { name: string } }>;
}

function textStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

function requestToolNames(request: CapturedRequest): string[] {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}

test('spawnAgent: 父 snapshot、局部白名单和显式空数组只会缩小工具面', async () => {
  const previousSubagent = process.env.MOCODE_SUBAGENT_ENABLED;
  process.env.MOCODE_SUBAGENT_ENABLED = 'true';
  const requests: CapturedRequest[] = [];
  __setChatCreateImpl(async (body) => {
    requests.push(body as unknown as CapturedRequest);
    return textStream('worker done');
  });

  try {
    const intersected = await spawnAgent({
      prompt: 'inspect one file',
      maxSteps: 1,
      parentAllowedToolNames: ['read_file'],
      tools: ['read_file', 'web_search'],
    });
    const explicitEmpty = await spawnAgent({
      prompt: 'answer without tools',
      maxSteps: 1,
      parentAllowedToolNames: ['read_file'],
      tools: [],
    });
    const emptyParent = await spawnAgent({
      prompt: 'parent grants nothing',
      maxSteps: 1,
      parentAllowedToolNames: [],
    });

    assert.equal(intersected.completed, true);
    assert.equal(explicitEmpty.completed, true);
    assert.equal(emptyParent.completed, true);
    assert.equal(requests.length, 3);
    assert.deepEqual(requestToolNames(requests[0]), ['read_file']);
    assert.deepEqual(requestToolNames(requests[1]), [], 'tools: [] 不得回退全局工具表');
    assert.deepEqual(requestToolNames(requests[2]), [], '父显式零权限不得回退全局工具表');
  } finally {
    __setChatCreateImpl(null);
    if (previousSubagent === undefined) delete process.env.MOCODE_SUBAGENT_ENABLED;
    else process.env.MOCODE_SUBAGENT_ENABLED = previousSubagent;
  }
});

test('skill: allowed-tools 与父 snapshot 求交，未知声明 fail closed，!cmd 无 run_command 时跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-skill-policy-test-'));
  const previousDirs = process.env.SKILLS_DIRS;
  const previousSubagent = process.env.MOCODE_SUBAGENT_ENABLED;
  process.env.SKILLS_DIRS = root;
  process.env.MOCODE_SUBAGENT_ENABLED = 'true';

  const writeSkill = (name: string, allowedTools: string, body: string): void => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `description: policy test ${name}`,
        `allowed-tools: ${allowedTools}`,
        'agent: read',
        '---',
        body,
      ].join('\n'),
      'utf8',
    );
  };

  writeSkill('narrow-skill', 'Read WebSearch', 'Inspect the requested file.');
  writeSkill('unknown-skill', 'NoSuchCapability', 'Answer without tools.');
  writeSkill('shell-skill', 'Bash', 'before !`echo SHOULD_NOT_RUN` after');
  invalidateSkillsCache();

  const requests: CapturedRequest[] = [];
  __setChatCreateImpl(async (request) => {
    requests.push(request as unknown as CapturedRequest);
    return textStream('skill done');
  });

  try {
    assert.deepEqual(mapSkillTools(undefined), { tools: null, unknown: [] });
    assert.deepEqual(mapSkillTools([]), { tools: [], unknown: [] });
    assert.deepEqual(mapSkillTools(['NoSuchCapability']), {
      tools: [],
      unknown: ['NoSuchCapability'],
    });

    const shellSkill = findSkill('shell-skill');
    assert.ok(shellSkill);
    const deniedByParent = await renderSkillBody(shellSkill, undefined, undefined, ['read_file']);
    assert.match(deniedByParent ?? '', /command injection skipped: run_command not allowed by tool policy/);
    assert.ok(!(deniedByParent ?? '').includes('SHOULD_NOT_RUN'));

    const deniedBySkill = await renderSkillBody({ ...shellSkill, allowedTools: ['Read'] }, undefined, undefined, [
      'run_command',
    ]);
    assert.match(deniedBySkill ?? '', /command injection skipped: run_command not allowed by tool policy/);
    assert.equal(existsSync(join(root, 'shell-skill', 'SHOULD_NOT_RUN')), false);

    const disallowedBySkill = await renderSkillBody(
      { ...shellSkill, disallowedTools: ['Bash'] },
      undefined,
      undefined,
      ['run_command'],
    );
    assert.match(disallowedBySkill ?? '', /command injection skipped: run_command not allowed by tool policy/);
    assert.ok(!(disallowedBySkill ?? '').includes('SHOULD_NOT_RUN'));

    const narrowOutcome = await runSkill({ name: 'narrow-skill' }, { allowedToolNames: ['read_file'] });
    const unknownOutcome = await runSkill({ name: 'unknown-skill' }, { allowedToolNames: ['read_file'] });
    assert.equal(narrowOutcome.status, 'success');
    assert.equal(unknownOutcome.status, 'success');
    assert.equal(requests.length, 2);
    assert.deepEqual(requestToolNames(requests[0]), ['read_file']);
    assert.deepEqual(requestToolNames(requests[1]), [], '全未知 allowed-tools 必须保持零工具');
  } finally {
    __setChatCreateImpl(null);
    if (previousDirs === undefined) delete process.env.SKILLS_DIRS;
    else process.env.SKILLS_DIRS = previousDirs;
    if (previousSubagent === undefined) delete process.env.MOCODE_SUBAGENT_ENABLED;
    else process.env.MOCODE_SUBAGENT_ENABLED = previousSubagent;
    invalidateSkillsCache();
    rmSync(root, { recursive: true, force: true });
  }
});

interface CapturedMessage {
  role: string;
  content?: unknown;
}

test('spawnAgent: delegation 模式逐字节复用父前缀，委派消息只追加在尾部，子 agent 与主 agent 同权', async () => {
  const previousSubagent = process.env.MOCODE_SUBAGENT_ENABLED;
  process.env.MOCODE_SUBAGENT_ENABLED = 'true';
  const requests: Array<{ messages?: CapturedMessage[]; tools?: Array<{ function: { name: string } }> }> = [];
  __setChatCreateImpl(async (body) => {
    requests.push(body as never);
    return textStream('worker done');
  });

  // 父 step 快照:系统提示 + 一轮已完成的对话(read_file 结果已在场),工具含写能力。
  const parentHistory = [
    { role: 'system', content: 'PARENT-SYSTEM-PROMPT' },
    { role: 'user', content: 'look at src/index.ts' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'r1', content: 'FILE-CONTENT-ALREADY-READ' },
  ] as never[];
  const parentTools = [
    { type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } },
    { type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } },
    { type: 'function', function: { name: 'sub-agent', description: 's', parameters: {} } },
    { type: 'function', function: { name: 'plan_update', description: 'p', parameters: {} } },
  ] as never[];

  try {
    const result = await spawnAgent({
      prompt: 'summarize the file you already read',
      maxSteps: 1,
      delegation: { history: parentHistory, tools: parentTools },
    });

    assert.equal(result.completed, true);
    assert.equal(requests.length, 1);
    const messages = requests[0].messages ?? [];
    // 前缀逐字节复用:前 4 条与父 history 完全相等(命中缓存的前提)。
    assert.deepEqual(messages.slice(0, 4), parentHistory);
    // 委派消息紧随父前缀之后、角色为 user;其后的 assistant 回复是子 agent 产出。
    const delegation = messages[parentHistory.length];
    assert.equal(delegation.role, 'user');
    const delegationText = String(delegation.content);
    assert.match(delegationText, /Sub-agent delegation/);
    assert.match(delegationText, /summarize the file you already read/);
    // 与主 agent 同权:委派消息明说能力一致,不得再出现任何限权措辞。
    assert.match(delegationText, /same full capabilities as the main agent/);
    assert.ok(!/Do NOT call|Read-only|disabled for you/i.test(delegationText), '委派消息不得再有限权措辞');
    // schema 与父 step 逐字节一致:写工具与编排工具全部保留,无任何裁剪。
    assert.deepEqual(requestToolNames(requests[0] as CapturedRequest), [
      'read_file',
      'write_file',
      'sub-agent',
      'plan_update',
    ]);
  } finally {
    __setChatCreateImpl(null);
    if (previousSubagent === undefined) delete process.env.MOCODE_SUBAGENT_ENABLED;
    else process.env.MOCODE_SUBAGENT_ENABLED = previousSubagent;
  }
});
