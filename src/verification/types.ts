import type { AffectedReason, RejectedChangedFile } from './affected.js';

export type ValidationStatus = 'passed' | 'failed' | 'skipped' | 'aborted';

export interface ValidationCommand {
  script: 'typecheck' | 'test' | 'build';
  command: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  cwd: string;
}

export interface ValidationCallbacks {
  /** Called after permission approval, immediately before each package command execution. */
  onCommandStart?: (command: string) => void;
}

export interface AffectedPackageSummary {
  name: string;
  root: string;
  reasons: AffectedReason[];
}

export interface PackageValidationResult {
  packageName: string;
  packageRoot: string;
  status: Exclude<ValidationStatus, 'skipped'>;
  script: ValidationCommand['script'];
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/** Structured result for all package validations selected from the current turn's changes. */
export interface ValidationResult {
  status: ValidationStatus;
  script?: ValidationCommand['script'];
  command?: string;
  exitCode?: number | null;
  output: string;
  durationMs: number;
  skipReason?:
    | 'no_changes'
    | 'non_code_changes'
    | 'no_package_json'
    | 'no_validation_script'
    | 'no_affected_package'
    | 'invalid_changed_path'
    | 'permission_denied';
  affectedPackages?: AffectedPackageSummary[];
  rejectedChangedFiles?: RejectedChangedFile[];
  packageResults?: PackageValidationResult[];
  changedFiles: string[];
  mutationVersion: number;
}
