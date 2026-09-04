// Context Classifier:据工具名(强先验)+ 输出形状(启发)+ 兜底,选 ContextKind。
//
// 三级信号:
//  1) 名字强先验(BY_NAME 表,覆盖全部内置工具,确定性强)。
//  2) 形状启发(为 MCP 工具 / 未来工具 / 未登记工具兜底识别)。
//  3) 兜底 'passthrough'(不认识 = 不动,零行为变化)。
//
// 单一事实源风格(仿 tools/constants.ts 的 READ_TOOL_NAMES / PLAN_DISABLED_TOOLS)。
// 加新工具:在 BY_NAME 加一行;或靠形状启发自动识别。

import type { ContextKind } from './types.js';

/** 工具名 → ContextKind 的强先验表(覆盖全部内置工具)。 */
const BY_NAME: Record<string, ContextKind> = {
  // tree:路径列表 → 缩进树
  glob: 'tree',
  // search:file:line 分组
  grep: 'search',
  web_search: 'search',
  // log:分级 / 折叠 / 尾偏置
  run_command: 'log',
  // code:保行号(edit_file 依赖,最敏感)
  read_file: 'code',
  // table:列对齐
  memory_list: 'table',
  // memory:紧凑卡片
  memory_search: 'memory',
  // doc:去噪音保正文
  web_fetch: 'doc',
  use_skill: 'doc',
  // status:一行状态(identity,不动)
  edit_file: 'status',
  write_file: 'status',
  ask_human: 'status',
  memory_save: 'status',
  memory_update: 'status',
  memory_forget: 'status',
  memory_graph: 'status',
  // summary:子 agent 摘要(轻量)
  'sub-agent': 'summary',
};

/**
 * 形状启发:对未在 BY_NAME 登记的工具输出做模式识别(为 MCP / 未来工具兜底)。
 * 故意保守:识别不准时回落 passthrough(不动),宁可不少省也不可错改。
 */
function classifyByShape(output: string): ContextKind {
  // file:line: content 形(grep 风格)
  if (/^[^\n:]+:\d+:[^\n]*$/m.test(output)) return 'search';
  // [退出码 N] 前缀(run_command 风格)
  if (/^\[退出码 \d+\]/m.test(output)) return 'log';
  // 路径列表:多行都是含分隔符的相对路径(glob 风格)
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length >= 3 && lines.every((l) => /^[\w.\-\\/ ]+$/.test(l.trim()) && /[\\/]/.test(l))) {
    return 'tree';
  }
  // JSON 结构化(web_fetch 的 JSON 响应等)→ doc 渲染
  const trimmed = output.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'doc';
  return 'passthrough';
}

/**
 * 判定 ContextKind。
 *  - 有 BY_NAME 强先验 → 用之(内置工具确定性强)。
 *  - 否则形状启发(MCP / 未来工具)。
 *  - 都不中 → passthrough(不动)。
 *
 * @param toolName 工具名
 * @param output 工具原始输出(形状启发用;有 BY_NAME 时不读)
 * @param _args 已解析参数(预留:未来 read_file 的 offset/limit 可影响 code 编码策略;Phase 1 不用)
 */
export function classify(toolName: string, output: string, _args: Record<string, unknown> | null): ContextKind {
  const byName = BY_NAME[toolName];
  if (byName) return byName;
  return classifyByShape(output);
}

/** 暴露 BY_NAME 副本供调试 / 未来 /context 展示(只读视图)。 */
export function knownToolKinds(): Record<string, ContextKind> {
  return { ...BY_NAME };
}
