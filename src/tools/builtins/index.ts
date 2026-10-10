import type { Tool, ToolCapabilities } from '../types.js';
import { installBuiltinTools } from '../registry.js';
import { readFileTool } from './read-file.js';
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
import { runSkillTool } from './run-skill.js';
import { askHumanTool } from './ask-human.js';
import { planUpdateTool } from './plan-update.js';
import { noteAppendTool } from './note-append.js';
import { memorySaveTool } from './memory-save.js';
import { memorySearchTool } from './memory-search.js';
import { memoryListTool } from './memory-list.js';
import { memoryUpdateTool } from './memory-update.js';
import { memoryForgetTool } from './memory-forget.js';
import { memoryGraphTool } from './memory-graph.js';
import { subAgentTool } from './task.js';
import { arenaTool } from './arena.js';
import { messageBusTool } from './message-bus.js';
import { computerTool } from './computer.js';
import { runFlowTool } from './run-flow.js';
import { sessionSearchTool } from './session-search.js';

/**
 * 所有内置工具,按注册顺序排列。
 * 加新工具:在本目录新建 `xxx.ts` 导出一个 Tool,再在下面数组里加一行。无需改 agent / llm。
 *
 * memory_* 始终注册进 registry（JSONL store 仍为懒加载）；主 Agent 是否看见它们由每 turn
 * ToolPolicy 的 memory-read / memory-write 簇决定，MEMORY_ENABLED=false 可作 capability veto。
 * 未传 ToolPolicy 的旧嵌入调用仍走 legacy profile 过滤。
 */

const pathResource = (args: Record<string, unknown>): string[] =>
  typeof args.path === 'string' && args.path ? [`file:${args.path}`] : ['workspace'];
const workspaceResource = (): string[] => ['workspace'];
const memoryResource = (): string[] => ['memory-store'];

