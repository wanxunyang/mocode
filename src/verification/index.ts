import path from 'node:path';
import { getSandboxRoot } from '../sandbox/index.js';
import { checkPermission } from '../permissions/index.js';
import {
  beginWorkspaceMutation,
  endWorkspaceMutation,
  getCurrentTurnMutationState,
} from '../rollback/index.js';
import {
  formatCommandResult,
  runCommandRaw,
  runCommandTool,
} from '../tools/builtins/run-command.js';
import { discoverValidationCommand } from './discovery.js';
import type { ValidationCallbacks, ValidationResult } from './types.js';

export type {
  ValidationCallbacks,
  ValidationCommand,
  ValidationResult,
  ValidationStatus,
} from './types.js';
export { discoverValidationCommand } from './discovery.js';

const NON_CODE_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
]);

function onlyNonCodeChanges(paths: string[]): boolean {
  return paths.length > 0 && paths.every((item) => NON_CODE_EXTENSIONS.has(path.extname(item).toLowerCase()));
}

function skipped(reason: NonNullable<ValidationResult['skipReason']>): ValidationResult {
  const state = getCurrentTurnMutationState();
  return {
    status: 'skipped',
    output: '',
    durationMs: 0,
    skipReason: reason,
    changedFiles: state.changedFiles.map((item) => item.path),
    mutationVersion: state.version,
  };
}

/** Run one lowest-cost project validation command for the current turn's code changes. */
export async function runAutomaticValidation(
  signal?: AbortSignal,
  callbacks: ValidationCallbacks = {},
): Promise<ValidationResult> {
  const before = getCurrentTurnMutationState();
  const changedPaths = before.changedFiles.map((item) => item.path);
  if (changedPaths.length === 0) return skipped('no_changes');
  if (onlyNonCodeChanges(changedPaths)) return skipped('non_code_changes');

  const root = path.resolve(getSandboxRoot() ?? process.cwd());
  const discovered = discoverValidationCommand(root);
  if (!discovered.command) return skipped(discovered.reason ?? 'no_validation_script');

  const args = { command: discovered.command.command };
  const permission = await checkPermission(runCommandTool, args, signal);
  if (signal?.aborted) {
    const state = getCurrentTurnMutationState();
    return {
      status: 'aborted', output: '', durationMs: 0,
      script: discovered.command.script, command: discovered.command.command,
      changedFiles: state.changedFiles.map((item) => item.path), mutationVersion: state.version,
    };
  }
  if (permission === 'deny') {
    return {
      ...skipped('permission_denied'),
      script: discovered.command.script,
      command: discovered.command.command,
    };
  }

  callbacks.onCommandStart?.(discovered.command.command);
  const capture = beginWorkspaceMutation();
  let raw: Awaited<ReturnType<typeof runCommandRaw>>;
  try {
    raw = await runCommandRaw(discovered.command.command, 120000, signal);
  } finally {
    endWorkspaceMutation(capture, 'automatic_validation');
  }
  const after = getCurrentTurnMutationState();
  const status = raw.status === 'passed'
    ? 'passed'
    : raw.status === 'aborted'
      ? 'aborted'
      : 'failed';
  return {
    status,
    script: discovered.command.script,
    command: discovered.command.command,
    exitCode: raw.exitCode,
    output: formatCommandResult(raw),
    durationMs: raw.durationMs,
    changedFiles: after.changedFiles.map((item) => item.path),
    mutationVersion: after.version,
  };
}
