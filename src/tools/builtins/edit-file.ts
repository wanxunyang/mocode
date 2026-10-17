import { readFile } from 'node:fs/promises';
import { jailResolve } from '../../sandbox/index.js';
import {
  commitChangeSet,
  contentHash,
  createChangeSet,
  normalizeContentHash,
  summarizeChangeSet,
} from '../../changeset/index.js';
import { isProbablyBinary } from '../../attachments/image.js';
import type { Tool, ToolOutcome } from '../types.js';

/** 二进制嗅探只需文件头,与 read_file / write_file 同口径(16KB)。 */
const SNIFF_BYTES = 16 * 1024;

function conflict(path: string, details: string): ToolOutcome {
  return {
    status: 'error',
    code: 'CHANGE_CONFLICT',
    retryable: false,
    changedFiles: [],
    staleFiles: [path],
    output: `CHANGE_CONFLICT: ${path} was not changed. ${details} Do not retry these arguments. Call read_file on this exact path and copy the exact target text (plus its latest hash if you pass expected_hash, which line-range mode requires) before editing again.`,
  };
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description: `The DEFAULT tool for changing an EXISTING file: transactional, surgical edits — use this instead of re-writing the whole file with write_file. Pick ONE of three modes per call:

**String replacement (default):** old_string must occur EXACTLY once; copy it verbatim from a fresh read_file output (see Tool policy — never reconstruct it from memory, summaries, or grep output). expected_hash is OPTIONAL in this mode: omit it and the tool checks the file itself (old_string must still match exactly once, and the commit is conflict-checked). If you do pass it, it must match the current file or the edit is rejected.

**Multiple replacements:** pass replacements: [{ old_string, new_string }, …] to apply MANY edits across the file in ONE atomic call. Each old_string must occur exactly once in the original file and the matches must not overlap; if ANY of them is missing, ambiguous, or overlapping, the whole call is rejected and nothing is written. Prefer this over write_file whenever you change several spots — it keeps each payload small and never touches unrelated content. Mutually exclusive with the single old_string and line-range modes.

**Line-range:** line_start/line_end (1-based, inclusive) instead of old_string — for large blocks, repeated patterns, or hard-to-reproduce text. Line numbers drift when a file changes, so expected_hash (sha256 from the read_file artifact header) is REQUIRED here; if it is stale, re-read and retry with the new hash.`,
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path.' },
      old_string: {
        type: 'string',
        description:
          'Single-replacement mode: the exact text to replace (must occur once). Mutually exclusive with replacements[] and line_start/line_end.',
      },
      new_string: {
        type: 'string',
        description: 'Single-replacement / line-range mode: the replacement text.',
      },
      replacements: {
        type: 'array',
        minItems: 1,
        description:
          'Multi-replacement mode: many edits applied ATOMICALLY in one call. Each old_string must occur exactly once in the current file and matches must not overlap; if any item is missing/ambiguous/overlapping the whole call is rejected and nothing is written. Mutually exclusive with old_string and line_start/line_end.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact text to replace (must occur once).' },
            new_string: { type: 'string', description: 'Its replacement.' },
          },
          required: ['old_string', 'new_string'],
        },
      },
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
        description:
          'sha256 hash from the latest read_file artifact header (sha256:<64 hex>). Optional for old_string / replacements modes; required for line-range mode.',
      },
    },
    // 注意:expected_hash 与模式专属字段(new_string / replacements / line_*)都不放进 schema required。
    // 原因:三模式互斥,必填字段取决于所选模式;AJV 只能表达「静态必填」,在 schema 层拦下只会得到
    // 泛化的「缺少必填字段 X」,模型据此只补该字段、反而丢掉 path,形成乒乓失败。故只在 execute 内
    // 按模式校验,缺失/互斥时返回富指导信息。
    required: ['path'],
  },
  async execute(args, ctx) {
    const file = String(args.path);
    const hasOldString = args.old_string !== undefined;
    const hasLineStart = args.line_start !== undefined;
    const hasLineEnd = args.line_end !== undefined;
    const hasReplacements = args.replacements !== undefined;
    const hasLineRange = hasLineStart || hasLineEnd;

    // 三模式互斥:old_string(single)/ replacements[](multi)/ line_start+line_end(line),一次恰好一种。
    const modeCount = (hasOldString ? 1 : 0) + (hasReplacements ? 1 : 0) + (hasLineRange ? 1 : 0);
    if (modeCount > 1) {
      return conflict(file, 'old_string、replacements[]、line_start/line_end 三种模式互斥,一次只能用一种。');
    }
    if (hasLineStart !== hasLineEnd) {
      return conflict(file, '行号模式必须同时提供 line_start 和 line_end。');
    }
    let mode: 'single' | 'multi' | 'line';
    if (hasOldString) mode = 'single';
    else if (hasReplacements) mode = 'multi';
    else if (hasLineStart && hasLineEnd) mode = 'line';
    else {
      return conflict(file, '必须提供 old_string、replacements[] 或同时提供 line_start 和 line_end 三者之一。');
    }
    if ((mode === 'single' || mode === 'line') && typeof args.new_string !== 'string') {
      return conflict(file, '必须提供字符串 new_string(要删除该段时传空串 "")。');
    }

    const toLf = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // multi:数组形状校验(schema 已守,这里给富指导并归一化 CRLF)。
    const multiEdits: Array<{ old: string; next: string }> = [];
    if (mode === 'multi') {
      const arr = args.replacements;
      if (!Array.isArray(arr) || arr.length === 0) {
        return conflict(file, 'replacements 必须是至少含 1 个 {old_string,new_string} 的数组。');
      }
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i] as unknown;
        if (
          !item ||
          typeof item !== 'object' ||
          typeof (item as Record<string, unknown>).old_string !== 'string' ||
          typeof (item as Record<string, unknown>).new_string !== 'string'
        ) {
          return conflict(file, `replacements[${i}] 必须是含字符串字段 old_string/new_string 的对象。`);
        }
        const rec = item as { old_string: string; new_string: string };
        if (!rec.old_string) return conflict(file, `replacements[${i}].old_string 不能为空。`);
        multiEdits.push({ old: toLf(rec.old_string), next: toLf(rec.new_string) });
      }
    }

    // expected_hash:缺省/null/空串都视为「未提供」。提供了就必须格式正确并严格校验。
    const rawHash = args.expected_hash;
    const hashProvided = rawHash !== undefined && rawHash !== null && String(rawHash).trim() !== '';
    let expectedHash = hashProvided ? normalizeContentHash(String(rawHash)) : null;
    if (hashProvided && !expectedHash) return conflict(file, 'expected_hash 必须是 sha256:<64 hex>。');
    if (mode === 'line' && !expectedHash) {
      return conflict(file, '行号模式必须提供 expected_hash(行号会随文件变化漂移,需要内容版本锚点)。');
    }

    // 以 Buffer 读取并按 Buffer 算 hash,与 ChangeSet 内部口径一致(非法 UTF-8 时字符串 hash 会对不上)。
    const buffer = await readFile(jailResolve(file));
    if (isProbablyBinary(buffer.subarray(0, SNIFF_BYTES))) {
      return conflict(file, '是二进制文件,不能按文本编辑(utf8 往返会损毁原有字节)。');
    }
    // 未提供 hash:用刚读到的内容算。读与提交之间的窗口由 ChangeSet 的 dry-run + 提交前复核兜底,
    // 期间文件被改会报 CHANGE_CONFLICT(fail-loud),不会静默覆盖。
    if (!expectedHash) expectedHash = contentHash(buffer);

    const data = buffer.toString('utf8');
    const normalized = toLf(data);

    let updated: string;

    if (mode === 'single') {
      // String replacement mode
      const newNormalized = toLf(String(args.new_string));
      const oldNormalized = toLf(String(args.old_string));
      const count = normalized.split(oldNormalized).length - 1;

      if (count === 0) {
        return conflict(file, 'old_string 未找到；请重新 read_file 并复制最新内容。');
      }
      if (count > 1) {
        return conflict(file, `old_string 出现 ${count} 次；请增加上下文使其唯一。`);
      }
      updated = normalized.replace(oldNormalized, () => newNormalized);
    } else if (mode === 'multi') {
      // Multiple replacements mode:所有 old_string 先在「原始文件」上一次性定位,
      // 各自必须唯一命中、区间互不重叠;任何一项不满足整体拒绝、一条都不改(原子)。
      const located: Array<{ start: number; end: number; next: string }> = [];
      for (let i = 0; i < multiEdits.length; i++) {
        const edit = multiEdits[i];
        const hits: number[] = [];
        let from = 0;
        let hit: number;
        // 空串已在上面拒绝;indexOf 步进至少 1 不会死循环。
        while ((hit = normalized.indexOf(edit.old, from)) !== -1) {
          hits.push(hit);
          from = hit + edit.old.length;
        }
        if (hits.length === 0) {
          return conflict(file, `replacements[${i}].old_string 未找到;请重新 read_file 并复制最新内容。`);
        }
        if (hits.length > 1) {
          return conflict(file, `replacements[${i}].old_string 出现 ${hits.length} 次;请增加上下文使其唯一。`);
        }
        located.push({ start: hits[0], end: hits[0] + edit.old.length, next: edit.next });
      }
      located.sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 1; i < located.length; i++) {
        if (located[i].start < located[i - 1].end) {
          return conflict(file, 'replacements[] 的命中区间互相重叠;请拆分或合并这些编辑后重试(本次未写入)。');
        }
      }
      // 定位全部通过后才应用:从后向前按区间替换,偏移不会因前序改动而失效。
      updated = normalized;
      for (let i = located.length - 1; i >= 0; i--) {
        updated = updated.slice(0, located[i].start) + located[i].next + updated.slice(located[i].end);
      }
    } else {
      // Line-range mode
      const newNormalized = toLf(String(args.new_string));
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
