export type BenchmarkGroup =
  | 'single-file'
  | 'multi-file'
  | 'types'
  | 'tests'
  | 'resilience'
  | 'context'
  | 'monorepo'
  | 'no-tests';
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
  /** Whether the workspace snapshot after the first mutating tool batch passed the independent verifier. */
  firstPatchPass: boolean;
  regression: boolean;
  /** Whether at least one failed tool name succeeded in a later model step. */
  toolRecovery: boolean;
  /** Distinct tool names that produced a failure. */
  toolRecoveryAttempts: number;
  /** Distinct failed tool names that later produced a success. */
  toolRecoveries: number;
  toolCalls: number;
  /** Trace-derived model request retry count. */
  retries?: number;
  /** Fraction of completed tool calls that succeeded on their first recorded attempt. */
  firstSuccessRate?: number;
  tokens: number | null;
  durationMs: number;
  changedFiles: string[];
  error?: string;
  /** ask_human 工具成功调用次数。 */
  askHumanCount: number;
}

export interface BenchmarkReport {
  schemaVersion: 3;
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
    /** Recovery ratio across distinct failed tool names; null means the run had no recovery opportunity. */
    toolRecoveryRate: number | null;
    toolRecoveryAttempts: number;
    toolRecoveries: number;
    toolCalls: number;
    retries: number;
    firstSuccessRate: number;
    tokens: number;
    durationMs: number;
    /** 平均 ask_human 调用次数(per task)。 */
    askHumanCount: number;
  };
  tasks: BenchmarkTaskResult[];
}

export interface BenchmarkThresholds {
  maxPassedTaskDrop: number;
  maxFirstPatchPassRateDrop: number;
  maxToolRecoveryRateDrop: number;
  maxRegressionRateIncrease: number;
}

export interface UnrecordedBaseline {
  schemaVersion: 3;
  status: 'not-recorded';
  suiteSize: number;
  description: string;
}

export interface RecordedBaseline {
  schemaVersion: 3;
  status: 'recorded';
  suiteSize: number;
  thresholds: BenchmarkThresholds;
  report: BenchmarkReport;
}

export type BenchmarkBaseline = UnrecordedBaseline | RecordedBaseline;
