import type { Tool, ToolCapabilities } from '../types.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { runCommandTool } from './run-command.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webSearchTool } from './web-search.js';
import { webFetchTool } from './web-fetch.js';
import { useSkillTool } from './use-skill.js';
import { askHumanTool } from './ask-human.js';
import { codegraphTool } from './codegraph.js';
import { switchModeTool } from './switch-mode.js';
import { dropContextTool } from './drop-context.js';
import { memorySaveTool } from './memory-save.js';
import { memorySearchTool } from './memory-search.js';
import { memoryListTool } from './memory-list.js';
import { memoryUpdateTool } from './memory-update.js';
import { memoryForgetTool } from './memory-forget.js';
import { taskTool } from './task.js';
import { projectSkillUpdateTool } from './project-skill-update.js';
import { applyPatchTool } from './apply-patch.js';

/**
 * 所有内置工具,按注册顺序排列。
 * 加新工具:在本目录新建 `xxx.ts` 导出一个 Tool,再在下面数组里加一行。无需改 agent / llm。
 *
 * 记忆子系统总开关(MEMORY_ENABLED !== 'true'):5 个 memory_* 工具整体不进 builtinTools,
 * 进而不进 LLM 的工具表(模型根本看不到、也不会想着去调)。运行时通过 /memory_switch 切;
 * 切换对当前会话的 tool list 不重算(取的是模块初始化时的快照),所以需要重启 REPL 才生效
 * —— 这是有意为之,避免切开关瞬间把已发出请求的工具列表打乱。
 *
 * 注:这里直接读 env(MEMORY_ENABLED)而不是调 config.isMemoryEnabled(),因为本模块可能在
 * config 单例尚未初始化时被其它模块拉起(import 链路:tools/registry → builtinTools,
 * config 单例字段 getter 在 getPlanDisabledTools 等调用链路上 lazy 求值)。
 */
const _memoryEnabledAtBoot = process.env.MEMORY_ENABLED === 'true';
const _memoryTools = _memoryEnabledAtBoot
  ? [
      memorySaveTool,
      memorySearchTool,
      memoryListTool,
      memoryUpdateTool,
      memoryForgetTool,
    ]
  : [];

/** 项目专属 Skill 工具:仅在 MOCODE_PROJECT_SKILL=true 时注册,与 memory 同模式。 */
const _projectSkillEnabledAtBoot = process.env.MOCODE_PROJECT_SKILL === 'true';
const _projectSkillTools = _projectSkillEnabledAtBoot
  ? [projectSkillUpdateTool]
  : [];

const pathResource = (args: Record<string, unknown>): string[] =>
  typeof args.path === 'string' && args.path ? [`file:${args.path}`] : ['workspace'];
const workspaceResource = (): string[] => ['workspace'];
const memoryResource = (): string[] => ['memory-store'];

const CAPABILITIES: Record<string, ToolCapabilities> = {
  read_file: { effect: 'read', concurrency: 'parallel', retry: 'safe', resources: pathResource },
  write_file: { effect: 'write', concurrency: 'resource-locked', retry: 'never', resources: pathResource, delegatesResourceLocks: true },
  edit_file: { effect: 'write', concurrency: 'resource-locked', retry: 'never', resources: pathResource, delegatesResourceLocks: true },
  apply_patch: { effect: 'write', concurrency: 'resource-locked', retry: 'never', resources: workspaceResource, delegatesResourceLocks: true },
  run_command: { effect: 'process', concurrency: 'serial', retry: 'never', resources: workspaceResource, supportsAbort: true },
  glob: { effect: 'read', concurrency: 'parallel', retry: 'safe', resources: workspaceResource },
  grep: { effect: 'read', concurrency: 'parallel', retry: 'safe', resources: workspaceResource },
  codegraph: { effect: 'read', concurrency: 'parallel', retry: 'safe', resources: workspaceResource, supportsAbort: true },
  web_search: { effect: 'network', concurrency: 'parallel', retry: 'safe', supportsAbort: true },
  web_fetch: { effect: 'network', concurrency: 'parallel', retry: 'safe', supportsAbort: true },
  use_skill: { effect: 'read', concurrency: 'serial', retry: 'safe' },
  ask_human: { effect: 'read', concurrency: 'serial', retry: 'never' },
  switch_mode: { effect: 'write', concurrency: 'serial', retry: 'never', resources: () => ['agent-mode'] },
  drop_context: { effect: 'write', concurrency: 'serial', retry: 'never', resources: () => ['conversation-context'] },
  memory_save: { effect: 'write', concurrency: 'serial', retry: 'never', resources: memoryResource },
  memory_search: { effect: 'write', concurrency: 'serial', retry: 'never', resources: memoryResource },
  memory_list: { effect: 'read', concurrency: 'serial', retry: 'safe', resources: memoryResource },
  memory_update: { effect: 'write', concurrency: 'serial', retry: 'never', resources: memoryResource },
  memory_forget: { effect: 'write', concurrency: 'serial', retry: 'never', resources: memoryResource },
  project_skill_update: { effect: 'write', concurrency: 'serial', retry: 'never', resources: workspaceResource },
  // task 只编排子 Agent；真实读写由子调用自行持锁，父调用不得包 workspace 锁。
  task: {
    effect: 'write',
    concurrency: 'serial',
    retry: 'never',
    resources: workspaceResource,
    delegatesResourceLocks: true,
    supportsAbort: true,
  },
};

const rawBuiltinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  runCommandTool,
  globTool,
  grepTool,
  codegraphTool,
  webSearchTool,
  webFetchTool,
  useSkillTool,
  askHumanTool,
  switchModeTool,
  dropContextTool,
  ..._memoryTools,
  ..._projectSkillTools,
  taskTool,
];

/** 所有内置工具均携带显式能力；新增工具遗漏声明时 registry 会保守串行。 */
export const builtinTools: Tool[] = rawBuiltinTools.map((tool) => ({
  ...tool,
  capabilities: CAPABILITIES[tool.name],
}));
