/**
 * 工具能力分组的叶子模块。生产主路径使用 COMMON_TOOL_NAMES + TOOL_ROUTE_GROUPS 进行
 * 每 turn LLM 自动路由；文件尾的静态 profile 仅保留给未迁移嵌入调用，不再有用户命令。
 * 本模块零业务依赖，供 config/llm/policy 安全共享。
 */

/** 工具簇:按职责把内置工具分组,模式由簇组合而成。 */
export type ToolGroup =
  | 'core-read'
  | 'core-write'
  | 'agent-meta'
  | 'web'
  | 'frontend'
  | 'computer'
  | 'memory'
  | 'subagent';

export type ProfileName = 'coding' | 'frontend' | 'computer-use' | 'research' | 'full';

/**
 * 工具簇 → 工具名。新增工具时归到对应簇;一个工具只属一个簇。
 * view_image 放 core-read,保证所有模式都能读取已有本地图片;工具产生的即时视觉结果通过
 * modelAttachments 直接回灌,不依赖 view_image。screenshot 留 frontend(抓整个桌面,隐私敏感,
 * 主要服务前端联调)。
 */
export const TOOL_GROUPS: Record<ToolGroup, readonly string[]> = {
  'core-read': ['read_file', 'view_image', 'glob', 'grep'],
  'core-write': ['write_file', 'edit_file', 'run_command'],
  'agent-meta': ['plan_update', 'note_append', 'ask_human', 'use_skill', 'run_skill'],
  web: ['web_search', 'web_fetch'],
  frontend: ['browser', 'dev_server', 'screenshot'],
  computer: ['computer'],
  memory: ['memory_save', 'memory_search', 'memory_list', 'memory_update', 'memory_forget', 'memory_graph'],
  subagent: ['sub-agent'],
};

// ── LLM 自动工具路由 ──────────────────────────────────────────────────────

/** 主 Agent 每一步都可见的低风险、高复用工具。 */
export const COMMON_TOOL_NAMES = [
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
] as const;

/** 主模型用于在执行中单向扩容工具面的虚拟控制工具；不进入 registry。 */
export const ADD_TOOL_GROUPS_TOOL_NAME = 'add_tool_groups' as const;

export type ToolRouteGroupName =
  | 'workspace-write'
  | 'shell-debug'
  | 'browser-debug'
  | 'desktop-observe'
  | 'computer-control'
  | 'memory-read'
  | 'memory-write'
  | 'orchestration'
  | 'mcp';

export interface ToolRouteGroupDefinition {
  /** 静态内置工具；mcp 组在运行时按 mcp__ 前缀发现。 */
  tools: readonly string[];
  /** 提供给路由 LLM 的能力边界说明。 */
  description: string;
  /** 旧开关作为 capability gate；显式 false 时路由器不得启用。 */
  gateEnv?: string;
}

/**
 * 可组合工具簇目录。路由器选择的是簇而不是单个工具；一个 turn 内只允许追加、不允许缩减。
 * doing/debug/computer 场景刻意拆开文件写入、命令执行、浏览器调试和桌面控制，避免为完成
 * 一个窄任务直接暴露 full 工具集。
 */
