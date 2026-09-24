import { readFile, stat } from 'node:fs/promises';
import {
  commitChangeSet,
  contentHash,
  createChangeSet,
  normalizeContentHash,
  summarizeChangeSet,
  type ContentHash,
  type FileOperation,
} from '../../changeset/index.js';
import { jailResolve } from '../../sandbox/index.js';
import { isProbablyBinary } from '../../attachments/image.js';
import type { Tool, ToolOutcome } from '../types.js';

/** append 需要把整个文件读进内存再全量重写(ChangeSet 的 backup + 原子 rename 语义决定),
 *  故与 read_file 同款 32 MiB 闸门:超过就指路 shell 重定向,不把进程内存顶死。 */
const MAX_APPEND_TARGET_BYTES = 32 * 1024 * 1024;

/** 二进制嗅探只需文件头,与 read_file 同口径(16KB)。 */
const SNIFF_BYTES = 16 * 1024;

function conflict(path: string, details: string): ToolOutcome {
  return {
    status: 'error',
    code: 'CHANGE_CONFLICT',
    retryable: false,
    changedFiles: [],
    staleFiles: [path],
    output: `CHANGE_CONFLICT: ${path} was not changed. ${details} Do not retry these arguments. Call read_file on this exact path, then use the returned hash; use expected_hash=null only if read_file reports that the path is missing.`,
  };
}

