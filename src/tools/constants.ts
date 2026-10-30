/** 工具共享的截断 / 上限 / 忽略规则。 */
import {
  getActiveProfile,
  isMemoryEnabled,
  isSubAgentEnabled,
  isFrontendToolsEnabled,
  isComputerUseEnabled,
} from '../config/index.js';
import { getProfileToolNames, TOOL_GROUPS } from '../config/profiles.js';
import { getActiveSkill } from '../skills/activation.js';

export const MAX_FILE_LINES = 2000;
export const MAX_OUTPUT = 20000;
export const MAX_RESULTS = 100;

/**
 * read_file 命中图片分支时 output 的前缀。
 *
 * 放在 constants(叶子模块)而不是 builtins/read-file.ts:ui/render.ts 要用它把摘要
 * 从「N 行」改成「图片已附加」,而 render.ts → builtins → registry 会绕出模块循环。
 */
export const IMAGE_READ_MARKER = '[image]';

/**
 * 进 history 的单条工具结果上限(字符)。push-time 第一层裁剪,保 head + 标记 + tail。
 * 32000 ≈ 9k~19k token(视内容密度),对 256k 窗口 <8%:足以让「一次读一个完整大文件/大段代码」
 * 完整进上下文(旧值 8000 只覆盖 25~30% 窗口占比 1~2%,曾迫使模型分批小读 + 引发幽灵区间事故)。
 * 防爆责任后移给分层清理:微压缩存根 → 60% 低压(REFETCHABLE)→ 80% 高压 LLM 摘要。
 */
export const MAX_HISTORY_RESULT = 32000;
/** use_skill 结果(SKILL.md 正文)的放宽上限:指令须完整,中截会破坏语义。 */
export const MAX_SKILL_RESULT = 64000;
/** 微压缩时旧工具结果截到的存根长度(字符)。 */
export const MAX_OLD_TOOL_STUB = 600;

// ── 磁盘侧治理(见 session/store.ts)──────────────────────────────────────
/** trace.jsonl 单文件大小上限(字节):超过即把整份 gzip 轮转为 trace.N.jsonl.gz 并清空。
 *  trace 是纯诊断数据,可激进轮转;512KB 约含千余条事件。 */
export const MAX_TRACE_BYTES = 512 * 1024;
/** 保留的历史 trace 轮转份数(trace.1 .. trace.N),更老的硬删。 */
export const MAX_TRACE_ROTATIONS = 3;
/** compacted/ 压缩归档目录总量上限(字节):旧区原文逐段累积,超了从最老 seg 淘汰。
 *  段大小与窗口正相关(200k 窗口单段约几百 KB),10MiB 约覆盖十几~几十次压缩。
 *  可用 MOCODE_MAX_COMPACTED_BYTES 覆盖(测试/小盘用)。 */
export const MAX_COMPACTED_ARCHIVE_BYTES = 10 * 1024 * 1024;
/** rollback snapshots 压缩前滚动窗口:无论是否 compact,仅保留最近 N 个 user turn 的快照。 */
export const MAX_SNAPSHOT_TURNS = 50;

// ── 上下文压缩摘要(见 session/compact.ts defaultSummarize)────────────────
/** 摘要输入单条消息封顶:逐条封顶保证每轮对话都有代表,替代整段中截(会切掉中间整轮)。
 *  转录总量超 SUMMARY_TRANSCRIPT_WINDOW_RATIO 时,这些封顶会被等比缩小重拼。 */
export const SUMMARY_MSG_MAX_CHARS = {
  user: 3000, // 用户原话价值最高,给大额度
  assistant: 1600,
  tool: 800,
  other: 2000,
};
/** 摘要转录总预算占上下文窗口的比例:超预算时等比缩小单条封顶重拼——
 *  优先保消息条数(每轮都有代表),其次才保单条长度。 */
