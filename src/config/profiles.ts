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
 * 图片读取由 read_file 的魔数嗅探分支覆盖(原 view_image 已并入):文本/图片分流,
 * 工具产生的即时视觉结果通过 modelAttachments 直接回灌。screenshot 留 frontend(抓整个
 * 桌面,隐私敏感,主要服务前端联调)。
 * dev_server 归 core-write 而非 frontend:它是「后台进程管理」能力(与 run_command 同级),
 * 不是浏览器工具,不该受 MOCODE_FRONTEND_TOOLS_ENABLED 否决。与自动路由的 background-exec
 * 组(无 gateEnv)语义对齐。
 */
export const TOOL_GROUPS: Record<ToolGroup, readonly string[]> = {
  'core-read': ['read_file', 'glob', 'grep'],
  'core-write': ['write_file', 'edit_file', 'run_command', 'dev_server'],
  'agent-meta': ['plan_update', 'note_append', 'ask_human', 'use_skill', 'run_skill'],
  web: ['web_search', 'web_fetch'],
  frontend: ['browser', 'screenshot'],
  computer: ['computer'],
  memory: [
    'memory_save',
    'memory_search',
    'memory_list',
    'memory_update',
    'memory_forget',
    'memory_graph',
    'session_search',
  ],
  subagent: ['sub-agent'],
};

// ── LLM 自动工具路由 ──────────────────────────────────────────────────────

/** 主 Agent 每一步都可见的低风险、高复用工具。
 *  图片读取并入 read_file(魔数嗅探分流,原 view_image 已移除)。 */
export const COMMON_TOOL_NAMES = [
  'read_file',
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
  | 'background-exec'
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
 *
 * 注意:router.ts 的 Routing rules / Examples 里各有一份逐组启发式(本文件
 * description 的强化版),修改/新增组的语义时三处需同步维护。
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
  // dev_server 从 browser-debug 拆出:它的能力是「跨工具调用存活的后台进程 + 日志 + 树杀」,
  // 服务对象远不止前端联调(推理服务、watcher、log tail、任意长驻命令)。留在 browser-debug 时
  // 受 MOCODE_FRONTEND_TOOLS_ENABLED 否决、且组描述只提 DOM/console,路由 LLM 对「起个服务」
  // 类任务几乎不会选它 —— 模型于是退回 run_command 前台阻塞(120s 超时)或 start /b 脱离启动,
  // 之后既拿不到日志也没法优雅 kill。故独立成组且**无 gateEnv**:与 shell-debug 同级、永远可路由。
  'background-exec': {
    tools: ['dev_server'],
    description:
      'Run any long-running background process that must outlive a single tool call — dev servers, inference/model services, watchers, log tails, message queues. Provides process id, incremental log reads, readiness wait, and process-tree termination.',
  },
  'browser-debug': {
    tools: ['browser'],
    description: 'Debug web UIs through DOM, console, network, and page sessions in a real browser.',
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

/**
 * 簇蕴含关系:选中 key 簇时自动带上 value 里的簇(仍受各自 gateEnv 否决)。
 *
 * 存在的理由是「能力半截」比「能力多余」更贵:browser-debug 只给浏览器,而被调试的页面
 * 得先有人把它跑起来。弱模型只选 browser-debug 时,它要么白付一个 step 去 add_tool_groups
 * 扩容 background-exec,要么退回 run_command 前台起服务(120s 超时被杀 / 拿不到日志)。
 * 蕴含在 policy 层解析,router 的 Examples 仍要求显式列出两者(让强模型学会正确归因)。
 */
export const TOOL_ROUTE_IMPLICATIONS: Partial<Record<ToolRouteGroupName, readonly ToolRouteGroupName[]>> = {
  'browser-debug': ['background-exec'],
};

/** 展开蕴含:传入簇集合 → 并上其蕴含簇。纯函数、幂等(蕴含不再递归展开第二层)。 */
export function expandRouteImplications(groups: Iterable<ToolRouteGroupName>): Set<ToolRouteGroupName> {
  const out = new Set<ToolRouteGroupName>(groups);
  for (const group of [...out]) {
    for (const implied of TOOL_ROUTE_IMPLICATIONS[group] ?? []) out.add(implied);
  }
  return out;
}

/**
 * 常驻工具簇:每个 turn 无条件激活,不经过 LLM 路由(路由只需在「可用簇 − 常驻簇」里挑)。
 * 入选标准:高频(coding agent 多数 turn 都要)+ 低暴露成本(工具少、schema 短)+ 漏判代价高
 * (起手没有 write/run 会白付一个完整 model step 去 add_tool_groups,比路由本身还贵)。
 * 高危/低频/不可自发现的簇(mcp、computer-control、memory-write、browser-debug、
 * desktop-observe、orchestration)仍然必须走路由,不能进这里。
 * PLAN 模式由 PLAN_DISABLED_TOOLS 剔除这些工具,只读语义不受影响。
 * 注意:改这里要同步 router.ts 的 Routing rules / Examples(那两份是逐组启发式)。
 */
export const DEFAULT_ROUTE_GROUPS: readonly ToolRouteGroupName[] = ['workspace-write', 'shell-debug'];

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
