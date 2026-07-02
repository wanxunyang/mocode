import type { ContextEncoder } from '../types.js';

/**
 * Memory Encoder(memory_search):去掉 `recalled N` 召回计数噪音(遗忘系统内部用,非 LLM 推理所需)。
 *
 * 输入:memory_search 返回的条目卡,每张:`# [id] name (type, recalled N)\nsummary: ...\n\nbody`,
 *  多张以 `\n\n---\n\n` 分隔。
 * 输出:头部 `# [id] name (type)`(丢 `, recalled N`);summary/body 原样。
 *
 * 不变量(离线脚本断言):id/name/type/summary/body 全保留;仅 `recalled N` 被省略。
 *  正则锚定整行 `# [id] ... (type, recalled N)`,group1 贪婪捕获到 `(\w+` 为止,name 含 ` (` 也不影响。
 *  不匹配的行原样返回(防误伤 body 正文里的 `#` 标题等)。
 */
const HEADER_RE = /^(# \[[^\]]+\] .+ \(\w+), recalled \d+\)$/;

export const memoryEncoder: ContextEncoder = {
  kind: 'memory',
  encode({ output }) {
    if (output.startsWith('(无匹配记忆')) {
      return {
        text: output,
        meta: {
          kind: 'memory',
          originalLen: output.length,
          encodedLen: output.length,
          note: 'no matches → passthrough',
        },
      };
    }
    const lines = output.split('\n');
    const out: string[] = [];
    let changed = 0;
    for (const l of lines) {
      const m = HEADER_RE.exec(l);
      if (m) {
        // m[1] = "# [id] name (type";补 ")" 收尾,丢 ", recalled N"
        out.push(`${m[1]})`);
        changed++;
      } else {
        out.push(l);
      }
    }
    if (changed === 0) {
      return {
        text: output,
        meta: {
          kind: 'memory',
          originalLen: output.length,
          encodedLen: output.length,
          note: 'no recalled headers → passthrough',
        },
      };
    }
    const text = out.join('\n');
    return {
      text,
      meta: {
        kind: 'memory',
        originalLen: output.length,
        encodedLen: text.length,
        note: `dropped recalled count from ${changed} entries`,
      },
    };
  },
};