export const SUMMARY_TRANSCRIPT_WINDOW_RATIO = 0.55;
/** 摘要输出硬上限(字符):模型不听话产出超长摘要时按段落边界裁,防摘要本身撑大 history。 */
export const SUMMARY_OUTPUT_MAX_CHARS = 6000;
// ── 跨代钉住的 Key Facts 预算(见 compact.ts mergeKeyFacts)────────────────
/** 占窗口比例。按「字符≈token」的保守换算(中文 1 字≈1 token),取 summary 层的一半。 */
export const SUMMARY_KEYFACTS_WINDOW_RATIO = 0.05;
/** 小窗口下的绝对下限:首轮约束通常就几条,32k 窗口按比例只有 1.6k 也得保住。 */
export const SUMMARY_KEYFACTS_MIN_CHARS = 1200;
/** 大窗口下的绝对上限:Key Facts 是索引不是正文,不该无限膨胀。 */
export const SUMMARY_KEYFACTS_MAX_CHARS = 8000;

// ── user 意图结构化保护(见 compact.ts compactHistory / extractUserDirectives)──
/** user 逐字保留通道占窗口比例:user 意图是任务之根,摘要转述只是尽力而为
 *  (COMPINT 实测摘要器平均只保留 17% 的用户会话约束);给专属逐字预算绕过摘要器,
 *  预算内的 user 原文直接进保留区,不依赖任何模型自觉。 */
export const COMPACT_USER_VERBATIM_WINDOW_RATIO = 0.1;
/** user 逐字通道绝对上限(token):对齐 Codex CLI 的 20k user 逐字预算。 */
export const COMPACT_USER_VERBATIM_MAX_TOKENS = 20_000;
/** 意图/约束账本:单条意图行截断(字符)。 */
export const USER_DIRECTIVE_MAX_CHARS = 160;
/** 意图/约束账本:单条 user 消息最多抽取的约束行数(防长消息刷爆账本)。 */
export const USER_DIRECTIVE_MAX_CONSTRAINTS = 3;

// ── 记忆(Tier-2 JSONL 工具库)──────────────────────────────────────────────
/** 单条记忆 body 上限(字符)。进 history 前 memory_search 结果另有 MAX_MEMORY_RESULT 兜底。 */
export const MAX_MEMORY_ENTRY = 4000;

/**
 * 记忆检索的相关性下限:命中至少这么多个「证据词元」才算相关(R15 实测值)。
 *
 * 证据词元 = 长度 ≥ 2 的 token(ASCII 词或 CJK bigram),单个汉字不算 ——
 * 「红烧肉怎么炖」里的「肉」「好」几乎必然出现在某条记忆正文里,这正是误报来源。
 *
 * 取值 2 的依据:`npm run eval:memory-retrieval` 的 6 条负例在 1 时仍会有 1 条漏过
 * (只重合一个词就返回),取 2 后负例误报 100% → 0%,正例 recall@1 保持 98%。
 * 代价是 1 条词面重合极弱的探针从 recall@3 掉出(pro-2),已记录在 R15 实施结果里。
 */
export const MEMORY_SEARCH_MIN_EVIDENCE = 2;
/** 启动注入 systemPrompt 的索引条目上限(遗忘封顶后 active 条目 ≤ MAX_ACTIVE,索引再封一层)。 */
export const MAX_INDEX_ENTRIES = 50;
/** active 记忆封顶:超则按 recallCount 低 × lastRecalledAt 老 淘汰到 archived。 */
export const MAX_ACTIVE = 100;
/** 衰减:active + !pinned + (lastRecalledAt|createdAt) 早于 DECAY_DAYS → archived。 */
export const DECAY_DAYS = 30;
/** GC:archived 超 GC_DAYS → 硬删。 */
export const GC_DAYS = 90;
/**
 * R6 情节记忆的衰减周期,**刻意远短于事实记忆**。
 *
 * 情节是"最近发生了什么"的索引,价值随时间陡降:三天前的会话摘要还能帮你接上工作,
 * 一个月前的只会挤占 token 并干扰判断。事实记忆(怎么配置、哪里有坑)则相反,
 * 越久越该留。若共用 30/90 天,每会话一条 episode 会在两个月内堆到几百条,
 * 把长期知识挤出 `MAX_ACTIVE` 的封顶——这是"情节淹没语义"的标准失败模式。
 *
 * 注意与 `buildEpisodeSection` 的注入上限配合:衰减周期决定**存多久**,
 * 注入上限决定**每次显示几条**,两者必须同时生效才不会互相抵消。
 */
