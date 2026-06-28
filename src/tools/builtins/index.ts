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

/**
 * 所有内置工具,按注册顺序排列。
 * 加新工具:在本目录新建 `xxx.ts` 导出一个 Tool,再在下面数组里加一行。
 */
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  globTool,
  grepTool,
  webSearchTool,
  webFetchTool,
  useSkillTool,
];
