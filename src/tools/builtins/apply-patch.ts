import { readFile } from 'node:fs/promises';
import { jailResolve } from '../../sandbox/index.js';
import {
  commitChangeSet,
  contentHash,
  createChangeSet,
  summarizeChangeSet,
  type FileChange,
} from '../../changeset/index.js';
import type { Tool, ToolOutcome } from '../types.js';

type PatchOperation =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: string[][] };

function invalid(message: string): Error {
  const error = new Error(message);
  error.name = 'PatchError';
  return error;
}

function parsePatch(input: string): PatchOperation[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch') throw invalid('patch 必须以 *** Begin Patch 开始。');
  const operations: PatchOperation[] = [];
  let i = 1;
  while (i < lines.length && lines[i] !== '*** End Patch') {
    const header = lines[i++];
    let match = /^\*\*\* Add File: (.+)$/.exec(header);
    if (match) {
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const line = lines[i++];
        if (!line.startsWith('+')) throw invalid(`Add File ${match[1]} 的内容行必须以 + 开头。`);
        body.push(line.slice(1));
      }
      operations.push({ kind: 'add', path: match[1], lines: body });
      continue;
    }
    match = /^\*\*\* Delete File: (.+)$/.exec(header);
    if (match) {
      operations.push({ kind: 'delete', path: match[1] });
      continue;
    }
    match = /^\*\*\* Update File: (.+)$/.exec(header);
    if (!match) throw invalid(`未知 patch 指令: ${header}`);
    const hunks: string[][] = [];
    while (i < lines.length && !lines[i].startsWith('*** ')) {
      if (!lines[i].startsWith('@@')) throw invalid(`Update File ${match[1]} 缺少 @@ hunk。`);
      i++;
      const hunk: string[] = [];
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
        hunk.push(lines[i++]);
      }
      hunks.push(hunk);
    }
    operations.push({ kind: 'update', path: match[1], hunks });
  }
  if (lines[i] !== '*** End Patch') throw invalid('patch 缺少 *** End Patch。');
  if (operations.length === 0) throw invalid('patch 不包含文件操作。');
  return operations;
}

function applyHunks(source: string, hunks: string[][], file: string): string {
  let current = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const hunk of hunks) {
    const before: string[] = [];
    const after: string[] = [];
    for (const line of hunk) {
      if (line.startsWith(' ')) {
        before.push(line.slice(1));
        after.push(line.slice(1));
      } else if (line.startsWith('-')) {
        before.push(line.slice(1));
      } else if (line.startsWith('+')) {
        after.push(line.slice(1));
      } else if (line === '\\ No newline at end of file') {
        continue;
      } else {
        throw invalid(`Update File ${file} 的 hunk 行必须以空格、+ 或 - 开头。`);
      }
    }
    const oldText = before.join('\n');
    const newText = after.join('\n');
    if (!oldText) throw invalid(`Update File ${file} 的 hunk 缺少上下文或删除行。`);
    const first = current.indexOf(oldText);
    if (first < 0) throw invalid(`Update File ${file} 的 hunk 与当前文件不匹配。`);
    if (current.indexOf(oldText, first + 1) >= 0) {
      throw invalid(`Update File ${file} 的 hunk 上下文不唯一，请增加上下文。`);
    }
    current = current.slice(0, first) + newText + current.slice(first + oldText.length);
  }
  return source.includes('\r\n') ? current.replace(/\n/g, '\r\n') : current;
}

async function buildChanges(operations: PatchOperation[]): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  for (const operation of operations) {
    if (operation.kind === 'add') {
      changes.push({
        path: operation.path,
        operation: 'create',
        expectedHash: null,
        replacement: operation.lines.join('\n'),
      });
      continue;
    }
    const raw = await readFile(jailResolve(operation.path));
    const expectedHash = contentHash(raw);
    if (operation.kind === 'delete') {
      changes.push({ path: operation.path, operation: 'delete', expectedHash });
      continue;
    }
    const source = raw.toString('utf8');
    changes.push({
      path: operation.path,
      operation: 'update',
      expectedHash,
      replacement: applyHunks(source, operation.hunks, operation.path),
    });
  }
  return changes;
}

function conflictOutcome(result: Extract<Awaited<ReturnType<typeof commitChangeSet>>, { status: 'conflict' }>): ToolOutcome {
  return {
    status: 'error',
    code: 'CHANGE_CONFLICT',
    retryable: false,
    changedFiles: [],
    staleFiles: result.conflicts.map((item) => item.path),
    output: [
      '错误:apply_patch 检测到内容冲突，磁盘未发生变化。',
      ...result.conflicts.map((item) =>
        `- ${item.path}: expected=${item.expectedHash ?? 'missing'}, actual=${item.actualHash ?? 'missing'} (${item.reason})`),
    ].join('\n'),
  };
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply a multi-file patch transactionally. Format: *** Begin Patch, then *** Add/Update/Delete File sections, then *** End Patch. All files are dry-run and hash-checked before any file is committed; failure leaves disk unchanged.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The complete *** Begin Patch ... *** End Patch document.' },
    },
    required: ['patch'],
  },
  async execute(args, ctx) {
    try {
      const changes = await buildChanges(parsePatch(String(args.patch)));
      const result = await commitChangeSet(createChangeSet(changes), ctx?.signal);
      if (result.status === 'conflict') return conflictOutcome(result);
      if (result.status === 'failed') {
        return { status: 'error', code: 'PATCH_INVALID', retryable: false, changedFiles: [], output: `错误:apply_patch 提交失败，已恢复磁盘: ${result.error}` };
      }
      const summary = summarizeChangeSet(result.changeSet);
      return {
        status: 'success',
        code: 'OK',
        retryable: false,
        changedFiles: result.changedFiles,
        changeSet: summary,
        output: `已事务化应用 ChangeSet ${summary.id}:\n${summary.changes.map((item) => `- ${item.operation} ${item.path} (${item.beforeHash ?? 'missing'} -> ${item.afterHash ?? 'missing'})`).join('\n')}`,
      };
    } catch (error) {
      return {
        status: 'error',
        code: 'PATCH_INVALID',
        retryable: false,
        changedFiles: [],
        output: `错误:apply_patch 无效，磁盘未发生变化: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};