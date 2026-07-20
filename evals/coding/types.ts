export type BenchmarkGroup =
  | 'single-file' | 'multi-file' | 'types' | 'tests' | 'resilience'
  | 'context' | 'monorepo' | 'no-tests';
export type BenchmarkDifficulty = 'basic' | 'hard' | 'advanced';

export interface FileFixture {
  path: string;
  content: string;
  eol?: 'lf' | 'crlf';
}

export interface CodingTaskFixture {
  id: string;
  title: string;
  group: BenchmarkGroup;
  difficulty: BenchmarkDifficulty;
  goal: string;
  files: FileFixture[];
  verificationCommand: string;
  regressionCommand?: string;
  timeoutMs?: number;
  expected: { files?: string[]; verification: 'passed' };
}

export interface BenchmarkTaskResult {
  id: string;
  title: string;
  group: BenchmarkGroup;
  difficulty: BenchmarkDifficulty;
  status: 'passed' | 'failed' | 'timeout' | 'aborted' | 'error';
  finalVerifiedSuccess: boolean;
  firstPatchPass: boolean;
  regression: boolean;
  toolRecovery: boolean;
  toolCalls: number;
  /** Trace-derived model + tool retry count. */
  retries?: number;
  /** Fraction of completed tool calls that succeeded on their first recorded attempt. */
  firstSuccessRate?: number;
  tokens: number | null;
  durationMs: number;
  unverifiedCompletion: boolean;
  changedFiles: string[];
  error?: string;
  // ─────────── QUAL-01 质量维度 ───────────
  /** RETRY-01: 反思重试注入次数(历史中含 [retry reflection: 的工具结果数)。 */
  reflectionRounds: number;
  /** ASK-01: ask_human 工具成功调用次数。 */
  askHumanCount: number;
  /** PROMPT-02: checklist 触发次数(推入 history 的 [checklist] user 消息计数)。 */
  checklistTriggered: number;
}

export interface BenchmarkReport {
  schemaVersion: 2;
  runId: string;
  generatedAt: string;
  model: string;
  promptHash: string;
  selection: string;
  summary: {
    tasks: number;
    passed: number;
    finalVerifiedSuccessRate: number;
    firstPatchPassRate: number;
    regressionRate: number;
    toolRecoveryRate: number;
    unverifiedCompletionRate: number;
    toolCalls: number;
    retries: number;
    firstSuccessRate: number;
    tokens: number;
    durationMs: number;
    // ─────────── QUAL-01 质量维度聚合 ───────────
    /** 平均反思重试注入次数(per task)。 */
    reflectionRounds: number;
    /** 平均 ask_human 调用次数(per task)。 */
    askHumanCount: number;
    /** 平均 checklist 触发次数(per task)。 */
    checklistTriggered: number;
  };
  tasks: BenchmarkTaskResult[];
}
