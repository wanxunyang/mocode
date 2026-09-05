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
      mode: 'read',
      maxSteps: 1,
      parentAllowedToolNames: ['read_file'],
      tools: ['read_file', 'web_search'],
    });
    const explicitEmpty = await spawnAgent({
      prompt: 'answer without tools',
      mode: 'read',
      maxSteps: 1,
      parentAllowedToolNames: ['read_file'],
      tools: [],
    });
    const emptyParent = await spawnAgent({
      prompt: 'parent grants nothing',
      mode: 'read',
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
