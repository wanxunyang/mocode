import type { ContextEncoder } from '../types.js';

/**
 * Code Encoder(read_file):折叠连续空行(≥3 → 1,保留首空行行号前缀)。
 *
 * 输入:read_file 返回的 `     N\t<content>` 行(6 宽右对齐行号 + tab + 内容),可能带尾部
 *  `... (N 行未显示,共 M 行)`。
 * 输出:连续 ≥3 个空行(行号前缀 + 空 content)折叠为 1 个(保留首行前缀,丢后续空行);其余逐字保留。
 *
 * 不变量(离线脚本断言):
 *  - 所有非空 content 行逐字保留(前缀 + 内容不变)→ edit_file 的 old_string 按内容匹配仍可用。
 *  - content 行的行号前缀不变 → LLM 看到的行号与文件一致。
 *  - 仅空行(前缀 + tab + 空 content)被折叠,且仅 ≥3 连续时;≤2 空行原样(常见,不动)。
 *  - 尾部标记 `... (...)` 不匹配行号前缀,原样保留。
 *
 * ⚠️ 残余风险(可接受、可恢复):若 LLM 编辑一个含 ≥3 连续空行的区域,它看到的空行数比文件实际少,
 *   old_string 的空行数可能不匹配 → edit_file 返"未找到" → LLM 重读重试(系统提示已要求编辑前 read_file)。
 *   真实代码极少 ≥3 连续空行(linter 通常强制 ≤2),故实际几乎不触发。出问题可设
 *   MOCODE_CONTEXT_OPTIMIZE=false 全局回退,或调高阈值。
 *
 * 不做长度裁剪(cap 兜底);不动行号前缀;不删 content 行;不改内容(含尾随空白)。
 * 空行判定用前缀感知(前缀 + tab + 空 content),不能用 trim——read_file 空行 `     2\t` trim 后剩 `2`。
 */
const LINE_RE = /^(\s*\d+)\t(.*)$/;

function isBlankCodeLine(l: string): boolean {
  const m = LINE_RE.exec(l);
  return m ? m[2] === '' : false;
}

export const codeEncoder: ContextEncoder = {
  kind: 'code',
  encode({ output }) {
    const lines = output.split('\n');
    const out: string[] = [];
    let i = 0;
    let collapsedRuns = 0;
    while (i < lines.length) {
      if (isBlankCodeLine(lines[i])) {
        let j = i;
        while (j < lines.length && isBlankCodeLine(lines[j])) j++;
        const run = j - i;
        if (run >= 3) {
          out.push(lines[i]); // 保留首空行(含其行号前缀)
          collapsedRuns++;
        } else {
          for (let k = 0; k < run; k++) out.push(lines[i]);
        }
        i = j;
      } else {
        out.push(lines[i]);
        i++;
      }
    }
    if (collapsedRuns === 0) {
      return {
        text: output,
        meta: {
          kind: 'code',
          originalLen: output.length,
          encodedLen: output.length,
          note: 'no ≥3 blank runs → passthrough',
        },
      };
    }
    const text = out.join('\n');
    return {
      text,
      meta: {
        kind: 'code',
        originalLen: output.length,
        encodedLen: text.length,
        note: `collapsed ${collapsedRuns} blank runs (≥3 → 1)`,
      },
    };
  },
};
