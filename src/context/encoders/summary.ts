import type { ContextEncoder } from '../types.js';
import { collapseBlankRuns } from './_util.js';

/**
 * Summary Encoder(task):折叠连续空行(≥3 → 1)。
 *
 * 输入:task 工具返回的子 agent 最终摘要文本(已是摘要,可能含多余空行),可能带截断尾标
 *  `…(子 agent 摘要已截断 N 字符)`。
 * 输出:空行折叠;摘要文本逐字保留。
 *
 * 不变量:摘要事实文本逐字保留(仅折叠空行);截断尾标保留。子 agent 摘要已是高密度文本,只做轻量去冗余,
 * 不再做进一步压缩(避免丢事实)。
 */
export const summaryEncoder: ContextEncoder = {
  kind: 'summary',
  encode({ output }) {
    const text = collapseBlankRuns(output, 3);
    return {
      text,
      meta: {
        kind: 'summary',
        originalLen: output.length,
        encodedLen: text.length,
        note: text !== output ? 'blank runs collapsed' : 'no change',
      },
    };
  },
};