export const EPISODE_DECAY_DAYS = 7;
/** 情节归档后多久硬删。比事实的 90 天短得多,理由同上。 */
export const EPISODE_GC_DAYS = 30;
/**
 * R11 已巩固情节的衰减周期:被归纳进语义条目后,原始情节的价值只剩"哪次会话"的
 * 追溯入口,主体知识已经在语义条目里。3 天足够覆盖"刚做完那次"的复盘窗口,
 * 再久就是与已巩固的结论重复占 token。这是 R11.1 里「降权」的具体落法。
 */
export const EPISODE_CONSOLIDATED_DECAY_DAYS = 3;

// ── R11 情节巩固(episode → 语义)──────────────────────────────────────────
/**
 * 触发巩固的最少同主题情节数。
 *
 * 2 条不巩固:两条情节的"共性"很可能只是一次性的上下文(同一个 bug 修了两轮),
 * 过早抽象会把噪声固化成长期事实。3 条且跨 2 个会话才够看出重复模式。
 */
export const CONSOLIDATE_MIN_EPISODES = 3;
/** 触发巩固的最少不同会话数(单会话内的多次情节是同一件事的续集,不是模式)。 */
export const CONSOLIDATE_MIN_SESSIONS = 2;
/** 单次巩固最多处理的组数:后台任务要可控,且一组一次 LLM 调用。 */
export const CONSOLIDATE_MAX_GROUPS = 2;
/**
 * 单组的成员上限。受 `store.ts` 的 `MAX_DERIVED_FROM`(8)约束——超过 8 条时
 * `derivedFrom` 会被截断,剩下的源条目查不到来源反而失去可追溯性。
 */
export const CONSOLIDATE_MAX_GROUP_SIZE = 8;
/** 分组时最多扫描的情节条数(按 createdAt 降序取最近的一批)。 */
export const CONSOLIDATE_SCAN_LIMIT = 40;
/** 两条情节的请求文本至少共享多少个非泛化 token 才算同主题。 */
export const CONSOLIDATE_MIN_TOKEN_OVERLAP = 2;
/** 喂给巩固模型的总输入字符预算(超了就整组丢弃,不做中截——残缺的组会被归纳错)。 */
export const CONSOLIDATE_INPUT_MAX_CHARS = 6000;
/** 启动时注入的最近 episode 条数(硬上限,见 R6.3)。 */
export const EPISODE_INJECT_LIMIT = 3;
/** 单条 episode 里保留的请求条数上限:一次会话几十轮很常见,全列等于存全文(R6.4 禁止)。 */
export const EPISODE_MAX_REQUESTS = 8;
/** 单条请求在 episode 里的字符上限(压平成一行后的截断长度)。 */
export const EPISODE_REQUEST_MAX_CHARS = 120;
/** memory_search 结果(召回的记忆正文)的放宽上限:指令性内容,中截破坏语义,对齐 use_skill。 */
export const MAX_MEMORY_RESULT = 64000;

// ── 知识图谱层(memory-graph.json,单 scope 容量)──────────────────────────
/** 单 scope 实体封顶:超限先清孤儿实体(无 active 边相连),仍超则拒绝新建。 */
export const MAX_GRAPH_ENTITIES = 500;
/** 单 scope 边封顶:超限先清已失效边,仍超则拒绝新边。 */
export const MAX_GRAPH_EDGES = 2000;

