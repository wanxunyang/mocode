import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { jailResolve } from '../sandbox/index.js';
import { beginPathMutation, endPathMutation } from '../rollback/index.js';
import {
  canonicalFileResourceKey,
  toolResourceLockManager,
  type ResourceLockRequest,
} from '../tools/resource-lock.js';
import type {
  ChangeConflict,
  ChangeSet,
  ChangeSetResult,
  ChangeSetSummary,
  ContentHash,
  FileChange,
  PreparedChangeSet,
  PreparedFileChange,
  TextEdit,
} from './types.js';

export type {
  ChangeConflict,
  ChangeSet,
  ChangeSetResult,
  ChangeSetSummary,
  ContentHash,
  FileChange,
  FileOperation,
  FileVersion,
  PreparedChangeSet,
  PreparedFileChange,
  TextEdit,
} from './types.js';

export function contentHash(content: Buffer | string): ContentHash {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export function normalizeContentHash(value: string): ContentHash | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.startsWith('sha256:') ? normalized.slice(7) : normalized;
  return /^[a-f0-9]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  let output = '';
  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) ||
      edit.start < cursor || edit.end < edit.start || edit.end > source.length) {
      throw new Error(`无效或重叠的 TextEdit 范围: ${edit.start}..${edit.end}`);
    }
    output += source.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  return output + source.slice(cursor);
}

async function readCurrent(file: string): Promise<Buffer | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`目标不是普通文件: ${file}`);
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function actualHash(content: Buffer | null): ContentHash | null {
  return content === null ? null : contentHash(content);
}

export function createChangeSet(changes: FileChange[]): ChangeSet {
  return { id: randomUUID(), createdAt: Date.now(), changes };
}

export type DryRunResult =
  | { ok: true; changeSet: PreparedChangeSet }
  | { ok: false; conflicts: ChangeConflict[] };

