/**
 * 工具模式(Tool Profile)定义——叶子模块,零依赖,不 import config。
 *
 * 模式 = 一组「工具簇(TOOL_GROUPS)」的预设组合;切换模式即切换模型可见的工具集。
 * 设计见 docs/tool-profiles-design.md。本模块只放纯数据(分组、模式、派生查询),
 * 当前激活模式的内存态在 config/index.ts(getActiveProfile/setActiveProfile)。
 *
 * 依赖方向无环:constants/llm/repl 都 import 本模块,本模块不 import 任何业务模块。
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

/** 模式 → 包含的工具簇。 */
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
