export type ValidationStatus = 'passed' | 'failed' | 'skipped' | 'aborted';

export interface ValidationCommand {
  script: 'typecheck' | 'test' | 'build';
  command: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  cwd: string;
}

export interface ValidationCallbacks {
  /** Called only after discovery and permission approval, immediately before command execution. */
  onCommandStart?: (command: string) => void;
}

/**
 * 自动验证结果：记录单次 typecheck / test / build 脚本的执行状态、退出码与输出,
 * 用于在 mutation 后判定代码变更是否可通过验证。
 */
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
    | 'permission_denied';
  changedFiles: string[];
  mutationVersion: number;
}