/** 导出供审计测试:能力声明是单一事实源,测试直接断言这张表(而非重新枚举一遍工具名)。 */
export const CAPABILITIES: Record<string, ToolCapabilities> = {
  read_file: { effect: 'read', concurrency: 'parallel', resources: pathResource },
  screenshot: { effect: 'process', concurrency: 'serial', resources: workspaceResource, supportsAbort: true },
  write_file: {
    effect: 'write',
    concurrency: 'resource-locked',
    resources: pathResource,
    delegatesResourceLocks: true,
  },
  edit_file: { effect: 'write', concurrency: 'resource-locked', resources: pathResource, delegatesResourceLocks: true },
  run_command: { effect: 'process', concurrency: 'serial', resources: workspaceResource, supportsAbort: true },
  // 后台进程与浏览器会话跨调用存活；串行执行避免同一页面/服务被并发操作。
  dev_server: { effect: 'process', concurrency: 'serial', resources: workspaceResource, supportsAbort: true },
  browser: { effect: 'process', concurrency: 'serial', resources: workspaceResource },
  // glob/grep 不取任何资源锁:读枚举容忍命令执行期间的瞬时不一致(一次目录扫描的结果
  // 本来就无事务语义),换取「一条 run_command/dev_server 持 workspace 写锁期间,只读
  // 枚举与并行子 agent 的读不被全面压制」。网络只读同理不锁。
  //
  // read_file 不在此列:它取 file:<path> 读锁(读单个**已知**文件,与目录枚举的
  // 瞬时不一致不同层级)。2026-10-05 起 resource-lock 的 requestConflicts 放行了
  // 「workspace 写锁 vs 资源读锁」这一格,所以 run_command 期间 read_file 不再排队;
  // 但 read_file 仍与 write_file/edit_file 的 file 写锁互斥(见 resource-lock.ts 的冲突矩阵)。
  glob: { effect: 'read', concurrency: 'parallel', resources: (): string[] => [], supportsAbort: true },
  grep: { effect: 'read', concurrency: 'parallel', resources: (): string[] => [], supportsAbort: true },
  // 网络只读查询:无副作用,可安全重复执行 → idempotent 让 runtime 对瞬时失败(429/5xx/超时/
  // 网络抖动)自动退避重试,省掉模型「再发一轮 tool call 自救」的往返。写/进程类工具绝不置此位。
  web_search: { effect: 'network', concurrency: 'parallel', supportsAbort: true, idempotent: true },
  web_fetch: { effect: 'network', concurrency: 'parallel', supportsAbort: true, idempotent: true },
  use_skill: { effect: 'read', concurrency: 'serial' },
  run_skill: { effect: 'process', concurrency: 'serial', delegatesResourceLocks: true, supportsAbort: true },
  ask_human: { effect: 'read', concurrency: 'serial' },
  // plan_update 只写内部 notes.md(session 工作面),不作为用户代码 mutation 追踪/回滚/diff;
  // 串行即可(调用不频繁),固定资源键让并发调用排队。
  plan_update: { effect: 'write', concurrency: 'serial', resources: () => ['session-notepad'] },
  // note_append 与 plan_update 同款:只写内部 notes.md 笔记段,不作 project mutation 追踪/diff/回滚;串行 + 固定资源键排队。
  note_append: { effect: 'write', concurrency: 'serial', resources: () => ['session-notepad'] },
  memory_save: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  memory_search: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  memory_list: { effect: 'read', concurrency: 'serial', resources: memoryResource },
  memory_update: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  memory_forget: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  // memory_graph:search/neighbors/stats 只读、add 写,统一按写处理走串行(调用不频繁,简化)。
  memory_graph: { effect: 'write', concurrency: 'serial', resources: memoryResource },
  // session_search 只读归档索引,纯本地无副作用;串行(每次重建 BM25 索引,避免并发交错)。
  session_search: { effect: 'read', concurrency: 'serial' },
  // computer 桌面操控:桌面状态全局唯一,任何两个 computer 调用都不允许并发;
  // effect=process(不写工作区文件,不触发 rollback/diff 追踪),supportsAbort 中断长 wait/拖拽。
  computer: { effect: 'process', concurrency: 'serial', resources: () => ['desktop'], supportsAbort: true },
  // run_flow 回放录制的桌面流程:内部直接驱动 computer,同样独占 desktop 资源,可中断。
  run_flow: { effect: 'process', concurrency: 'serial', resources: () => ['desktop'], supportsAbort: true },
  // sub-agent 与主 agent 同权,直接写工作区(无 overlay)。编排器本身不持锁——锁由嵌套工具
  // 各自获取,否则子 agent 内的 run_command 会等父持有的 workspace 锁而自锁。
  // parallelOrchestration:同一轮派发的多个子 agent 按 subAgentConcurrency 上限成批并行
  // (调度见 tool-helpers.isParallelOrchestrationCall 与 run-coordinator 的编排批);
  // isResourceLockedCall 仍显式排除 sub-agent,使其不混入 file-mutation 批。
  'sub-agent': {
    effect: 'write',
    concurrency: 'resource-locked',
    delegatesResourceLocks: true,
    parallelOrchestration: true,
    supportsAbort: true,
  },
  // arena:一次调用内部并行 spawnAgent 出多个候选 + 一次 judge(见 ./arena.ts)。与 sub-agent 同理:
  // 资源锁委派给内层 spawn 出的工具,否则 arena 自持 workspace 写锁会与候选内 run_command 自锁;
  // 候选直接写共享工作区 → effect=write;它是单个工具调用,不置 parallelOrchestration(那是跨调用批)。
  arena: { effect: 'write', concurrency: 'serial', delegatesResourceLocks: true, supportsAbort: true },
  // message_bus:读写 .mocode/bus 下的内部消息文件(send 写 / inbox·ack·history 多为读),不触碰
  // 项目代码;用独立 message-bus 资源键串行(类比 memory-store),不作项目 mutation 追踪/回滚。
  message_bus: { effect: 'write', concurrency: 'serial', resources: () => ['message-bus'] },
};

const rawBuiltinTools: Tool[] = [
  readFileTool,
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
  runSkillTool,
  askHumanTool,
  planUpdateTool,
  noteAppendTool,
  memorySaveTool,
  memorySearchTool,
  memoryListTool,
  memoryUpdateTool,
  memoryForgetTool,
  memoryGraphTool,
  subAgentTool,
  arenaTool,
  messageBusTool,
  computerTool,
  runFlowTool,
  sessionSearchTool,
];

/** 所有内置工具均携带显式能力；新增工具遗漏声明时 registry 会保守串行。 */
export const builtinTools: Tool[] = rawBuiltinTools.map((tool) => ({
  ...tool,
  capabilities: CAPABILITIES[tool.name],
}));

// 自注册:registry 不再顶层 import builtins(破模块循环,见 registry.ts 顶部注释),改为本模块
// 初始化时把官方默认工具包注入注册表。registry→builtins 边已断,此处调 installBuiltinTools 时
// registry 模块必已完成求值,无 TDZ 风险。装配方(CLI/stdio host/eval/测试)import 本模块即完成装配。
installBuiltinTools(builtinTools);
