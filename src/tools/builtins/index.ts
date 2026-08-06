import type { Tool, ToolCapabilities } from '../types.js';
import { readFileTool } from './read-file.js';
import { viewImageTool } from './view-image.js';
import { screenshotTool } from './screenshot.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { runCommandTool } from './run-command.js';
import { devServerTool } from './dev-server.js';
import { browserTool } from './browser.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webSearchTool } from './web-search.js';
import { webFetchTool } from './web-fetch.js';
import { useSkillTool } from './use-skill.js';
import { askHumanTool } from './ask-human.js';
import { planUpdateTool } from './plan-update.js';
import { memorySaveTool } from './memory-save.js';
import { memorySearchTool } from './memory-search.js';
import { memoryListTool } from './memory-list.js';
import { memoryUpdateTool } from './memory-update.js';
import { memoryForgetTool } from './memory-forget.js';
import { subAgentTool } from './task.js';

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

const pathResource = (args: Record<string, unknown>): string[] =>
  typeof args.path === 'string' && args.path ? [`file:${args.path}`] : ['workspace'];
const workspaceResource = (): string[] => ['workspace'];
const memoryResource = (): string[] => ['memory-store'];

const CAPABILITIES: Record<string, ToolCapabilities> = {
  read_file: { effect: 'read', concurrency: 'parallel', resources: pathResource },
  view_image: { effect: 'read', concurrency: 'parallel', resources: pathResource },
  screenshot: { effect: 'process', concurrency: 'serial', resources: workspaceResource, supportsAbort: true },
  write_file: { effect: 'write', concurrency: 'resource-locked', resources: pathResource, delegatesResourceLocks: true },
  edit_file: { effect: 'write', concurrency: 'resource-locked', resources: pathResource, delegatesResourceLocks: true },
  run_command: { effect: 'process', concurrency: 'serial', resources: workspaceResource, supportsAbort: true },
  // 后台进程与浏览器会话跨调用存活；串行执行避免同一页面/服务被并发操作。
  dev_server: { effect: 'process', concurrency: 'serial', resources: workspaceResource, supportsAbort: true },
  browser: { effect: 'process', concurrency: 'serial', resources: workspaceResource },
  glob: { effect: 'read', concurrency: 'parallel', resources: workspaceResource },
  grep: { effect: 'read', concurrency: 'parallel', resources: workspaceResource },
  web_search: { effect: 'network', concurrency: 'parallel', supportsAbort: true },
  web_fetch: { effect: 'network', concurrency: 'parallel', supportsAbort: true },
  use_skill: { effect: 'read', concurrency: 'serial' },
  ask_human: { effect: 'read', concurrency: 'serial' },
  // plan_update 只写内部 notes.md(session 工作面),不作为用户代码 mutation 追踪/回滚/diff;
  // 串行即可(调用不频繁),固定资源键让并发调用排队。
  plan_update: { effect: 'write', concurrency: 'serial', resources: () => ['session-notepad'] },
  memory_save: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  memory_search: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  memory_list: { effect: 'read', concurrency: 'serial', resources: memoryResource },
  memory_update: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  memory_forget: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  // sub-agent 动态协调：只读任务无锁并行；写任务在 overlay 中执行，merge 时由 ChangeSet 持 canonical lock。
  'sub-agent': {
    effect: 'write',
    concurrency: 'resource-locked',
    resources: (args) => args.mode === 'write' && Array.isArray(args.writeSet) && args.writeSet.length
      ? args.writeSet.map((item) => `file:${String(item)}`)
      : args.mode === 'write' ? ['workspace'] : [],
    delegatesResourceLocks: true,
    supportsAbort: true,
  },
};

const rawBuiltinTools: Tool[] = [
  readFileTool,
  viewImageTool,
  screenshotTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  devServerTool,
  browserTool,
  globTool,
  grepTool,
  webSearchTool,
  webFetchTool,
  useSkillTool,
  askHumanTool,
  planUpdateTool,
  ..._memoryTools,
  subAgentTool,
];

/** 所有内置工具均携带显式能力；新增工具遗漏声明时 registry 会保守串行。 */
export const builtinTools: Tool[] = rawBuiltinTools.map((tool) => ({
  ...tool,
  capabilities: CAPABILITIES[tool.name],
}));