function invalid(path: string, message: string): ToolOutcome {
  return {
    status: 'error',
    code: 'INVALID_ARGUMENTS',
    retryable: false,
    changedFiles: [],
    output: `错误:${path}: ${message}`,
  };
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create or replace one file transactionally. expected_hash may be omitted (or null) only for create-only writes to a path that must not exist; overwriting requires the hash from a fresh read_file artifact header.\n' +
    'To ADD to an existing file (logs, growing docs, staged generation of a long file), pass append=true instead of re-sending the whole content: only the new text goes in `content`. ' +
    'append needs NO expected_hash and NO prior read_file (concurrency is handled by the file lock); it creates the file when missing, and it appends bytes VERBATIM — ' +
    'if the file does not end with a newline, start your content with "\\n" or the last line will merge with yours.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: {
        type: 'string',
        description:
          'File content. With append=false (default): the FULL new content. With append=true: only the text to add at the end.',
      },
      expected_hash: {
        type: ['string', 'null'],
        description:
          'Optional sha256 hash from read_file. Omit or pass null when the path must not exist, or when append=true (append reads the current content itself and is lock-protected).',
      },
      append: {
        type: 'boolean',
        description:
          'Append `content` to the end of the file instead of replacing it (default false). Creates the file if missing. Text files only; binary targets are rejected.',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const file = String(args.path);
    const content = String(args.content);
    const append = args.append === true;
    let expectedHash: ContentHash | null = null;
    // Missing and explicit null are both safe create-only requests. They never
    // overwrite: ChangeSet compares expectedHash=null against the current path.
    if (args.expected_hash != null) {
      expectedHash = normalizeContentHash(String(args.expected_hash));
      if (!expectedHash) return conflict(file, 'expected_hash 必须是 null 或 sha256:<64 hex>。');
    }
    let operation: FileOperation = expectedHash === null ? 'create' : 'update';
    let replacement = content;

    if (append) {
      // append 的实现策略:工具层读现状 + 拼接 + 以 update 提交,**完全复用** ChangeSet 事务机器 ——
      // 于是 rollback/diff/changeSet 追踪、原子 temp+rename 写回全部照旧,不新增第二套事务语义。
      //
      // 并发安全:读取发生在锁外(write_file 声明 delegatesResourceLocks,锁由 commitChangeSet 持有),
      // 所以「读到」与「提交」之间存在窗口。这个窗口由 expectedHash 兜底 —— 下面把读到的内容 hash
      // 填进 expectedHash,dryRun 会拿它与提交瞬间的真实内容比对:期间有人改过就报 CHANGE_CONFLICT
      // (fail-loud,让模型重读重试),**绝不静默覆盖别人的追加**。这是 append 不需要模型先 read_file
      // 的原因:hash 由工具自己算,正确性由冲突检测保证,而非靠模型复述。
      let absolute: string;
      try {
        absolute = jailResolve(file);
      } catch (error) {
        return invalid(file, error instanceof Error ? error.message : String(error));
      }
      let before: Buffer | null = null;
      try {
        // 先 stat 再 read:体积闸门必须在字节进内存**之前**生效,否则一个 200MB 的日志
        // 已经分配了 200MB 才被拒绝,闸门形同虚设(read_file 同款顺序)。
        const info = await stat(absolute);
        if (info.isDirectory()) {
          return invalid(file, '是目录,不能追加内容。');
        }
        if (!info.isFile()) {
          return invalid(file, '不是普通文件(设备/套接字/特殊文件),无法追加。');
        }
        if (info.size > MAX_APPEND_TARGET_BYTES) {
          return invalid(
            file,
            `有 ${(info.size / 1024 / 1024).toFixed(1)} MB,超过 append 的 32.0 MB 上限` +
              '(追加需整文件载入内存以走事务化写回)。超大日志请用 run_command 的 shell 重定向: `... >> <path>`。',
          );
        }
        before = await readFile(absolute);
      } catch (error) {
        const e = error as NodeJS.ErrnoException;
        // ENOENT = 文件还不存在:append 语义等同 shell `>>`,直接创建。其余错误如实上报。
        if (e?.code !== 'ENOENT') {
          return {
            status: 'error',
            code: 'EXECUTION_ERROR',
            retryable: false,
            changedFiles: [],
            output: `错误:读取 ${file} 以便追加失败: ${e?.message ?? String(error)}`,
          };
        }
      }
      if (before !== null) {
        // 二进制拒绝是 append 特有的风险:全量覆盖时坏数据只影响这一次写入,
        // 而 append 会把「解码坏掉的旧内容」永久写回原文件,等于静默损毁数据。
        if (isProbablyBinary(before.subarray(0, SNIFF_BYTES))) {
          return invalid(
            file,
            '是二进制文件,不能按文本追加(utf8 往返会损毁原有字节)。如需追加二进制请用 run_command。',
          );
        }
        // 模型显式给了 hash 就用它校验(不匹配交给 dryRun 报 conflict);没给则用实际 hash ——
        // append 是日志/分段生成的高频操作,强制「先 read_file 拿 hash」纯属负担,
        // 正确性由提交前的 hash 比对保证(fail-loud),而非靠模型复述。
        if (expectedHash === null) expectedHash = contentHash(before);
        operation = 'update';
        // 原样拼接,不自动补换行:尊重 shell `>>` 语义,不擅自改数据。
        // 缺换行的黏行风险在 description 里显式告知模型(让它在 content 开头带 \n)。
        replacement = before.toString('utf8') + content;
      } else {
        operation = expectedHash === null ? 'create' : 'update';
      }
    }

    const result = await commitChangeSet(
      createChangeSet([
        {
          path: file,
          operation,
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
        `expected=${item?.expectedHash ?? 'missing'}, actual=${item?.actualHash ?? 'missing'}。请重新读取后再写入。`,
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
    const verb = append ? '已追加到' : '已事务化写入';
    const sizeNote = append ? `${content.length} 字符追加, 全文 ${replacement.length} 字符` : `${content.length} 字符`;
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      changedFiles: result.changedFiles,
      changeSet: summary,
      output:
        result.changedFiles.length === 0
          ? `文件 ${file} 内容未变化 (ChangeSet ${summary.id})。`
          : `${verb} ${file} (${sizeNote}, ChangeSet ${summary.id}, sha256=${summary.changes[0]?.afterHash})。`,
    };
  },
};
