import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_TOOL_GROUPS_TOOL_NAME,
  COMMON_TOOL_NAMES,
  DEFAULT_ROUTE_GROUPS,
  TOOL_ROUTE_GROUPS,
  expandRouteImplications,
  type ToolRouteGroupName,
} from '../src/config/profiles.js';
import { ToolPolicyController, getAvailableToolRouteGroups, getRoutableToolRouteGroups } from '../src/tools/policy.js';
import { clearToolsExtension, registerToolsExtension, tools } from '../src/tools/registry.js';
import type { Tool } from '../src/tools/types.js';
import '../src/tools/builtins/index.js';

const ROUTE_ENV_KEYS = [
  'MOCODE_TOOL_POLICY',
  'MOCODE_SUBAGENT_ENABLED',
  'MOCODE_FRONTEND_TOOLS_ENABLED',
  'MOCODE_COMPUTER_USE_ENABLED',
  'MOCODE_MCP_ENABLED',
  'MEMORY_ENABLED',
] as const;

function isolateRouteEnv(overrides: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string>> = {}): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ROUTE_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function schemaNames(controller: ToolPolicyController, planMode = false): string[] {
  return controller.snapshot(planMode).tools.map((tool) => tool.function.name);
}

const EXPECTED_COMMON = [
  'read_file',
  'view_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'plan_update',
  'note_append',
  'ask_human',
  'use_skill',
];

test('ToolPolicy: common 集合精确且全部来自 registry；默认快照 = common + 常驻组，不泄露高危簇', () => {
  const restore = isolateRouteEnv();
  try {
    assert.deepEqual([...COMMON_TOOL_NAMES], EXPECTED_COMMON);
    const registered = new Set(tools.map((tool) => tool.name));
    for (const name of COMMON_TOOL_NAMES) assert.ok(registered.has(name), `common tool 未注册: ${name}`);
    for (const [group, definition] of Object.entries(TOOL_ROUTE_GROUPS)) {
      if (group === 'mcp') continue;
      for (const name of definition.tools) assert.ok(registered.has(name), `${group} 的工具未注册: ${name}`);
    }

    const controller = new ToolPolicyController({ id: 'policy-default', maxExpansions: 3 });
    const names = schemaNames(controller);
    // 常驻组不经过路由也必须在位:起手没有 write/run 会白付一个完整 step 去扩容。
    assert.deepEqual(controller.groupNames, [...DEFAULT_ROUTE_GROUPS]);
    assert.deepEqual(
      names.filter((name) => name !== ADD_TOOL_GROUPS_TOOL_NAME),
      [...EXPECTED_COMMON, 'write_file', 'edit_file', 'run_command'],
    );
    assert.ok(names.includes(ADD_TOOL_GROUPS_TOOL_NAME));
    for (const name of ['browser', 'computer', 'memory_save', 'screenshot', 'sub-agent']) {
      assert.ok(!names.includes(name), `默认快照不应暴露 ${name}`);
    }
    // 常驻组不在可路由集合里(选了也无效)。
    const routable = getRoutableToolRouteGroups();
    for (const group of DEFAULT_ROUTE_GROUPS) {
      assert.ok(!routable.includes(group), `${group} 是常驻组，不应出现在路由选项中`);
    }
  } finally {
    restore();
  }
});

