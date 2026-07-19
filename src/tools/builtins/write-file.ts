import {
  commitChangeSet,
  createChangeSet,
  normalizeContentHash,
  summarizeChangeSet,
  type ContentHash,
} from '../../changeset/index.js';
import type { Tool, ToolOutcome } from '../types.js';

function conflict(path: string, details: string): ToolOutcome {
  return {
    status: 'error',
    code: 'CHANGE_CONFLICT',
    retryable: false,
    changedFiles: [],
    staleFiles: [path],
    output: `错误:写入冲突 ${path}，磁盘未发生变化。${details}`,
  };
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create or replace one file transactionally. Pass expected_hash=null only for a new path; overwriting requires the hash from a fresh read_file artifact header.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Full file content' },
      expected_hash: {
        type: ['string', 'null'],
        description: 'sha256 hash from read_file, or null when the path must not exist.',
      },
    },
    required: ['path', 'content', 'expected_hash'],
  },
  async execute(args, ctx) {
    const file = String(args.path);
    const content = String(args.content);
    let expectedHash: ContentHash | null = null;
    if (args.expected_hash !== null) {
      expectedHash = normalizeContentHash(String(args.expected_hash));
      if (!expectedHash) return conflict(file, 'expected_hash 必须是 null 或 sha256:<64 hex>。');
    }
    const operation = expectedHash === null ? 'create' as const : 'update' as const;
    const result = await commitChangeSet(createChangeSet([{
      path: file,
      operation,
      expectedHash,
      replacement: content,
    }]), ctx?.signal);

    if (result.status === 'conflict') {
      const item = result.conflicts[0];
      return conflict(file, `expected=${item?.expectedHash ?? 'missing'}, actual=${item?.actualHash ?? 'missing'}。请重新读取后再写入。`);
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
        : `已事务化写入 ${file} (${content.length} 字符, ChangeSet ${summary.id}, sha256=${summary.changes[0]?.afterHash})。`,
    };
  },
};