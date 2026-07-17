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
  tokens: number | null;
  durationMs: number;
  unverifiedCompletion: boolean;
  changedFiles: string[];
  error?: string;
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
    tokens: number;
    durationMs: number;
  };
  tasks: BenchmarkTaskResult[];
}
