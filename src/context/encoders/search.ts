import type { ContextEncoder } from '../types.js';

/**
 * Search Encoder(grep):`file:line: content` 流 → 按文件分组,顶部计数。
 *
 * 输入:grep 返回的 `file:line: content` 行,可能带尾部 `...(结果达到 N 条上限)` 或 `无匹配(...)`。
 * 输出:每个文件一个 `file:` 头 + 其下 2 空格缩进的 `  line: content`,顶部 `# N matches · M files`。
 *
 * 不变量(离线脚本断言):file:line 对集合保真——每个原行 `file:line: content` 可从
 *  `file:` + `  line: content` 还原(content 含前导空格,还原逐字节一致)。
 * 非 grep 格式(web_search 的 `[i] title/...` 已格式化块)→ 无 file:line 匹配 → passthrough(不动)。
 * 正则用非贪婪 `.*?` 匹配文件名,容忍 Windows 盘符冒号(`C:\...`)与 content 含 `:digit:`。
 */
interface GrepMatch {
  file: string;
  line: string;
  content: string;
}
const GREP_RE = /^(.*?):(\d+):(.*)$/;

export const searchEncoder: ContextEncoder = {
  kind: 'search',
  encode({ output }) {
    const lines = output.split('\n');
    const matches: GrepMatch[] = [];
    const tail: string[] = [];
    let inTail = false;
    for (const l of lines) {
      if (!l) continue;
      if (inTail) {
        tail.push(l);
        continue;
      }
      const m = GREP_RE.exec(l);
      if (m) {
        matches.push({ file: m[1], line: m[2], content: m[3] });
      } else {
        // 首个非 grep 行起视作 tail(grep 上限标记 / 无匹配串 / web_search 非 grep 结构)
        inTail = true;
        tail.push(l);
      }
    }
    if (matches.length === 0) {
      // 非 grep 格式(web_search 等)→ 不动其已格式化结构
      return {
        text: output,
        meta: {
          kind: 'search',
          originalLen: output.length,
          encodedLen: output.length,
          note: 'no file:line matches → passthrough',
        },
      };
    }
    const groups = new Map<string, { line: string; content: string }[]>();
    const order: string[] = [];
    for (const m of matches) {
      if (!groups.has(m.file)) {
        groups.set(m.file, []);
        order.push(m.file);
      }
      groups.get(m.file)!.push({ line: m.line, content: m.content });
    }
    const out: string[] = [
      `# ${matches.length} matches · ${order.length} files · search-encoded`,
    ];
    for (const file of order) {
      out.push(`${file}:`);
      for (const { line, content } of groups.get(file)!) {
        out.push(`  ${line}:${content}`);
      }
    }
    if (tail.length) out.push(...tail);
    const text = out.join('\n');
    return {
      text,
      meta: {
        kind: 'search',
        originalLen: output.length,
        encodedLen: text.length,
        note: `${matches.length} matches / ${order.length} files`,
      },
    };
  },
};
