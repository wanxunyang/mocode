// Lane 成果的集成：把各条 lane 的 patch 安全地合回它们各自的工作区。
//
// 为什么不直接 `git apply` 完事：
//   - 并行 lane 之间可能改同一个文件，单条 patch 逐个 --check 都能过，合在一起却互相踩；
//   - 目标工作区可能还带着用户自己的未提交改动，patch 会覆盖掉；
//   - 部分成功比全都不做更糟：用户看到「一半合进去了」根本没法判断现场。
//
// 因此这里分三步，任何一步失败都不留痕迹：
//   1. 预检（precheck）：解析每条 patch 的改动文件、要求每个文件在目标里干净、逐条 `git apply --check`；
//   2. 试合（dry-run，默认）：把这几条 patch 依次应用到目标**在内存里的副本**上不行——
//      改为「备份被触及文件 → 真应用 → 任何一条失败就整批还原」；
//   3. 落账（commit 由用户决定）：只写工作树，不提交、不切分支、不碰 index。
//
// `git apply` 本身在非 git 目录也能工作（已实测），所以非 git 的 copy lane 用同一套流程。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitTopLevel } from '../jobs/worktree.js';
import type { LaneMode, OrchestrationLane, OrchestrationRun } from './types.js';

export type IntegrateLaneStatus =
  | 'ready' // patch 可用，预检通过
  | 'no-changes' // lane 没有任何文件改动
  | 'not-closed' // lane 还开着：现场仍在演进，先 close
  | 'inplace' // 原地写档位：改动已经在目标里
  | 'missing-patch' // 账本里有记录但文件已不在磁盘
  | 'unsupported' // binary 等无法用 git apply 的 patch
  | 'conflict'; // 预检不通过（目标文件脏了或上下文不匹配）

export interface IntegrateLanePlan {
  laneId: string;
  mode: LaneMode;
  workspaceRoot: string;
  patchPath?: string;
  status: IntegrateLaneStatus;
  /** patch 触及的相对路径。 */
  files: string[];
  /** 与目标工作区未提交改动重合的文件。 */
  dirtyFiles: string[];
  error?: string;
}

export interface IntegrationPlan {
  runId: string;
  /** lane 分组后的集成目标（每个工作区一批）。 */
  targets: Array<{
    workspaceRoot: string;
    gitRoot: string | null;
    lanes: IntegrateLanePlan[];
    /** 这一组能不能合：false 时 blocked 里会有原因。 */
    ready: boolean;
    blocked: string[];
  }>;
  warnings: string[];
}

export interface IntegrateOptions {
  /** 只处理这些 lane；省略 = 所有 lane。 */
  lanes?: readonly string[];
}

export interface IntegrateResult {
  plan: IntegrationPlan;
  applied: boolean;
  results: Array<{
    workspaceRoot: string;
    status: 'applied' | 'skipped' | 'failed' | 'dry-run';
    /** 真正写进工作区的相对路径（去重、排序）。 */
    files: string[];
    error?: string;
  }>;
}