// .codegraph:codegraph 索引目录(codegraph.db 是 SQLite 二进制 + daemon.log),
// grep/glob 扫它无意义且会产出数 KB 的超长「行」,污染 TUI 展开渲染。
// 构建产物目录同理:rust/(cargo target,数千个 .o/.rmeta 二进制)、dist/ 与 dist-tests/
// (tsc 产物,与 src 的 .ts 一一对应的 .js,扫它们只会重复命中并拖慢全库 grep——
// 实测无 glob 限定的 grep 扫全库耗时 205s,其中大半耗在这类目录)。
export const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.codegraph/**',
  '**/rust/**',
  '**/dist/**',
  '**/dist-tests/**',
  // Python 生态:虚拟环境与缓存目录动辄上万文件,ripgrep 路径下主要靠 .gitignore 自动跳过,
  // 这里是「非 git 仓库 / 未写进 .gitignore」时的兜底;Node 兜底路径更依赖这份硬名单。
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.tox/**',
  '**/htmlcov/**',
  '**/.ipynb_checkpoints/**',
  '**/*.egg-info/**',
];

// ── legacy profile fallback（官方 TUI/stdio 已由 ToolPolicy 控制）────────────────
// 保留导出名以兼容未传 ToolPolicy 的嵌入调用与旧测试。
export const FRONTEND_TOOLS: ReadonlySet<string> = new Set(TOOL_GROUPS.frontend);
export const COMPUTER_TOOLS: ReadonlySet<string> = new Set(TOOL_GROUPS.computer);

/**
 * Legacy profile fallback 的屏蔽集合。仅供未传 ToolPolicy 的嵌入调用；官方 TUI/stdio
 * 从每 turn snapshot 构造 schema 并以同一 allow-list 做运行时校验。旧 env 查询在这里
 * 仍保留原有 true/false 覆盖语义，避免破坏兼容调用方。
 */
export function getProfileDisabledTools(): Set<string> {
  const all = new Set<string>(Object.values(TOOL_GROUPS).flat());
  for (const name of getProfileToolNames(getActiveProfile())) all.delete(name);
  const reconcile = (enabled: boolean, names: readonly string[]): void => {
    for (const n of names) {
      if (enabled) all.delete(n);
      else all.add(n);
    }
  };
  reconcile(isMemoryEnabled(), TOOL_GROUPS.memory);
  reconcile(isFrontendToolsEnabled(), TOOL_GROUPS.frontend);
  reconcile(isComputerUseEnabled(), TOOL_GROUPS.computer);
  reconcile(isSubAgentEnabled(), TOOL_GROUPS.subagent);
  return all;
}

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
  'memory_graph', // 混合工具(add 写图),plan 只读模式整体屏蔽
  'sub-agent',
  'run_skill', // fork 子 agent 执行面;plan 模式不应派生子工作流
  'computer', // 桌面操控:plan 只读模式无论开关状态都永远屏蔽
  'run_flow', // 回放录制的桌面 flow:同 computer,plan 模式永远屏蔽
]);

/**
 * Legacy plan schema 的动态清理：Memory Index 关闭时从旧 profile 屏蔽集删除不存在于该
 * 兼容 schema 的写工具名。自动路由主路径直接对 ToolPolicy snapshot 与 PLAN_DISABLED_TOOLS
 * 求交，不使用本函数决定 memory route eligibility。
 */
export function getPlanDisabledTools(): Set<string> {
  const next = new Set<string>(PLAN_DISABLED_TOOLS);
  if (!isMemoryEnabled()) {
    next.delete('memory_save');
    next.delete('memory_update');
    next.delete('memory_forget');
  }
  return next;
}

/** inline skill 的 disallowed-tools；自动路由 policy 在此基础上继续求交。 */
export function getSkillRuntimeDisabledTools(): Set<string> {
  const disabled = new Set<string>();
  const active = getActiveSkill();
  if (active?.disallowed) {
    for (const name of active.disallowed) disabled.add(name);
  }
  return disabled;
}

/**
 * 旧 profile 兼容路径的运行时功能开关防线。自动路由主路径改由 AgentRunOptions.toolPolicy
 * 提供同源 snapshot；这里只服务尚未迁移的嵌入调用。
 */
export function getRuntimeDisabledTools(): Set<string> {
  const disabled = getProfileDisabledTools();
  if (!isSubAgentEnabled()) disabled.add('sub-agent');
  for (const name of getSkillRuntimeDisabledTools()) disabled.add(name);
  return disabled;
}
