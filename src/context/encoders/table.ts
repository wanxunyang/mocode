import type { ContextEncoder } from '../types.js';

/**
 * Table Encoder(memory_list):去掉默认 `active` 状态标注(冗余信息)。
 *
 * 输入:memory_list 返回的 `- id: name — summary (type, status)` 行(每行一条)。
 * 输出:status 为默认 `active` 时省略 `, active`(→ `(type)`);非默认(archived/superseded)保留。
 *  顶部加 `# N entries · table-encoded` 计数头。
 *
 * 不变量(离线脚本断言):id/name/summary/type 全保留;仅 `active` 状态被省略(默认值,无信息损失)。
 *  正则锚定整行 + 要求 `id: ... — ... (type, active)` 形,不匹配的行原样返回(防误伤 MOCODE.md 等正文)。
 *  group1 贪婪捕获到 `(\w+` 为止,故 name/summary 内含 ` — ` 或 ` (` 也不影响(仅丢尾部 `, active)`)。
 */
const ACTIVE_LINE_RE = /^(- [^:]+: .+ — .+ \(\w+), active\)$/;

export const tableEncoder: ContextEncoder = {
  kind: 'table',
  encode({ output }) {
    if (output === '(无记忆条目)') {
      return {
        text: output,
        meta: {
          kind: 'table',
          originalLen: output.length,
          encodedLen: output.length,
          note: 'empty → passthrough',
        },
      };
    }
    const lines = output.split('\n');
    const out: string[] = [];
    let changed = 0;
    for (const l of lines) {
      const m = ACTIVE_LINE_RE.exec(l);
      if (m) {
        // m[1] = "- id: name — summary (type";补 ")" 收尾,丢 ", active"
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
          kind: 'table',
          originalLen: output.length,
          encodedLen: output.length,
          note: 'no active-status lines → passthrough',
        },
      };
    }
    const count = lines.filter((l) => l.startsWith('- ')).length;
    const text = `# ${count} entries · table-encoded (default "active" status omitted)\n${out.join('\n')}`;
    return {
      text,
      meta: {
        kind: 'table',
        originalLen: output.length,
        encodedLen: text.length,
        note: `omitted active from ${changed}/${count} entries`,
      },
    };
  },
};
