import { readFile } from 'node:fs/promises';
import { jailResolve } from '../../sandbox/index.js';
import { commitChangeSet, createChangeSet, normalizeContentHash, summarizeChangeSet } from '../../changeset/index.js';
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
  description: `Replace content in a file transactionally. Two modes:

**String replacement (default):** old_string must occur EXACTLY once, copied verbatim from a fresh read_file output — never reconstruct from memory, summaries, or grep output (whitespace/indentation/line-ending details are lost there).

**Line-range:** line_start/line_end (1-based, inclusive) instead of old_string — for large blocks, repeated patterns, or hard-to-reproduce text.

expected_hash (sha256 from read_file artifact header) is required and must match the current file; changed-since-read edits are rejected — re-read and retry with the new hash.

Anti-patterns (will fail): old_string from memory/summary/stale call; multiple occurrences (add context to disambiguate); hash from another file or old read.`,
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path.' },
      old_string: {
        type: 'string',
        description:
          'String replacement mode: the exact text to replace (must occur once). Mutually exclusive with line_start/line_end.',
      },
      new_string: { type: 'string', description: 'The replacement text.' },
      line_start: {
        type: 'integer',
        description: 'Line-range mode: start line (1-based, inclusive). Mutually exclusive with old_string.',
      },
      line_end: {
        type: 'integer',
        description: 'Line-range mode: end line (1-based, inclusive). Mutually exclusive with old_string.',
      },
      expected_hash: {
        type: 'string',
        description: 'sha256 hash from the latest read_file artifact header (sha256:<64 hex>).',
      },
    },
    // 注意:expected_hash 故意不放进 schema 的 required。
    // 原因:缺失时若被 AJV 在 schema 层拦下,只会得到泛化的
    // "缺少必填字段 expected_hash",模型据此只补该字段、反而丢掉 path,形成乒乓失败。
    // 改为只在 execute 内校验(见下方 normalizeContentHash 检查),缺失时返回富指导信息,
    // 明确要求先 read_file 并复制最新 hash——与 write_file 的设计保持一致。
    required: ['path', 'new_string'],
  },
  async execute(args, ctx) {
    const file = String(args.path);
    const newString = String(args.new_string);
    const expectedHash = normalizeContentHash(String(args.expected_hash));
    if (!expectedHash) return conflict(file, 'expected_hash 必须是 sha256:<64 hex>。');

    const hasOldString = args.old_string !== undefined;
    const hasLineStart = args.line_start !== undefined;
    const hasLineEnd = args.line_end !== undefined;

    // 参数互斥检查
    if (hasOldString && (hasLineStart || hasLineEnd)) {
      return conflict(file, 'old_string 和 line_start/line_end 互斥，请选择一种模式。');
    }
    if (!hasOldString && (!hasLineStart || !hasLineEnd)) {
      return conflict(file, '必须提供 old_string 或同时提供 line_start 和 line_end。');
    }

    const data = await readFile(jailResolve(file), 'utf8');
    const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const newNormalized = newString.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let updated: string;

    if (hasOldString) {
      // String replacement mode
      const oldString = String(args.old_string);
      const oldNormalized = oldString.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const count = normalized.split(oldNormalized).length - 1;

      if (count === 0) {
        return conflict(file, 'old_string 未找到；请重新 read_file 并复制最新内容。');
      }
      if (count > 1) {
        return conflict(file, `old_string 出现 ${count} 次；请增加上下文使其唯一。`);
      }
      updated = normalized.replace(oldNormalized, () => newNormalized);
    } else {
      // Line-range mode
      const lineStart = Number(args.line_start);
      const lineEnd = Number(args.line_end);

      if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) {
        return conflict(file, 'line_start 和 line_end 必须是整数。');
      }
      if (lineStart < 1 || lineEnd < lineStart) {
        return conflict(
          file,
          `无效的 line range: line_start=${lineStart}, line_end=${lineEnd}。要求 line_start >= 1 且 line_end >= line_start。`,
        );
      }

      const lines = normalized.split('\n');
      if (lineEnd > lines.length) {
        return conflict(file, `line_end=${lineEnd} 超出文件范围 (共 ${lines.length} 行)。`);
      }

      // 替换指定行范围（1-based 转 0-based）
      const startIndex = lineStart - 1;
      const endIndex = lineEnd - 1;
      const newLines = newNormalized.split('\n');

      // 替换 lines[startIndex..endIndex] 为 newLines
      lines.splice(startIndex, endIndex - startIndex + 1, ...newLines);
      updated = lines.join('\n');
    }

    const replacement = data.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
    const result = await commitChangeSet(
      createChangeSet([
        {
          path: file,
          operation: 'update',
          expectedHash,
          replacement,
        },
      ]),
      ctx?.signal,
    );
    if (result.status === 'conflict') {
      const item = result.conflicts[0];
      return conflict(
        file,
        `expected=${item?.expectedHash ?? 'missing'}, actual=${item?.actualHash ?? 'missing'}。请重新读取后再编辑。`,
      );
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
      output:
        result.changedFiles.length === 0
          ? `文件 ${file} 内容未变化 (ChangeSet ${summary.id})。`
          : `已事务化编辑 ${file} (ChangeSet ${summary.id}, sha256=${summary.changes[0]?.afterHash})。`,
    };
  },
};