function gitRaw(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 解析 patch 触及的文件：`--numstat -z` 对二进制也给出路径，比读 diff 头稳。 */
function patchFiles(patchPath: string): string[] {
  const result = gitRaw(['apply', '--numstat', '-z', patchPath], path.dirname(patchPath));
  if (!result.ok) throw new Error(result.stderr.trim() || 'git apply --numstat failed');
  const files: string[] = [];
  for (const record of result.stdout.split('\0')) {
    if (!record.trim()) continue;
    // 记录形如 "12\t3\tsrc/a.ts"；二进制记作 "-\t-\tb.png"。
    const tab = record.lastIndexOf('\t');
    files.push(record.slice(tab + 1));
  }
  return [...new Set(files)].sort();
}

function containsBinaryHunk(patchPath: string): boolean {
  const text = fs.readFileSync(patchPath, 'utf8');
  return text.includes('@@ binary @@') || text.includes('GIT binary patch');
}

/** 目标工作区里这些文件是否带着未提交改动（仅 git 仓库能判断）。 */
function dirtyAmong(root: string, gitRoot: string | null, files: readonly string[]): string[] {
  if (!gitRoot) return [];
  const result = gitRaw(['status', '--porcelain', '-z', '--untracked-files=all'], root);
  if (!result.ok) return [];
  const dirty = new Set<string>();
  for (const record of result.stdout.split('\0')) {
    if (record.length < 4) continue;
    // 形如 " M src/a.ts" / "?? new.txt" / "R  old -> new"（rename 在 -z 下分两条记录）。
    const target = record.slice(3).trim();
    if (!target) continue;
    dirty.add(target.split(path.sep).join('/'));
  }
  const prefix = path.relative(gitRoot, root).split(path.sep).join('/');
  const scoped = (file: string): string => (prefix && prefix !== '.' ? `${prefix}/${file}` : file);
  return files.filter((file) => dirty.has(scoped(file)));
}

function lanePatchPath(lane: OrchestrationLane): string | undefined {
  const candidate = lane.closed?.patchPath;
  if (!candidate) return undefined;
  // lane.files.json 是「无法产出内容 diff」时的清单，不是可应用的 patch。
  return candidate.toLowerCase().endsWith('.json') ? undefined : candidate;
}

/**
 * 汇总一次 Run 的集成计划。只读：不写工作区、不改账本，可以随便调。
 * lane 必须已 close —— 开着的 lane 现场还在变，合进去的一半成果没法追。
 */
export function planIntegration(run: OrchestrationRun, options: IntegrateOptions = {}): IntegrationPlan {
  const wanted = options.lanes && options.lanes.length > 0 ? new Set(options.lanes) : undefined;
  const warnings: string[] = [];
  const byRoot = new Map<string, IntegrateLanePlan[]>();

  for (const lane of Object.values(run.lanes ?? {})) {
    if (wanted && !wanted.has(lane.id)) continue;
    const root = path.resolve(lane.workspaceRoot);
    const mode: LaneMode = lane.mode ?? 'worktree';
    const base: IntegrateLanePlan = {
      laneId: lane.id,
      mode,
      workspaceRoot: root,
      status: 'ready',
      files: [],
      dirtyFiles: [],
    };
    if (mode === 'inplace') {
      byRoot.set(root, [...(byRoot.get(root) ?? []), { ...base, status: 'inplace' }]);
      continue;
    }
    const patchPath = lanePatchPath(lane);
    if (!lane.closed) {
      byRoot.set(root, [...(byRoot.get(root) ?? []), { ...base, status: 'not-closed' }]);
      continue;
    }
    if (!patchPath) {
      byRoot.set(root, [...(byRoot.get(root) ?? []), { ...base, status: 'no-changes' }]);
      continue;
    }
    if (!fs.existsSync(patchPath)) {
      byRoot.set(root, [
        ...(byRoot.get(root) ?? []),
        { ...base, status: 'missing-patch', patchPath, error: `patch not found: ${patchPath}` },
      ]);
      continue;
    }
    let files: string[] = [];
    try {
      if (containsBinaryHunk(patchPath)) {
        byRoot.set(root, [
          ...(byRoot.get(root) ?? []),
          {
            ...base,
            status: 'unsupported',
            patchPath,
            error: 'patch contains binary hunks; apply it manually with `git apply`',
          },
        ]);
        continue;
      }
      files = patchFiles(patchPath);
    } catch (error) {
      byRoot.set(root, [
        ...(byRoot.get(root) ?? []),
        { ...base, status: 'unsupported', patchPath, error: error instanceof Error ? error.message : String(error) },
      ]);
      continue;
    }
    if (files.length === 0) {
      byRoot.set(root, [...(byRoot.get(root) ?? []), { ...base, status: 'no-changes', patchPath }]);
      continue;
    }
    byRoot.set(root, [...(byRoot.get(root) ?? []), { ...base, patchPath, files }]);
  }

  const targets: IntegrationPlan['targets'] = [];
  for (const [workspaceRoot, lanes] of byRoot) {
    const gitRoot = gitTopLevel(workspaceRoot);
    const blocked: string[] = [];
    if (!fs.existsSync(workspaceRoot)) blocked.push(`workspace missing: ${workspaceRoot}`);
    for (const lane of lanes) {
      if (lane.status !== 'ready' || !lane.patchPath) continue;
      const dirtyFiles = dirtyAmong(workspaceRoot, gitRoot, lane.files);
      lane.dirtyFiles = dirtyFiles;
      if (dirtyFiles.length > 0) {
        lane.status = 'conflict';
        lane.error = `target has uncommitted changes in: ${dirtyFiles.join(', ')}`;
      } else {
        // 预检：逐条独立 --check。跨 lane 的相互冲突由「备份 + 整体回滚」兜住，
        // 因为 --check 校验的是当前工作树，看不出一条还没来得及应用的 patch 的效果。
        const check = gitRaw(['apply', '--check', lane.patchPath], workspaceRoot);
        if (!check.ok) {
          lane.status = 'conflict';
          lane.error = check.stderr.trim() || 'git apply --check failed';
        }
      }
      if (lane.status === 'conflict' && lane.error) blocked.push(`lane ${lane.laneId}: ${lane.error}`);
    }
    // 同一文件被多条 lane 改：合起来必冲突，不如提前说清楚（不是错误，可能仍有意义的部分）。
    const seen = new Map<string, string>();
    for (const lane of lanes) {
      for (const file of lane.files) {
        const other = seen.get(file);
        if (other) {
          warnings.push(
            `lanes ${other} and ${lane.laneId} both touch ${file}; they will be applied in order and may conflict`,
          );
        } else {
          seen.set(file, lane.laneId);
        }
      }
    }
    targets.push({
      workspaceRoot,
      gitRoot,
      lanes,
      ready: blocked.length === 0 && lanes.some((l) => l.status === 'ready'),
      blocked,
    });
  }

  return { runId: run.id, targets, warnings };
}

/** 备份被触及文件 → 依次应用 → 任何一步失败整批还原。返回写进去的文件列表。 */
function applyGroup(
  root: string,
  lanes: readonly IntegrateLanePlan[],
  backupRoot: string,
): { files: string[]; error?: string } {
  const files = [...new Set(lanes.flatMap((lane) => lane.files))].sort();
  const backups = new Map<string, string | null>();
  for (const file of files) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) {
      backups.set(file, null);
      continue;
    }
    const target = path.join(backupRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    backups.set(file, target);
  }

  const restore = (): void => {
    for (const [file, backup] of backups) {
      const target = path.join(root, file);
      try {
        if (backup === null) fs.rmSync(target, { force: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(backup, target);
        }
      } catch {
        // 还原失败只能留现场：错误消息里已经点明被触及的文件列表。
      }
    }
  };

  for (const lane of lanes) {
    if (!lane.patchPath) continue;
    const applied = gitRaw(['apply', '--whitespace=nowarn', lane.patchPath], root);
    if (!applied.ok) {
      restore();
      return { files, error: `lane ${lane.laneId}: ${applied.stderr.trim() || 'git apply failed'}` };
    }
  }
  return { files };
}

/**
 * 执行集成：默认只做计划（dry-run），`apply: true` 才写工作区。
 * 写工作树但**不提交**：是否 commit / 开分支 / revert 仍由用户决定。
 */
export function integrateRun(
  run: OrchestrationRun,
  options: IntegrateOptions & { apply?: boolean } = {},
): IntegrateResult {
  const plan = planIntegration(run, options);
  const results: IntegrateResult['results'] = [];
  for (const target of plan.targets) {
    const lanes = target.lanes.filter((lane) => lane.status === 'ready');
    if (lanes.length === 0) {
      results.push({ workspaceRoot: target.workspaceRoot, status: 'skipped', files: [] });
      continue;
    }
    if (target.blocked.length > 0) {
      // 一组里有一条冲突就整组不做：半组合并比不合更难收拾。
      results.push({
        workspaceRoot: target.workspaceRoot,
        status: 'skipped',
        files: [],
        error: target.blocked.join('; '),
      });
      continue;
    }
    if (options.apply !== true) {
      results.push({
        workspaceRoot: target.workspaceRoot,
        status: 'dry-run',
        files: [...new Set(lanes.flatMap((lane) => lane.files))].sort(),
      });
      continue;
    }
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-integrate-'));
    try {
      const outcome = applyGroup(target.workspaceRoot, lanes, backupRoot);
      results.push({
        workspaceRoot: target.workspaceRoot,
        status: outcome.error ? 'failed' : 'applied',
        files: outcome.error ? [] : outcome.files,
        error: outcome.error,
      });
    } finally {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }
  return { plan, applied: options.apply === true, results };
}

/**
 * 集成记录不写事件账本：`integrate` 几乎总在 Run 终态后执行，而终态账本是冻结的
 * （reducer 会拒绝任何追加）。落在 `artifacts/integration.jsonl`，一合一行，便于事后追溯。
 */
export function appendIntegrationLog(file: string, result: IntegrateResult): void {
  const record = {
    at: new Date().toISOString(),
    runId: result.plan.runId,
    applied: result.applied,
    targets: result.plan.targets.map((target) => ({
      workspaceRoot: target.workspaceRoot,
      lanes: target.lanes.map((lane) => ({
        laneId: lane.laneId,
        mode: lane.mode,
        status: lane.status,
        files: lane.files,
        error: lane.error,
      })),
    })),
    results: result.results,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

const STATUS_LABEL: Record<IntegrateLaneStatus, string> = {
  ready: '✓ ready',
  'no-changes': '· no changes',
  'not-closed': '! lane still open (close it first)',
  inplace: '· written in place',
  'missing-patch': '! patch missing',
  unsupported: '! not auto-appliable',
  conflict: '! conflict',
};

/** 供 CLI 输出：先按工作区分组，再给一行总账（合了几个文件、有没有被挡）。 */
export function formatIntegration(result: IntegrateResult): string {
  const lines: string[] = [];
  for (const target of result.plan.targets) {
    lines.push(`workspace ${target.workspaceRoot}${target.gitRoot ? '' : ' (not a git repository)'}`);
    for (const lane of target.lanes) {
      lines.push(
        `  ${STATUS_LABEL[lane.status]}  lane ${lane.laneId} (${lane.mode})` +
          `${lane.files.length > 0 ? `  ${lane.files.length} file(s)` : ''}` +
          `${lane.error ? `\n      ${lane.error}` : ''}` +
          `${lane.dirtyFiles.length > 0 ? `\n      dirty: ${lane.dirtyFiles.join(', ')}` : ''}`,
      );
    }
    if (target.blocked.length > 0) lines.push(`  blocked: ${target.blocked.length} lane(s) need attention`);
    const outcome = result.results.find((item) => item.workspaceRoot === target.workspaceRoot);
    if (outcome) {
      lines.push(
        `  result: ${outcome.status}` +
          `${outcome.files.length > 0 ? ` (${outcome.files.length} file(s))` : ''}` +
          `${outcome.error ? `\n    ${outcome.error}` : ''}`,
      );
    }
  }
  for (const warning of result.plan.warnings) lines.push(`warning: ${warning}`);
  if (!result.applied) {
    const pending = result.results.filter((item) => item.status === 'dry-run').length;
    lines.push(
      pending > 0
        ? `dry run — nothing was written. Re-run with --apply to merge ${result.results
            .filter((item) => item.status === 'dry-run')
            .reduce((total, item) => total + item.files.length, 0)} file(s).`
        : 'dry run — nothing to merge.',
    );
  }
  return `${lines.join('\n')}\n`;
}
