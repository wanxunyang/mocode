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
import { memorySaveTool } from './memory-save.js';
import { memorySearchTool } from './memory-search.js';
import { memoryListTool } from './memory-list.js';
import { memoryUpdateTool } from './memory-update.js';
import { memoryForgetTool } from './memory-forget.js';
import { taskTool } from './task.js';

/**
 * 所有内置工具,按注册顺序排列。
 * 加新工具:在本目录新建 `xxx.ts` 导出一个 Tool,再在下面数组里加一行。无需改 agent / llm。
 */
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
  memorySaveTool,
  memorySearchTool,
  memoryListTool,
  memoryUpdateTool,
  memoryForgetTool,
  taskTool, // 派生子 agent(独立 history + 可受限工具集);plan 模式禁用(见 PLAN_DISABLED_TOOLS)
];
