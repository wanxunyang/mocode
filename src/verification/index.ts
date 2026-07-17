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
import { resolveAffectedPackages } from './affected.js';
import { discoverPackageValidationCommand, discoverValidationCommand } from './discovery.js';
import { discoverProjectProfile } from './profile.js';
import type { AffectedPackage, AffectedPackagesResult } from './affected.js';
import type { ValidationCallbacks, ValidationCommand, ValidationResult } from './types.js';

export type {
  AffectedPackageSummary,
  PackageValidationResult,
  ValidationCallbacks,
  ValidationCommand,
  ValidationResult,
  ValidationStatus,
} from './types.js';
export type {
  AffectedPackage,
  AffectedPackageOptions,
  AffectedPackagesResult,
  AffectedReason,
  AffectedReasonKind,
  ChangedPathClassification,
  RejectedChangedFile,
} from './affected.js';
export type { PackageProfile, ProjectPackageManager, ProjectProfile } from './profile.js';
export { resolveAffectedPackages } from './affected.js';
export { discoverPackageValidationCommand, discoverValidationCommand } from './discovery.js';
export { clearProjectProfileCache, discoverProjectProfile } from './profile.js';

const NON_CODE_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
]);

interface SelectedCommand {
  affected: AffectedPackage;
  command: ValidationCommand;
}

function isNonCodePath(file: string): boolean {
  return NON_CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function affectedSummary(affected: AffectedPackagesResult): NonNullable<ValidationResult['affectedPackages']> {
  return affected.packages.map((item) => ({
    name: item.package.name,
    root: item.package.root,
    reasons: item.reasons,
  }));
}

function selectionOutput(affected: AffectedPackagesResult): string {
  if (affected.packages.length === 0) return '';
  return [
    'Affected packages:',
    ...affected.packages.map((item) => {
      const reasons = item.reasons.map((reason) => `${reason.kind}(${reason.changedPath})`).join(', ');
      return `- ${item.package.name}: ${reasons}`;
    }),
  ].join('\n');
}

function skipped(
  reason: NonNullable<ValidationResult['skipReason']>,
  patch: Partial<ValidationResult> = {},
): ValidationResult {
  const state = getCurrentTurnMutationState();
  return {
    status: 'skipped',
    output: '',
    durationMs: 0,
    skipReason: reason,
    changedFiles: state.changedFiles.map((item) => item.path),
    mutationVersion: state.version,
    ...patch,
  };
}

function commandSummary(selected: SelectedCommand[]): string {
  return selected.map((item) => `${item.affected.package.name}: ${item.command.command}`).join(' | ');
}

/** Run the lowest-cost validation command for each package affected by this turn's code changes. */
export async function runAutomaticValidation(
  signal?: AbortSignal,
  callbacks: ValidationCallbacks = {},
): Promise<ValidationResult> {
  const before = getCurrentTurnMutationState();
  const changedPaths = before.changedFiles.map((item) => item.path);
  if (changedPaths.length === 0) return skipped('no_changes');
  const validationPaths = changedPaths.filter((item) => !isNonCodePath(item));
  if (validationPaths.length === 0) return skipped('non_code_changes');

  const root = path.resolve(getSandboxRoot() ?? process.cwd());
  let affected: AffectedPackagesResult;
  let selected: SelectedCommand[];
  try {
    const profile = discoverProjectProfile(root);
    affected = resolveAffectedPackages(profile, validationPaths, { changedFilesBase: process.cwd() });
    selected = affected.packages.flatMap((item) => {
      const command = discoverPackageValidationCommand(profile, item.package);
      return command ? [{ affected: item, command }] : [];
    });
  } catch {
    return skipped('no_validation_script');
  }

  const summary = affectedSummary(affected);
  const selectedOutput = selectionOutput(affected);
  if (affected.rejected.length > 0) {
    return skipped('invalid_changed_path', {
      output: [
        selectedOutput,
        ...affected.rejected.map((item) => `Rejected changed path: ${item.input} (${item.reason})`),
      ].filter(Boolean).join('\n'),
      affectedPackages: summary,
      rejectedChangedFiles: affected.rejected,
    });
  }
  if (affected.packages.length === 0) {
    return skipped('no_affected_package', { output: selectedOutput, affectedPackages: summary });
  }
  if (selected.length === 0) {
    return skipped('no_validation_script', { output: selectedOutput, affectedPackages: summary });
  }

  const commands = commandSummary(selected);
  for (const item of selected) {
    const relativeCwd = path.relative(root, item.command.cwd) || '.';
    const permission = await checkPermission(
      runCommandTool,
      { command: item.command.command, path: relativeCwd },
      signal,
      { projectRoot: root },
    );
    if (signal?.aborted) {
      const state = getCurrentTurnMutationState();
      return {
        status: 'aborted',
        command: commands,
        output: selectedOutput,
        durationMs: 0,
        affectedPackages: summary,
        changedFiles: state.changedFiles.map((change) => change.path),
        mutationVersion: state.version,
      };
    }
    if (permission === 'deny') {
      return skipped('permission_denied', {
        command: commands,
        output: selectedOutput,
        affectedPackages: summary,
      });
    }
  }

  const packageResults: NonNullable<ValidationResult['packageResults']> = [];
  const capture = beginWorkspaceMutation();
  try {
    for (const item of selected) {
      callbacks.onCommandStart?.(`[${item.affected.package.name}] ${item.command.command}`);
      const raw = await runCommandRaw(item.command.command, 120000, signal, item.command.cwd);
      const status = raw.status === 'passed'
        ? 'passed'
        : raw.status === 'aborted'
          ? 'aborted'
          : 'failed';
      packageResults.push({
        packageName: item.affected.package.name,
        packageRoot: item.affected.package.root,
        status,
        script: item.command.script,
        command: item.command.command,
        exitCode: raw.exitCode,
        output: formatCommandResult(raw),
        durationMs: raw.durationMs,
      });
      if (status !== 'passed') break;
    }
  } finally {
    endWorkspaceMutation(capture, 'automatic_validation');
  }

  const after = getCurrentTurnMutationState();
  const terminal = packageResults.find((item) => item.status !== 'passed')
    ?? packageResults[packageResults.length - 1]!;
  const output = [
    selectedOutput,
    ...packageResults.map((item) =>
      `[${item.packageName}] ${item.command} (cwd: ${path.relative(root, item.packageRoot) || '.'})\n${item.output}`),
  ].filter(Boolean).join('\n\n');
  return {
    status: terminal.status,
    script: selected.length === 1 ? selected[0]?.command.script : undefined,
    command: commands,
    exitCode: terminal.exitCode,
    output,
    durationMs: packageResults.reduce((total, item) => total + item.durationMs, 0),
    affectedPackages: summary,
    packageResults,
    changedFiles: after.changedFiles.map((item) => item.path),
    mutationVersion: after.version,
  };
}
