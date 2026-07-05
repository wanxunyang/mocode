import type { Tool } from '../types.js';
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
import { todolistTool } from './todolist.js';

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

export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  globTool,
  grepTool,
  codegraphTool,
  webSearchTool,
  webFetchTool,
  useSkillTool,
  askHumanTool,
  switchModeTool, // plan↔auto 自切(两模式都可见,不进 PLAN_DISABLED_TOOLS;副作用控制工具→串行分支)
  dropContextTool, // 运行中剔除无关 tool 结果(上下文管理,无副作用;两模式都可见,串行分支)
  ..._memoryTools,
  taskTool, // 派生子 agent(独立 history + 可受限工具集);plan 模式禁用(见 PLAN_DISABLED_TOOLS)
  todolistTool, // 工作记事本(plan 文件:复杂任务 checklist,落盘抗压缩);plan 模式可用(便于「先 plan 再 auto」时落地执行清单)
];