test('ToolPolicy: capability gate 仅把显式 false 当硬否决，MCP 还要求动态工具存在', () => {
  const extensionSource = 'test-tool-policy-mcp';
  const mcpProbe: Tool = {
    name: 'mcp__policy_probe',
    description: 'policy test probe',
    parameters: { type: 'object', properties: {} },
    capabilities: { effect: 'read', concurrency: 'parallel' },
    execute: async () => 'ok',
  };
  const restore = isolateRouteEnv({
    MOCODE_SUBAGENT_ENABLED: 'false',
    MOCODE_FRONTEND_TOOLS_ENABLED: 'false',
    MOCODE_COMPUTER_USE_ENABLED: 'false',
    MOCODE_MCP_ENABLED: 'false',
    MEMORY_ENABLED: 'false',
  });
  try {
    registerToolsExtension(extensionSource, [mcpProbe]);
    const blocked = getAvailableToolRouteGroups();
    assert.ok(blocked.includes('workspace-write') && blocked.includes('shell-debug'));
    // background-exec 无 gateEnv:后台进程管理与 run_command 同级,前端开关关不掉它。
    // 这是拆簇的核心目的——dev_server 不再被 MOCODE_FRONTEND_TOOLS_ENABLED 连坐否决。
    assert.ok(blocked.includes('background-exec'), 'background-exec 应始终可路由(无 gateEnv)');
    for (const group of [
      'browser-debug',
      'desktop-observe',
      'computer-control',
      'memory-read',
      'memory-write',
      'orchestration',
      'mcp',
    ] satisfies ToolRouteGroupName[]) {
      assert.ok(!blocked.includes(group), `${group} 应被 env=false 禁止`);
    }

    process.env.MOCODE_SUBAGENT_ENABLED = 'true';
    process.env.MOCODE_FRONTEND_TOOLS_ENABLED = 'true';
    process.env.MOCODE_COMPUTER_USE_ENABLED = 'true';
    process.env.MOCODE_MCP_ENABLED = 'true';
    process.env.MEMORY_ENABLED = 'true';
    const allowed = getAvailableToolRouteGroups();
    for (const group of Object.keys(TOOL_ROUTE_GROUPS) as ToolRouteGroupName[]) {
      assert.ok(allowed.includes(group), `${group} 应可路由`);
    }

    clearToolsExtension(extensionSource);
    assert.ok(!getAvailableToolRouteGroups().includes('mcp'), '没有 mcp__* 工具时 mcp 组必须不可用');
  } finally {
    clearToolsExtension(extensionSource);
    restore();
  }
});

test('ToolPolicy: 扩容生成新版本且不改旧 snapshot，plan 始终与只读能力求交', () => {
  const restore = isolateRouteEnv({
    MOCODE_SUBAGENT_ENABLED: 'true',
    MOCODE_FRONTEND_TOOLS_ENABLED: 'true',
    MOCODE_COMPUTER_USE_ENABLED: 'true',
    MEMORY_ENABLED: 'true',
  });
  try {
    const controller = new ToolPolicyController({
      id: 'policy-expand',
      groups: [],
      reason: 'router: common only',
      confidence: 0.2,
      maxExpansions: 1,
    });
    const before = controller.snapshot(false);
    assert.equal(controller.snapshot(false), before, '未扩容时应复用 auto cache');
    assert.ok(before.allowedNames.has('run_command'), '常驻组 shell-debug 必须在位');
    assert.ok(before.allowedNames.has('write_file'), '常驻组 workspace-write 必须在位');
    assert.ok(before.allowedNames.has(ADD_TOOL_GROUPS_TOOL_NAME));

    const planBefore = controller.snapshot(true);
    assert.notEqual(planBefore, before);
    assert.ok(!planBefore.allowedNames.has('run_command'));
    assert.ok(planBefore.allowedNames.has(ADD_TOOL_GROUPS_TOOL_NAME));

    const expansion = controller.expand(['browser-debug'], 'need DOM inspection');
    const after = expansion.snapshot;
    assert.deepEqual(expansion.added, ['browser-debug']);
    assert.equal(after.version, 2);
    assert.equal(after.reason, 'need DOM inspection');
    assert.equal(after.confidence, 0.8);
    assert.ok(after.allowedNames.has('browser'));
    assert.ok(!after.allowedNames.has(ADD_TOOL_GROUPS_TOOL_NAME), '达到扩容上限后应移除控制工具');
    assert.equal(before.version, 1);
    assert.ok(!before.allowedNames.has('browser'), '旧 snapshot 不得被原地扩权');
    assert.notEqual(after, before);

    const planAfter = controller.snapshot(true);
    for (const name of ['run_command', 'write_file', 'edit_file', 'browser']) {
      assert.ok(!planAfter.allowedNames.has(name), `plan snapshot 不应暴露 ${name}`);
    }
    const rejected = controller.expand(['memory-write'], 'second expansion');
    assert.deepEqual(rejected.added, []);
    assert.deepEqual(rejected.rejected, ['expansion limit reached']);
    assert.equal(rejected.snapshot.version, 2);
  } finally {
    restore();
  }
});

test('ToolPolicy: 无有效新增不升版本，maxExpansions=0 时不暴露 add_tool_groups', () => {
  const restore = isolateRouteEnv({ MOCODE_FRONTEND_TOOLS_ENABLED: 'false' });
  try {
    const controller = new ToolPolicyController({ groups: ['workspace-write'] });
    const cached = controller.snapshot(false);
    const result = controller.expand(['workspace-write', 'not-a-group', 'browser-debug'], 'invalid expansion');
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.rejected, [
      'workspace-write: already active',
      'not-a-group: unknown group',
      'browser-debug: capability disabled or unavailable',
    ]);
    assert.equal(result.snapshot.version, 1);
    assert.equal(result.snapshot, cached, '失败扩容应保持原 cache');

    const fixed = new ToolPolicyController({ maxExpansions: 0 });
    assert.ok(!fixed.snapshot(false).allowedNames.has(ADD_TOOL_GROUPS_TOOL_NAME));
    assert.equal(fixed.canExpand, false);
  } finally {
    restore();
  }
});