export const TOOL_ROUTE_GROUPS: Record<ToolRouteGroupName, ToolRouteGroupDefinition> = {
  'workspace-write': {
    tools: ['write_file', 'edit_file'],
    description: 'Create or edit workspace files for implementation, fixes, refactors, or generated code.',
  },
  'shell-debug': {
    tools: ['run_command'],
    description: 'Run tests, builds, linters, Git, package managers, logs, diagnostics, and foreground commands.',
  },
  'browser-debug': {
    tools: ['browser', 'dev_server'],
    description: 'Start local development servers and debug web UIs through DOM, console, network, and page sessions.',
    gateEnv: 'MOCODE_FRONTEND_TOOLS_ENABLED',
  },
  'desktop-observe': {
    tools: ['screenshot'],
    description: 'Capture the whole desktop or system dialogs without controlling mouse or keyboard.',
    gateEnv: 'MOCODE_FRONTEND_TOOLS_ENABLED',
  },
  'computer-control': {
    tools: ['computer'],
    description: 'Control real desktop applications with mouse, keyboard, scrolling, and visual feedback.',
    gateEnv: 'MOCODE_COMPUTER_USE_ENABLED',
  },
  'memory-read': {
    tools: ['memory_search', 'memory_list'],
    description: 'Recall cross-session project facts, decisions, conventions, and prior context.',
    gateEnv: 'MEMORY_ENABLED',
  },
  'memory-write': {
    tools: ['memory_save', 'memory_update', 'memory_forget', 'memory_graph'],
    description: 'Persist, revise, forget, or link cross-session knowledge when the user explicitly requests it.',
    gateEnv: 'MEMORY_ENABLED',
  },
  orchestration: {
    tools: ['sub-agent', 'run_skill'],
    description: 'Delegate genuinely independent work or execute a packaged fork skill in an isolated worker.',
    gateEnv: 'MOCODE_SUBAGENT_ENABLED',
  },
  mcp: {
    tools: [],
    description: 'Use connected MCP extension tools when their server capabilities directly match the task.',
    gateEnv: 'MOCODE_MCP_ENABLED',
  },
};

export const TOOL_ROUTE_GROUP_NAMES = Object.keys(TOOL_ROUTE_GROUPS) as ToolRouteGroupName[];

export function isToolRouteGroupName(value: unknown): value is ToolRouteGroupName {
  return typeof value === 'string' && (TOOL_ROUTE_GROUP_NAMES as string[]).includes(value);
}

/** 返回簇内实际工具名；MCP 工具由运行时注册表动态发现。 */
export function getToolRouteGroupNames(
  group: ToolRouteGroupName,
  registeredNames: readonly string[] = [],
): readonly string[] {
  return group === 'mcp' ? registeredNames.filter((name) => name.startsWith('mcp__')) : TOOL_ROUTE_GROUPS[group].tools;
}

/** 模式 → 包含的工具簇。保留旧 profile 数据仅供迁移期兼容；主 Agent 已改用 ToolPolicy。 */
export const PROFILE_GROUPS: Record<ProfileName, readonly ToolGroup[]> = {
  // 默认:写码 + 联网检索,无浏览器自动化/桌面/记忆,兼顾日常效率与 token 成本。
  coding: ['core-read', 'core-write', 'agent-meta', 'web'],
  // 前端联调:coding 能力 + 结构化 browser/dev_server/独立 screenshot。
  frontend: ['core-read', 'core-write', 'agent-meta', 'web', 'frontend'],
  // 通用桌面 GUI 操控:coding 能力 + 自带视觉闭环的 computer;不等价包含 frontend。
  'computer-use': ['core-read', 'core-write', 'agent-meta', 'web', 'computer'],
  // 项目源码只读调研:不直接暴露 core-write;仍可写 session note/memory,skill 有独立执行语义。
  research: ['core-read', 'agent-meta', 'web', 'memory'],
  // 全量:所有簇。
  full: ['core-read', 'core-write', 'agent-meta', 'web', 'frontend', 'computer', 'memory', 'subagent'],
};

export const PROFILE_NAMES = Object.keys(PROFILE_GROUPS) as ProfileName[];

export function isProfileName(v: unknown): v is ProfileName {
  return typeof v === 'string' && (PROFILE_NAMES as string[]).includes(v);
}

/** 模式包含的工具名集合。 */
export function getProfileToolNames(profile: ProfileName): Set<string> {
  const out = new Set<string>();
  for (const g of PROFILE_GROUPS[profile]) {
    for (const name of TOOL_GROUPS[g]) out.add(name);
  }
  return out;
}

/** 某模式是否含某簇(派生查询的单一事实源)。 */
export function profileHasGroup(profile: ProfileName, group: ToolGroup): boolean {
  return PROFILE_GROUPS[profile].includes(group);
}
