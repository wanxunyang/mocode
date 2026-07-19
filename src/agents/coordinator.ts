import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitChangeSet, contentHash, createChangeSet, type ChangeSet, type FileChange } from '../changeset/index.js';
import { getSandboxRoot, withSandboxRoot } from '../sandbox/index.js';
import type { ValidationResult } from '../verification/index.js';
import type { ChatUsage } from '../llm/index.js';

export type SubAgentStatus = 'completed' | 'failed' | 'aborted' | 'conflict';

export interface SubAgentResult {
  status: SubAgentStatus;
  findings: string[];
  readSet: string[];
  changeSet: ChangeSet | null;
  verification: ValidationResult | null;
  summary: string | null;
  transcript: string;
  usage: ChatUsage;
}

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', '.mocode']);

async function filesBelow(root: string, dir = root, out: Map<string, Buffer> = new Map()): Promise<Map<string, Buffer>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesBelow(root, absolute, out);
    else if (entry.isFile()) out.set(path.relative(root, absolute).replaceAll('\\', '/'), await readFile(absolute));
  }
  return out;
}

function text(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('子 Agent overlay 暂不支持合并二进制文件。');
  return buffer.toString('utf8');
}

function diffToChangeSet(before: Map<string, Buffer>, after: Map<string, Buffer>): ChangeSet | null {
  const changes: FileChange[] = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(file);
    const newValue = after.get(file);
    if (oldValue && newValue && oldValue.equals(newValue)) continue;
    if (!oldValue && newValue) changes.push({ path: file, operation: 'create', expectedHash: null, replacement: text(newValue) });
    else if (oldValue && !newValue) changes.push({ path: file, operation: 'delete', expectedHash: contentHash(oldValue) });
    else if (oldValue && newValue) changes.push({ path: file, operation: 'update', expectedHash: contentHash(oldValue), replacement: text(newValue) });
  }
  return changes.length ? createChangeSet(changes) : null;
}

/** Execute a writer in a private filesystem overlay and return, but do not merge, its ChangeSet. */
export async function inOverlay<T>(run: () => Promise<T>): Promise<{ value: T; changeSet: ChangeSet | null }> {
  const base = path.resolve(getSandboxRoot() ?? process.cwd());
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'mocode-subagent-'));
  try {
    await cp(base, overlay, { recursive: true, filter: (source) => !EXCLUDED.has(path.basename(source)) });
    const before = await filesBelow(base);
    const value = await withSandboxRoot(overlay, run);
    return { value, changeSet: diffToChangeSet(before, await filesBelow(overlay)) };
  } finally {
    await rm(overlay, { recursive: true, force: true });
  }
}

/** The only merge point: ChangeSet preconditions and canonical resource locks prevent silent overwrite. */
export async function mergeSubAgentChangeSet(changeSet: ChangeSet | null, signal?: AbortSignal): Promise<'committed' | 'conflict' | 'failed'> {
  if (!changeSet) return 'committed';
  const result = await commitChangeSet(changeSet, signal);
  return result.status;
}