test('ToolPolicy: background-exec 拆簇——dev_server 不再受前端开关否决，且被 browser-debug 蕴含带出', () => {
  const restore = isolateRouteEnv({ MOCODE_FRONTEND_TOOLS_ENABLED: 'false' });
  try {
    // 前端 gate 关掉时 background-exec 仍可路由(无 gateEnv)。
    assert.ok(getAvailableToolRouteGroups().includes('background-exec'));
    const controller = new ToolPolicyController({ id: 'policy-bg', groups: ['browser-debug'], maxExpansions: 2 });
    const names = schemaNames(controller);
    // browser-debug 被 gate=false 否决 → 不激活;但断言重点在蕴含:显式选中时 dev_server 必到。
    const open = isolateRouteEnv({ MOCODE_FRONTEND_TOOLS_ENABLED: 'true' });
    try {
      const withBrowser = new ToolPolicyController({ id: 'policy-bg2', groups: ['browser-debug'] });
      const browserNames = schemaNames(withBrowser);
      assert.ok(browserNames.includes('browser'), 'browser-debug 应带来 browser');
      assert.ok(
        browserNames.includes('dev_server'),
        'browser-debug 蕴含 background-exec → dev_server 必须一并可用(半截能力比多余能力更贵)',
      );
      assert.deepEqual([...expandRouteImplications(['browser-debug'])].sort(), ['background-exec', 'browser-debug']);
      assert.deepEqual([...expandRouteImplications(['workspace-write'])], ['workspace-write'], '无蕴含的簇原样返回');
    } finally {
      open();
    }
    assert.ok(!names.includes('browser'), 'gate=false 时 browser 不应激活');
  } finally {
    restore();
  }
});

test('ToolPolicy: expand 返回 implied 且不把蕴含簇计入 added / rejected', () => {
  const restore = isolateRouteEnv({ MOCODE_FRONTEND_TOOLS_ENABLED: 'true' });
  try {
    const controller = new ToolPolicyController({ id: 'policy-implied', groups: [], maxExpansions: 2 });
    const expansion = controller.expand(['browser-debug'], 'need web UI debugging');
    assert.deepEqual(expansion.added, ['browser-debug']);
    assert.deepEqual(expansion.implied, ['background-exec']);
    assert.deepEqual(expansion.rejected, []);
    assert.ok(expansion.snapshot.allowedNames.has('dev_server'));
    // 二次选同一簇:added 为空但 already active 进 rejected;蕴含簇已激活不重复上报。
    const again = controller.expand(['browser-debug'], 'duplicate');
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.implied, []);
    assert.deepEqual(again.rejected, ['browser-debug: already active']);
  } finally {
    restore();
  }
});

test('ToolPolicy: PLAN 对动态 MCP fail closed，AUTO 保持可用', () => {
  const extensionSource = 'test-tool-policy-plan-mcp';
  const restore = isolateRouteEnv({ MOCODE_MCP_ENABLED: 'true' });
  const mcpProbe: Tool = {
    name: 'mcp__plan_policy_probe',
    description: 'unknown-effect MCP probe for plan policy regression',
    parameters: { type: 'object', properties: {} },
    capabilities: { effect: 'unknown', concurrency: 'serial' },
    execute: async () => 'ok',
  };

  try {
    registerToolsExtension(extensionSource, [mcpProbe]);
    const controller = new ToolPolicyController({
      id: 'policy-plan-mcp',
      groups: ['mcp'],
      maxExpansions: 0,
    });
    const auto = controller.snapshot(false);
    const plan = controller.snapshot(true);

    assert.ok(auto.allowedNames.has(mcpProbe.name));
    assert.ok(auto.tools.some((tool) => tool.function.name === mcpProbe.name));
    assert.ok(!plan.allowedNames.has(mcpProbe.name));
    assert.ok(!plan.tools.some((tool) => tool.function.name === mcpProbe.name));
  } finally {
    clearToolsExtension(extensionSource);
    restore();
  }
});
