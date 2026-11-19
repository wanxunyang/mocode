import type { ShortPathEfficiency } from '../../src/session/short-path-metrics.js';
import type { ReasoningEffort } from '../../src/llm/reasoning.js';

/**
 * 短路径效率基准的场景分层:
 * - micro  单文件小修,gold 路径 ≈ read → edit(→ verify),测「会不会直奔目标」;
 * - hinted 多文件迷你仓库,任务文本自带精确路径/报错,测「会不会利用提示省掉全树搜索」;
 * - warm   两段式会话,第一轮已读过代码建立上下文,第二轮追加小任务,测「会不会复用上下文而不是重新探索」;
 * - repo   self-host 真实仓库(git archive HEAD 快照),在 mocode 自己的代码上做小增量任务。
 */
export type ShortPathScenario = 'micro' | 'hinted' | 'warm' | 'repo';

/**
 * 复杂度分级(L1-L10,对标业界 SWE-bench/Terminal-Bench/METR time-horizon 的分层口径)。
 * level 与 scenario 正交:level 是「任务复杂度」,scenario 是「运行形态/上下文供给」。
 * L1-L5 已全覆盖;L6-L10 为后续扩展预留(需要更大的 fixture 仓库与更高预算):
 * - L1  机械单点:单文件单处修改,无需理解逻辑(常量/拼写/导出缺失/文案)。
 * - L2  单文件逻辑修复:需理解函数内行为(边界条件/异步/正则/算法小错)。
 * - L3  多文件局部修复:2-3 文件调用链,带精确提示(路径/堆栈/复现)。
 * - L4  会话内上下文延续:先建立上下文再追加小改动(warm)。
 * - L5  真实仓库定位 + 增量修改:陌生仓库里定位 leaf 模块并做增量任务(repo)。
 * - L6  多文件功能开发:新增功能,多文件协同设计,无现成模板(l6:只给文件名+签名+行为契约)。
 * - L7  测试驱动修复/重构:按(新增)测试补实现或重构,含 CRLF/事务等边界语义。
 * - L8  跨模块重构:API 变更跨包传导,monorepo 边界,契约同步。
 * - L9  系统级任务:并发/事务/缓存/流式等横切语义,性能与正确性双约束。
 * - L10 长程工程:架构级、多阶段规格演进,需要自主规划与多次验证的长 horizon 任务。
 */
export type ComplexityLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface ShortPathFileFixture {
  path: string;
  content: string;
  eol?: 'lf' | 'crlf';
}

/** gold 参考路径:path ratio 的分母与首改前请求预算。 */
export interface GoldPath {
  /** 该题 gold 工具调用上限(人工标注的"合理最短"路径,允许 1 次冗余余量)。 */
  maxToolCalls: number;
  /** 首个 workspace mutation 前允许的模型请求数上限(仅报告,不单独门禁)。 */
  maxRequestsBeforeFirstEdit?: number;
}

export interface ShortPathTask {
  id: string;
  title: string;
  scenario: ShortPathScenario;
  /** 复杂度等级(1-5 已覆盖;定义见 ComplexityLevel 注释)。 */
  level: ComplexityLevel;
  goal: string;
  /** warm 场景第一轮(上下文预热,不计分);要求只读不改。 */
  warmupGoal?: string;
  files: ShortPathFileFixture[];
  verificationCommand: string;
  /** verifier 进程超时(默认 15s;repo 场景 tsx 冷启动需要更长)。 */
  verifyTimeoutMs?: number;
  /** true = 先解包 mocode git archive 快照,再把 files 覆盖写入(repo 场景)。 */
  repoSnapshot?: boolean;
  gold: GoldPath;
  expected?: { files?: string[] };
  timeoutMs?: number;
}

export interface ShortPathTaskResult {
  id: string;
  title: string;
  scenario: ShortPathScenario;
  /** 复杂度等级;旧报告/基线缺省 0(未知)。 */
  level: ComplexityLevel | 0;
  status: 'passed' | 'failed' | 'timeout' | 'error';
  /** 独立 verifier 通过 + 预期文件被改 + verifier 未被篡改 + 未超时(warm 还要求预热轮零改动)。 */
  finalVerifiedSuccess: boolean;
  expectedFilesTouched: boolean;
  verifierUnchanged: boolean;
  /** warm 场景:预热轮是否发生了 workspace mutation(发生即判失败,预热必须只读)。 */
  warmupMutated: boolean;
  /** 计分轮效率指标(warm = 第二轮;其余 = 唯一轮)。 */
  efficiency: ShortPathEfficiency;
  /** warm 场景:预热轮的只读调用数(判断上下文是否真的建立了)。 */
  warmupReadCalls: number | null;
  /** gold 工具调用上限(来自 fixture.gold.maxToolCalls)。 */
  goldMaxToolCalls: number;
  /** 实际工具调用数 / gold.maxToolCalls。 */
  pathRatio: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  durationMs: number;
  /** 含预路由及 warm 预热，不含独立验收脚本。旧报告未记录。 */
  endToEndDurationMs?: number;
  warmupDurationMs?: number;
  changedFiles: string[];
  error?: string;
}

export interface ShortPathScenarioSummary {
  scenario: ShortPathScenario;
  tasks: number;
  passed: number;
  verifiedRate: number;
  meanToolCalls: number;
  meanPathRatio: number;
  meanRequestsBeforeFirstEdit: number;
  totalRepeatedIdenticalReadOnlyCalls: number;
  meanPostEditReadOnlyCalls: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  meanDurationMs: number;
}

export interface ShortPathReport {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  model: string;
  promptHash: string;
  scenario: ShortPathScenario;
  selection: string;
  experiment?: {
    fixtureHash: string;
    reasoningEffort: ReasoningEffort;
    routing: 'off' | 'llm' | 'jev';
    shortPathCompletion: boolean;
    grepEditContext?: boolean;
  };
  summary: ShortPathScenarioSummary;
  tasks: ShortPathTaskResult[];
}

export interface ShortPathThresholds {
  maxPassedTaskDrop: number;
}

/** 基线里按场景固化的效率快照,用于趋势对比。 */
export interface ShortPathEfficiencyBaseline {
  meanToolCalls: number;
  meanPathRatio: number;
  meanRequestsBeforeFirstEdit: number;
  meanPromptTokens: number;
}

/** 效率劣化的相对阈值(比例,如 0.2 = 新均值超过基线 20% 才告警)。 */
export const EFFICIENCY_WARN_DELTA = 0.2;
