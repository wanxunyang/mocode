import { readFile } from 'node:fs/promises';
import { jailResolve } from '../../sandbox/index.js';
import {
  commitChangeSet,
  createChangeSet,
  normalizeContentHash,
  summarizeChangeSet,
} from '../../changeset/index.js';
import type { Tool, ToolOutcome } from '../types.js';

function conflict(path: string, details: string): ToolOutcome {
  return {
    status: 'error',
    code: 'CHANGE_CONFLICT',
    retryable: false,
    changedFiles: [],
    staleFiles: [path],
    output: `CHANGE_CONFLICT: ${path} was not changed. ${details} Do not retry these arguments. Call read_file on this exact path and copy both its latest hash and exact target text before editing again.`,
  };
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace one exact string in a file transactionally. expected_hash is required and must be copied from a fresh read_file artifact header. If the file changes after that read, the edit is rejected without writing.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'The original text; must occur exactly once.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      expected_hash: { type: 'string', description: 'sha256 hash from the latest read_file artifact header.' },
    },
    required: ['path', 'old_string', 'new_string', 'expected_hash'],
  },
  async execute(args, ctx) {
    const file = String(args.path);
    const oldString = String(args.old_string);
    const newString = String(args.new_string);
    const expectedHash = normalizeContentHash(String(args.expected_hash));
    if (!expectedHash) return conflict(file, 'expected_hash 必须是 sha256:<64 hex>。');

    const data = await readFile(jailResolve(file), 'utf8');
    const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const oldNormalized = oldString.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const newNormalized = newString.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const count = normalized.split(oldNormalized).length - 1;

    if (count === 0) {
      return conflict(file, 'old_string 未找到；请重新 read_file 并复制最新内容。');
    }
    if (count > 1) {
      return conflict(file, `old_string 出现 ${count} 次；请增加上下文使其唯一。`);
    }
    const updated = normalized.replace(oldNormalized, () => newNormalized);
    const replacement = data.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
    const result = await commitChangeSet(createChangeSet([{
      path: file,
      operation: 'update',
      expectedHash,
      replacement,
    }]), ctx?.signal);
    if (result.status === 'conflict') {
      const item = result.conflicts[0];
      return conflict(file, `expected=${item?.expectedHash ?? 'missing'}, actual=${item?.actualHash ?? 'missing'}。请重新读取后再编辑。`);
    }
    if (result.status === 'failed') {
      return {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        changedFiles: [],
        output: `错误:ChangeSet 提交失败并已执行恢复: ${result.error}`,
      };
    }
    const summary = summarizeChangeSet(result.changeSet);
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      changedFiles: result.changedFiles,
      changeSet: summary,
      output: result.changedFiles.length === 0
        ? `文件 ${file} 内容未变化 (ChangeSet ${summary.id})。`
        : `已事务化编辑 ${file} (ChangeSet ${summary.id}, sha256=${summary.changes[0]?.afterHash})。`,
    };
  },
};
