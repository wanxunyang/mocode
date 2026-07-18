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
import { discoverPackageValidationCommands } from './discovery.js';
import { runChangedFileDiagnostics } from './diagnostics.js';
import { fingerprintFiles, fingerprintValidation } from './fingerprint.js';
import { runFilePostconditions } from './postconditions.js';
import { discoverProjectProfile } from './profile.js';
import { discoverTargetedTestCommands } from './targeted-tests.js';
import type { AffectedPackage, AffectedPackagesResult } from './affected.js';
import type { ProjectProfile } from './profile.js';
import type {
  PackageValidationResult,
  ValidationCallbacks,
  ValidationCommand,
  ValidationDiagnostic,
  ValidationLevel,
  ValidationResult,
  ValidationSkipReason,
  ValidationStageResult,
} from './types.js';

export type {
  AffectedPackageSummary,
  PackageValidationResult,
  ValidationCallbacks,
  ValidationCommand,
  ValidationDiagnostic,
  ValidationLevel,
  ValidationResult,
  ValidationSkipReason,
  ValidationStageResult,
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
export {
  discoverPackageValidationCommand,
  discoverPackageValidationCommands,
  discoverValidationCommand,
} from './discovery.js';
export { clearProjectProfileCache, discoverProjectProfile } from './profile.js';

const NON_CODE_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
]);

interface SelectedCommand {
  affected: AffectedPackage;
  command: ValidationCommand;
  level: 'V2' | 'V3';
  adapter: string;
}

interface AggregateOptions {
  root: string;
  inputMutationVersion: number;
  inputFingerprint: string;
  stages: ValidationStageResult[];
  affected?: AffectedPackagesResult;
  packageResults?: PackageValidationResult[];
  skipReason?: ValidationSkipReason;
}

