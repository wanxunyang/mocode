/** 工具共享的截断 / 上限 / 忽略规则。 */
import { isMemoryEnabled, isSubAgentEnabled, isFrontendToolsEnabled } from '../config/index.js';
import { getActiveSkill } from '../skills/activation.js';

export const MAX_FILE_LINES = 2000;
export const MAX_OUTPUT = 20000;
export const MAX_RESULTS = 100;

/** 进 history 的单条工具结果上限(字符)。push-time 第一层裁剪,保 head + 标记 + tail。 */
export const MAX_HISTORY_RESULT = 8000;
/** use_skill 结果(SKILL.md 正文)的放宽上限:指令须完整,中截会破坏语义。 */
export const MAX_SKILL_RESULT = 64000;
/** 微压缩时旧工具结果截到的存根长度(字符)。 */
export const MAX_OLD_TOOL_STUB = 600;

// ── 记忆(Tier-2 JSONL 工具库)──────────────────────────────────────────────
/** 单条记忆 body 上限(字符)。进 history 前 memory_search 结果另有 MAX_MEMORY_RESULT 兜底。 */
export const MAX_MEMORY_ENTRY = 4000;
/** 启动注入 systemPrompt 的索引条目上限(遗忘封顶后 active 条目 ≤ MAX_ACTIVE,索引再封一层)。 */
export const MAX_INDEX_ENTRIES = 50;
/** active 记忆封顶:超则按 recallCount 低 × lastRecalledAt 老 淘汰到 archived。 */
export const MAX_ACTIVE = 100;
/** 衰减:active + !pinned + (lastRecalledAt|createdAt) 早于 DECAY_DAYS → archived。 */
export const DECAY_DAYS = 30;
/** GC:archived 超 GC_DAYS → 硬删。 */
export const GC_DAYS = 90;
/** memory_search 结果(召回的记忆正文)的放宽上限:指令性内容,中截破坏语义,对齐 use_skill。 */
export const MAX_MEMORY_RESULT = 64000;

// .codegraph:codegraph 索引目录(codegraph.db 是 SQLite 二进制 + daemon.log),
// grep/glob 扫它无意义且会产出数 KB 的超长「行」,污染 TUI 展开渲染。
export const IGNORE = ['**/node_modules/**', '**/.git/**', '**/.codegraph/**'];

// ── 前端工具簇(默认关闭,显式开启)─────────────────────────────────────────
/**
 * 前端开发相关工具簇:browser / dev_server 依赖 playwright 二进制且拉起长驻进程,
 * screenshot 抓整个桌面(隐私敏感),view_image 仅视觉模型有用。这 4 个默认不进入
 * 模型工具表,由 isFrontendToolsEnabled() 单一来源控制;/fe on|off 切换。
 */
export const FRONTEND_TOOLS = new Set([
  'browser',
  'dev_server',
  'screenshot',
  'view_image',
]);



// ── plan 模式(只读规划,不执行)──────────────────────────────────────────────
/**
 * plan 模式下从工具 schema 里剔除的工具(模型根本看不到 → 调不到):
 * 写盘 / 命令 / 记忆写入类 + sub-agent（派生子 agent，plan 模式只读不可有副作用）。单一事实源,
 * 被 llm(planChatTools)与 agent(防御 backstop)共用。
 * 只读工具(read_file/glob/grep/web_search/web_fetch/use_skill/ask_human/memory_search/memory_list)保留。
 * 注:codegraph 已 skill 化(用 run_command 调 CLI),不算核心工具,不在此屏蔽集。
 */
export const PLAN_DISABLED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'screenshot',
  'dev_server',
  'browser',
  'memory_save',
  'memory_update',
  'memory_forget',
  'sub-agent',
  'run_skill', // fork 子 agent 执行面;plan 模式不应派生子工作流
]);

/**
 * 按当前 isMemoryEnabled() 现算 plan 模式应屏蔽的工具。
 * memoryEnabled=false 时记忆工具整体不在 builtinTools 里,plan 屏蔽集里也无须再列 ——
 * 反之留着只是死名字。统一过滤,避免 Set 里残留与已下架工具不一致的概念性冗余。
 * 调用方(agent/core 串行分支、llm/planChatTools)每次 chat 时调本函数拿当前值。
 */
export function getPlanDisabledTools(): Set<string> {
  const next = isMemoryEnabled()
    ? new Set<string>(PLAN_DISABLED_TOOLS)
    : (() => {
        const n = new Set<string>(PLAN_DISABLED_TOOLS);
        n.delete('memory_save');
        n.delete('memory_update');
        n.delete('memory_forget');
        return n;
      })();
  // 前端工具簇关闭时,plan 模式 schema 也一并剔除(与 auto 模式一致)。
  if (!isFrontendToolsEnabled()) {
    for (const name of FRONTEND_TOOLS) next.add(name);
  }
  return next;
}

/** auto/plan 共用的运行时功能开关防线；关闭时即使模型幻觉调用也不得执行。 */
export function getRuntimeDisabledTools(): Set<string> {
  const disabled = new Set<string>();
  if (!isSubAgentEnabled()) disabled.add('sub-agent');
  if (!isFrontendToolsEnabled()) {
    for (const name of FRONTEND_TOOLS) disabled.add(name);
  }
  // inline skill 激活态的 disallowed-tools:即便模型幻觉调用也执行不了(设计 §3.6)。
  const active = getActiveSkill();
  if (active?.disallowed) {
    for (const name of active.disallowed) disabled.add(name);
  }
  return disabled;
}
