import type { ContextEncoder } from '../types.js';
import { collapseBlankRuns } from './_util.js';

/**
 * Doc Encoder(web_fetch / use_skill):折叠连续空行(≥3 → 1)。
 *
 * 输入:
 *  - web_fetch 的 `URL (HTTP ...)\n\n<body>`(HTML→文本,常留多余空行)。
 *  - use_skill 的 `# Skill: name\n\n<body>`(SKILL.md 正文,frontmatter 已剥离)。
 * 输出:空行折叠;正文 / 指令逐字保留。
 *
 * 不变量:URL 前缀行 / Skill 标题行保留;正文文本逐字保留(仅折叠空行——markdown / HTML 多空行与
 *  单空行语义等价,无损)。use_skill 走放宽 cap(MAX_SKILL_RESULT)保指令完整——本 encoder 在 cap 前先
 *  折叠空行,减少被 cap 截断的风险。
 */
export const docEncoder: ContextEncoder = {
  kind: 'doc',
  encode({ output }) {
    const text = collapseBlankRuns(output, 3);
    return {
      text,
      meta: {
        kind: 'doc',
        originalLen: output.length,
        encodedLen: text.length,
        note: text !== output ? 'blank runs collapsed' : 'no change',
      },
    };
  },
};