/** Validate every precondition and calculate every output without touching disk. */
export async function dryRunChangeSet(changeSet: ChangeSet): Promise<DryRunResult> {
  const prepared: PreparedFileChange[] = [];
  const conflicts: ChangeConflict[] = [];
  const seen = new Set<string>();
  for (const change of changeSet.changes) {
    const absolutePath = jailResolve(change.path);
    const identity = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
    if (seen.has(identity)) {
      conflicts.push({
        path: change.path,
        expectedHash: change.expectedHash,
        actualHash: null,
        reason: '同一 ChangeSet 不能多次修改同一路径。',
      });
      continue;
    }
    seen.add(identity);
    const before = await readCurrent(absolutePath);
    const beforeHash = actualHash(before);
    if (beforeHash !== change.expectedHash) {
      conflicts.push({
        path: change.path,
        expectedHash: change.expectedHash,
        actualHash: beforeHash,
        reason: '文件内容已变化或存在状态与预期不一致。',
      });
      continue;
    }
    try {
      if (change.operation === 'create' && before !== null) throw new Error('创建目标已经存在。');
      if (change.operation !== 'create' && before === null) throw new Error('更新或删除目标不存在。');
      if (change.operation === 'delete' && (change.replacement !== undefined || change.edits?.length)) {
        throw new Error('删除操作不能包含 replacement 或 edits。');
      }
      if (change.replacement !== undefined && change.edits?.length) {
        throw new Error('FileChange 不能同时包含 replacement 和 edits。');
      }
      let after: Buffer | null = null;
      if (change.operation !== 'delete') {
        const source = before?.toString('utf8') ?? '';
        const next = change.replacement ?? applyTextEdits(source, change.edits ?? []);
        after = Buffer.from(next, 'utf8');
      }
      prepared.push({
        ...change,
        absolutePath,
        before,
        after,
        beforeHash,
        afterHash: actualHash(after),
      });
    } catch (error) {
      conflicts.push({
        path: change.path,
        expectedHash: change.expectedHash,
        actualHash: beforeHash,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return conflicts.length > 0
    ? { ok: false, conflicts }
    : { ok: true, changeSet: { ...changeSet, prepared } };
}

async function removeIfPresent(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

async function verifyPreparedVersions(prepared: readonly PreparedFileChange[]): Promise<ChangeConflict[]> {
  const conflicts: ChangeConflict[] = [];
  for (const change of prepared) {
    const current = await readCurrent(change.absolutePath);
    const currentHash = actualHash(current);
    if (currentHash !== change.beforeHash) {
      conflicts.push({
        path: change.path,
        expectedHash: change.beforeHash,
        actualHash: currentHash,
        reason: 'dry-run 后文件又被外部修改。',
      });
    }
  }
  return conflicts;
}

function lockRequests(changeSet: ChangeSet): ResourceLockRequest[] {
  return changeSet.changes.map((change) => ({
    key: canonicalFileResourceKey(change.path),
    scope: 'resource' as const,
    mode: 'write' as const,
  }));
}

async function missingParentDirectories(file: string): Promise<string[]> {
  const result: string[] = [];
  let cursor = path.dirname(file);
  while (true) {
    try {
      await stat(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      result.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return result;
}

/** Commit is process-transactional: every target is prepared first and any failed swap is compensated. */
export async function commitChangeSet(
  changeSet: ChangeSet,
  signal?: AbortSignal,
): Promise<ChangeSetResult> {
  try {
    return await toolResourceLockManager.withLocks(lockRequests(changeSet), signal, async () => {
      if (signal?.aborted) {
        return { status: 'failed', changeSet, error: 'ChangeSet 在提交前被中断。', changedFiles: [] };
      }
      const dryRun = await dryRunChangeSet(changeSet);
      if (!dryRun.ok) {
        return { status: 'conflict', changeSet, conflicts: dryRun.conflicts, changedFiles: [] };
      }
      const effective = dryRun.changeSet.prepared.filter((change) => change.beforeHash !== change.afterHash);
      if (effective.length === 0) {
        return { status: 'committed', changeSet: dryRun.changeSet, changedFiles: [] };
      }

      const captures = effective.map((change) => ({
        change,
        capture: beginPathMutation(change.absolutePath),
      }));
      const createdDirectories = new Set<string>();
      const tempByPath = new Map<string, string>();
      const backupByPath = new Map<string, string>();
      const committed: PreparedFileChange[] = [];
      try {
        // Prepare all parent directories and temp files before replacing any target.
        for (const change of effective) {
          for (const directory of await missingParentDirectories(change.absolutePath)) {
            createdDirectories.add(directory);
          }
          await mkdir(path.dirname(change.absolutePath), { recursive: true });
          if (change.after !== null) {
            const temp = path.join(path.dirname(change.absolutePath), `.${path.basename(change.absolutePath)}.${changeSet.id}.tmp`);
            await writeFile(temp, change.after, { flag: 'wx' });
            if (change.before !== null) {
              const currentMode = (await stat(change.absolutePath)).mode;
              await chmod(temp, currentMode);
            }
            tempByPath.set(change.absolutePath, temp);
          }
        }

        // Close the dry-run/commit gap before the first visible replacement.
        const conflicts = await verifyPreparedVersions(effective);
        if (conflicts.length > 0) {
          return { status: 'conflict', changeSet, conflicts, changedFiles: [] };
        }

        // Once the first swap starts, finish or compensate even if the caller aborts.
        for (const change of effective) {
          const backup = path.join(path.dirname(change.absolutePath), `.${path.basename(change.absolutePath)}.${changeSet.id}.bak`);
          if (change.before !== null) {
            if (change.after === null) await rename(change.absolutePath, backup);
            else await copyFile(change.absolutePath, backup);
            backupByPath.set(change.absolutePath, backup);
          }
          committed.push(change);
          const temp = tempByPath.get(change.absolutePath);
          // Same-directory rename is the atomic visibility boundary for creates/updates.
          if (temp) await rename(temp, change.absolutePath);
        }

        for (const { capture } of captures) endPathMutation(capture, `changeset:${changeSet.id}`);
        for (const backup of backupByPath.values()) {
          await removeIfPresent(backup).catch(() => undefined);
        }
        return {
          status: 'committed',
          changeSet: dryRun.changeSet,
          changedFiles: effective.map((change) => change.path),
        };
      } catch (error) {
        // Reverse every visible replacement. Backups are kept until the full set succeeds.
        for (const change of [...committed].reverse()) {
          try {
            await removeIfPresent(change.absolutePath);
            const backup = backupByPath.get(change.absolutePath);
            if (backup) {
              await rename(backup, change.absolutePath);
              backupByPath.delete(change.absolutePath);
            }
          } catch {
            // Continue restoring the remaining files; report the original commit failure below.
          }
        }
        return {
          status: 'failed',
          changeSet,
          error: error instanceof Error ? error.message : String(error),
          changedFiles: [],
        };
      } finally {
        for (const temp of tempByPath.values()) await removeIfPresent(temp).catch(() => undefined);
        // A backup left after compensation failure is deliberately preserved for manual recovery.
        for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
          await rmdir(directory).catch(() => undefined);
        }
      }
    });
  } catch (error) {
    return {
      status: 'failed',
      changeSet,
      error: error instanceof Error ? error.message : String(error),
      changedFiles: [],
    };
  }
}

export function summarizeChangeSet(changeSet: PreparedChangeSet): ChangeSetSummary {
  const effective = changeSet.prepared.filter((change) => change.beforeHash !== change.afterHash);
  return {
    id: changeSet.id,
    changedFiles: effective.map((change) => change.path),
    changes: effective.map((change) => ({
      path: change.path,
      operation: change.operation,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
    })),
  };
}