function isNonCodePath(file: string): boolean {
  return NON_CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function affectedSummary(affected?: AffectedPackagesResult): ValidationResult['affectedPackages'] {
  return affected?.packages.map((item) => ({
    name: item.package.name,
    root: item.package.root,
    reasons: item.reasons,
  })) ?? [];
}

function selectionOutput(affected?: AffectedPackagesResult): string {
  if (!affected || affected.packages.length === 0) return '';
  return [
    'Affected packages:',
    ...affected.packages.map((item) => {
      const reasons = item.reasons.map((reason) => `${reason.kind}(${reason.changedPath})`).join(', ');
      return `- ${item.package.name}: ${reasons}`;
    }),
  ].join('\n');
}

function stageOutput(stage: ValidationStageResult): string {
  const scope = stage.packageName ? ` ${stage.packageName}` : '';
  return `[${stage.level}${scope}] ${stage.status} (${stage.adapter})${stage.output ? `\n${stage.output}` : ''}`;
}

function highestLevel(stages: readonly ValidationStageResult[]): ValidationLevel | undefined {
  return stages.at(-1)?.level;
}

function aggregate(options: AggregateOptions): ValidationResult {
  const state = getCurrentTurnMutationState();
  const diagnostics = options.stages.flatMap((stage) => stage.diagnostics);
  const terminal = options.stages.find((stage) => stage.status === 'failed' || stage.status === 'aborted');
  const blockingSkip = options.stages.find((stage) =>
    stage.status === 'skipped' && [
      'permission_denied', 'no_validation_script', 'no_package_json',
      'no_affected_package', 'invalid_changed_path',
    ].includes(stage.skipReason ?? ''));
  const v3Passed = options.stages.some((stage) => stage.level === 'V3' && stage.status === 'passed');
  const substantivePassed = options.stages.some((stage) => stage.level !== 'V0' && stage.status === 'passed');
  const status = terminal?.status ?? (blockingSkip || !substantivePassed ? 'skipped' : 'passed');
  const level = terminal?.level ?? highestLevel(options.stages);
  const output = [selectionOutput(options.affected), ...options.stages.map(stageOutput)].filter(Boolean).join('\n\n');
  const commands = options.stages.flatMap((stage) => stage.command ? [stage.command] : []);
  const skipReason = options.skipReason
    ?? (blockingSkip?.skipReason as ValidationSkipReason | undefined)
    ?? (status === 'skipped' ? 'no_applicable_validator' : undefined);
  const fingerprint = fingerprintValidation({
    root: options.root,
    level,
    status,
    adapter: terminal?.adapter,
    command: commands.join(' | '),
    diagnostics,
    output,
  });

  return {
    status,
    level,
    script: commands.length === 1 ? options.packageResults?.[0]?.script : undefined,
    command: commands.length > 0 ? commands.join(' | ') : undefined,
    exitCode: terminal?.exitCode,
    output,
    durationMs: options.stages.reduce((sum, stage) => sum + stage.durationMs, 0),
    skipReason,
    diagnostics,
    stages: options.stages,
    verificationComplete: status === 'passed' && v3Passed && !blockingSkip,
    fingerprint,
    inputFingerprint: options.inputFingerprint,
    inputMutationVersion: options.inputMutationVersion,
    affectedPackages: affectedSummary(options.affected),
    rejectedChangedFiles: options.affected?.rejected,
    packageResults: options.packageResults,
    changedFiles: state.changedFiles.map((item) => item.path),
    mutationVersion: state.version,
  };
}

function emptyResult(
  root: string,
  reason: ValidationSkipReason,
  inputMutationVersion: number,
  changedFiles: string[],
): ValidationResult {
  const inputFingerprint = fingerprintFiles(root, changedFiles);
  return aggregate({ root, inputMutationVersion, inputFingerprint, stages: [], skipReason: reason });
}
function skippedStage(
  level: ValidationLevel,
  adapter: string,
  reason: string,
  output: string,
  inputFingerprint: string,
  packageName?: string,
): ValidationStageResult {
  return {
    level,
    status: 'skipped',
    adapter,
    packageName,
    diagnostics: [],
    output,
    durationMs: 0,
    skipReason: reason,
    inputFingerprint,
  };
}

function commandSource(command: ValidationCommand): ValidationDiagnostic['source'] {
  return command.script;
}

async function executeSelectedCommand(
  item: SelectedCommand,
  root: string,
  inputFingerprint: string,
  signal: AbortSignal | undefined,
  callbacks: ValidationCallbacks,
): Promise<{ stage: ValidationStageResult; packageResult?: PackageValidationResult }> {
  const relativeCwd = path.relative(root, item.command.cwd) || '.';
  const permissionArgs = { command: item.command.command, path: relativeCwd };
  const permission = await checkPermission(
    runCommandTool,
    permissionArgs,
    signal,
    { projectRoot: root },
  );
  callbacks.onPermissionDecision?.({
    decision: permission,
    tool: runCommandTool.name,
    arguments: permissionArgs,
  });
  if (signal?.aborted) {
    return {
      stage: {
        level: item.level, status: 'aborted', adapter: item.adapter,
        packageName: item.affected.package.name, command: item.command.command,
        diagnostics: [], output: 'Validation aborted.', durationMs: 0, inputFingerprint,
      },
    };
  }
  if (permission === 'deny') {
    return {
      stage: skippedStage(
        item.level, item.adapter, 'permission_denied', 'Validation command permission was denied.',
        inputFingerprint, item.affected.package.name,
      ),
    };
  }

  callbacks.onCommandStart?.(`[${item.level} ${item.affected.package.name}] ${item.command.command}`);
  const capture = beginWorkspaceMutation();
  let raw;
  try {
    raw = await runCommandRaw(item.command.command, 120000, signal, item.command.cwd);
  } finally {
    endWorkspaceMutation(capture, 'automatic_validation');
  }
  const status = raw.status === 'passed' ? 'passed' : raw.status === 'aborted' ? 'aborted' : 'failed';
  const output = formatCommandResult(raw);
  const diagnostics: ValidationDiagnostic[] = status === 'failed'
    ? [{
        level: item.level,
        source: commandSource(item.command),
        severity: 'error',
        code: raw.status.toUpperCase(),
        packageName: item.affected.package.name,
        message: output,
      }]
    : [];
  const stage: ValidationStageResult = {
    level: item.level,
    status,
    adapter: item.adapter,
    packageName: item.affected.package.name,
    command: item.command.command,
    exitCode: raw.exitCode,
    diagnostics,
    output,
    durationMs: raw.durationMs,
    inputFingerprint,
  };
  stage.fingerprint = fingerprintValidation({
    root,
    level: stage.level,
    status: stage.status,
    adapter: stage.adapter,
    command: stage.command,
    diagnostics,
    output,
  });
  return {
    stage,
    packageResult: {
      packageName: item.affected.package.name,
      packageRoot: item.affected.package.root,
      level: item.level,
      status,
      script: item.command.script,
      command: item.command.command,
      exitCode: raw.exitCode,
      output,
      durationMs: raw.durationMs,
    },
  };
}

async function runCommands(
  selected: readonly SelectedCommand[],
  root: string,
  inputFingerprint: string,
  signal: AbortSignal | undefined,
  callbacks: ValidationCallbacks,
  stages: ValidationStageResult[],
  packageResults: PackageValidationResult[],
): Promise<boolean> {
  for (const item of selected) {
    const result = await executeSelectedCommand(item, root, inputFingerprint, signal, callbacks);
    stages.push(result.stage);
    if (result.packageResult) packageResults.push(result.packageResult);
    if (result.stage.status !== 'passed') return false;
  }
  return true;
}

function resolveProfile(root: string, validationPaths: string[]): {
  profile?: ProjectProfile;
  affected?: AffectedPackagesResult;
} {
  try {
    const profile = discoverProjectProfile(root);
    return {
      profile,
      affected: resolveAffectedPackages(profile, validationPaths, { changedFilesBase: process.cwd() }),
    };
  } catch {
    return {};
  }
}
/** Run V0→V3 in cost order and stop at the first actionable failure. */
export async function runAutomaticValidation(
  signal?: AbortSignal,
  callbacks: ValidationCallbacks = {},
): Promise<ValidationResult> {
  const before = getCurrentTurnMutationState();
  const root = path.resolve(getSandboxRoot() ?? process.cwd());
  const changedPaths = before.changedFiles.map((item) => item.path);
  if (changedPaths.length === 0) return emptyResult(root, 'no_changes', before.version, changedPaths);

  const validationPaths = changedPaths.filter((item) => !isNonCodePath(item));
  if (validationPaths.length === 0) {
    return emptyResult(root, 'non_code_changes', before.version, changedPaths);
  }

  const inputFingerprint = fingerprintFiles(root, validationPaths);
  const { profile, affected } = resolveProfile(root, validationPaths);
  const stages: ValidationStageResult[] = [];
  const packageResults: PackageValidationResult[] = [];
  const finish = (skipReason?: ValidationSkipReason): ValidationResult => aggregate({
    root,
    inputMutationVersion: before.version,
    inputFingerprint,
    stages,
    affected,
    packageResults,
    skipReason,
  });

  const v0 = await runFilePostconditions(root, validationPaths, inputFingerprint);
  stages.push(v0);
  if (v0.status === 'failed') return finish();

  const v1 = await runChangedFileDiagnostics(root, validationPaths, inputFingerprint);
  stages.push(v1);
  if (v1.status === 'failed') return finish();

  if (!profile || !affected) {
    stages.push(skippedStage('V3', 'package-scripts', 'no_package_json', 'No project package profile is available.', inputFingerprint));
    return finish('no_package_json');
  }
  if (affected.rejected.length > 0) {
    stages.push(skippedStage(
      'V3', 'affected-packages', 'invalid_changed_path',
      affected.rejected.map((item) => `Rejected changed path: ${item.input} (${item.reason})`).join('\n'),
      inputFingerprint,
    ));
    return finish('invalid_changed_path');
  }
  if (affected.packages.length === 0) {
    stages.push(skippedStage('V3', 'affected-packages', 'no_affected_package', 'No package owns the changed files.', inputFingerprint));
    return finish('no_affected_package');
  }

  const targeted = discoverTargetedTestCommands(profile, affected.packages).map((item): SelectedCommand => ({
    affected: item.affected,
    command: item.command,
    level: 'V2',
    adapter: item.adapter,
  }));
  if (targeted.length === 0) {
    stages.push(skippedStage('V2', 'targeted-tests', 'no_targeted_tests', 'No reliable targeted tests were found.', inputFingerprint));
  } else if (!await runCommands(targeted, root, inputFingerprint, signal, callbacks, stages, packageResults)) {
    return finish(stages.at(-1)?.skipReason === 'permission_denied' ? 'permission_denied' : undefined);
  }

  const selected: SelectedCommand[] = [];
  for (const item of affected.packages) {
    const commands = discoverPackageValidationCommands(profile, item.package);
    if (commands.length === 0) {
      stages.push(skippedStage(
        'V3', 'package-scripts', 'no_validation_script',
        'Affected package has no typecheck, build, or test script.', inputFingerprint, item.package.name,
      ));
      continue;
    }
    selected.push(...commands.map((command) => ({
      affected: item,
      command,
      level: 'V3' as const,
      adapter: `package-${command.script}`,
    })));
  }
  const scriptOrder: Record<ValidationCommand['script'], number> = { typecheck: 0, build: 1, test: 2 };
  selected.sort((left, right) => scriptOrder[left.command.script] - scriptOrder[right.command.script]);
  if (selected.length === 0) return finish('no_validation_script');

  await runCommands(selected, root, inputFingerprint, signal, callbacks, stages, packageResults);
  return finish(stages.at(-1)?.skipReason === 'permission_denied' ? 'permission_denied' : undefined);
}

/** Create a run-scoped verifier cache; identical content never repeats expensive validation. */
export function createAutomaticValidator(): typeof runAutomaticValidation {
  const cache = new Map<string, ValidationResult>();
  const failureCounts = new Map<string, number>();
  return async (signal?: AbortSignal, callbacks: ValidationCallbacks = {}) => {
    const state = getCurrentTurnMutationState();
    const root = path.resolve(getSandboxRoot() ?? process.cwd());
    const changedFiles = state.changedFiles.map((item) => item.path);
    const inputFingerprint = fingerprintFiles(root, changedFiles);
    const cacheKey = `${root}\0${inputFingerprint}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      const count = cached.status === 'failed'
        ? (failureCounts.get(cached.fingerprint) ?? 1) + 1
        : 1;
      if (cached.status === 'failed') failureCounts.set(cached.fingerprint, count);
      return {
        ...cached,
        output: `${cached.output}\n\n[validation cache] Identical inputs reused; failure occurrence ${count}.`,
        stages: cached.stages.map((stage) => ({ ...stage, cached: true, durationMs: 0 })),
        durationMs: 0,
        inputMutationVersion: state.version,
        changedFiles,
        mutationVersion: state.version,
      };
    }

    const result = await runAutomaticValidation(signal, callbacks);
    if (result.status === 'failed') {
      const count = (failureCounts.get(result.fingerprint) ?? 0) + 1;
      failureCounts.set(result.fingerprint, count);
      if (count > 1) {
        result.output += `\n\n[validation thrashing] The same failure fingerprint occurred ${count} times; change strategy before retrying.`;
      }
    }
    cache.set(cacheKey, result);
    return result;
  };
}
