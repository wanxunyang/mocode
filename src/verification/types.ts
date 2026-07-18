import type { AffectedReason, RejectedChangedFile } from './affected.js';

export type ValidationStatus = 'passed' | 'failed' | 'skipped' | 'aborted';
export type ValidationLevel = 'V0' | 'V1' | 'V2' | 'V3';
export type ValidationDiagnosticSource =
  | 'postcondition'
  | 'typescript'
  | 'test'
  | 'typecheck'
  | 'build'
  | 'verifier';

export type ValidationSkipReason =
  | 'no_changes'
  | 'non_code_changes'
  | 'no_package_json'
  | 'no_validation_script'
  | 'no_affected_package'
  | 'invalid_changed_path'
  | 'permission_denied'
  | 'no_applicable_validator';

export interface ValidationDiagnostic {
  level: ValidationLevel;
  source: ValidationDiagnosticSource;
  severity: 'error' | 'warning' | 'info';
  code?: string | number;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  packageName?: string;
}

export interface ValidationCommand {
  script: 'typecheck' | 'test' | 'build';
  command: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  cwd: string;
}

export interface ValidationCallbacks {
  /** Called for every validation command permission decision, before possible execution. */
  onPermissionDecision?: (event: {
    decision: 'allow' | 'deny';
    tool: string;
    arguments: Record<string, unknown>;
  }) => void;
  /** Called after permission approval, immediately before each command execution. */
  onCommandStart?: (command: string) => void;
}

export interface AffectedPackageSummary {
  name: string;
  root: string;
  reasons: AffectedReason[];
}

export interface ValidationStageResult {
  level: ValidationLevel;
  status: ValidationStatus;
  adapter: string;
  packageName?: string;
  command?: string;
  exitCode?: number | null;
  diagnostics: ValidationDiagnostic[];
  output: string;
  durationMs: number;
  skipReason?: string;
  inputFingerprint?: string;
  fingerprint?: string;
  cached?: boolean;
}

export interface PackageValidationResult {
  packageName: string;
  packageRoot: string;
  level: 'V2' | 'V3';
  status: Exclude<ValidationStatus, 'skipped'>;
  script: ValidationCommand['script'];
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/** Structured result for the layered validation selected from the current turn's changes. */
export interface ValidationResult {
  status: ValidationStatus;
  level?: ValidationLevel;
  script?: ValidationCommand['script'];
  command?: string;
  exitCode?: number | null;
  output: string;
  durationMs: number;
  skipReason?: ValidationSkipReason;
  diagnostics: ValidationDiagnostic[];
  stages: ValidationStageResult[];
  verificationComplete: boolean;
  fingerprint: string;
  inputFingerprint: string;
  inputMutationVersion: number;
  affectedPackages: AffectedPackageSummary[];
  rejectedChangedFiles?: RejectedChangedFile[];
  packageResults?: PackageValidationResult[];
  changedFiles: string[];
  mutationVersion: number;
}
