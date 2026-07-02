import type { ContextEncoder } from '../types.js';
import { stripAnsi, collapseBlankRuns } from './_util.js';

/**
 * Graph Encoder(codegraph):去 ANSI + 折叠连续空行(≥3 → 1)。
 *
 * 输入:codegraph CLI 返回的 `[退出码 N]\n<源码 + 调用路径>`(可能含 ANSI 颜色、多余空行)。
 * 输出:去 ANSI + 空行折叠;结构(调用路径块、源码段)不动。
 *
 * 不变量:退出码行保留;源码与调用路径文本逐字保留(仅去颜色码 + 折叠空行);不删内容行。
 * 保守:不重构调用路径 / 不去重源码(codegraph CLI 输出格式未稳定,需先采样真实输出定不变量,留后续)。
 */
export const graphEncoder: ContextEncoder = {
  kind: 'graph',
  encode({ output }) {
    const stripped = stripAnsi(output);
    const text = collapseBlankRuns(stripped, 3);
    const hadAnsi = /\x1b/.test(output);
    const hadBlanks = text !== stripped;
    const note =
      [hadAnsi ? 'ANSI stripped' : '', hadBlanks ? 'blank runs collapsed' : '']
        .filter(Boolean)
        .join(', ') || 'no change';
    return {
      text,
      meta: {
        kind: 'graph',
        originalLen: output.length,
        encodedLen: text.length,
        note,
      },
    };
  },
};
