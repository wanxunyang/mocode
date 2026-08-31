/**
 * 模糊匹配(纯函数,零依赖)。供输入框历史搜索(Ctrl+R / Ctrl+P)排序用。
 *
 * 算法是 fzf 的简化版:从左到右贪心子序列匹配 + 启发式打分。
 * 为什么不上完整动态规划:历史条目量级在几十到几百条,候选文本通常 <200 字符,
 * 贪心与最优解在真实输入上差异极小,而 DP 的 O(n·m) 与回溯实现复杂度高得多。
 *
 * 打分项(靠前的更重要):
 *   - 每个匹配字符            +1
 *   - 与上一个匹配字符相邻    +8   (鼓励连续命中:fzf 里 "abc" 应命中 "abc def" 而非 "a_b_c")
 *   - 落在词首/分隔符后       +6   (鼓励缩写命中:"srt" → "sort" / "src/tools")
 *   - 落在驼峰大写边界        +4   ("cb" → "copyBuffer")
 *   - 大小写精确匹配          +1   (让 "P" 优先命中 "Prompt" 的大写 P)
 *   - 首匹配位置惩罚          -firstIdx * 0.05
 *   - 文本长度惩罚            -len * 0.02  (同等质量下短的优先)
 */

export interface FuzzyMatch {
  /** 越大越优;空 query 恒为 0(顺序由调用方按"最近优先"决定)。 */
  score: number;
  /** 命中字符在 text 中的索引,按**码点**计(与 [...text] 的下标一致,便于 CJK 安全切片)。 */
  positions: number[];
}

/** 词/路径边界:命中紧跟在这些字符之后算"词首",加分。 */
const BOUNDARY = new Set([
  ' ', '\t', '\n', '-', '_', '/', '\\', ':', '.', ',', ';',
  '(', ')', '[', ']', '{', '}', '<', '>', '"', "'", '`', '=', '+', '|', '&', '?', '!', '#', '@', '$', '%', '^', '~', '*',
]);

function isUpper(ch: string | undefined): boolean {
  return !!ch && ch >= 'A' && ch <= 'Z';
}

/**
 * 子序列模糊匹配。不区分大小写;大小写完全对得上时额外加分。
 * 不匹配返回 null。query 为空返回 score=0 的全通过结果(positions 为空数组)。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const qChars = [...query];
  if (qChars.length === 0) return { score: 0, positions: [] };

  const tChars = [...text];
  const tLower = tChars.map((c) => c.toLowerCase());
  const qLower = qChars.map((c) => c.toLowerCase());

  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prevIdx = -2;

  for (let i = 0; i < tChars.length && qi < qLower.length; i++) {
    if (tLower[i] !== qLower[qi]) continue;
    positions.push(i);
    score += 1;
    if (i === prevIdx + 1) score += 8; // 连续命中
    const prev = i > 0 ? tChars[i - 1] : undefined;
    if (i === 0 || (prev !== undefined && BOUNDARY.has(prev))) score += 6;
    else if (isUpper(tChars[i]) && !isUpper(prev)) score += 4;
    if (tChars[i] === qChars[qi]) score += 1; // 大小写精确
    qi++;
    prevIdx = i;
  }

  if (qi < qLower.length) return null; // 有字符没配上 → 不匹配

  score -= positions[0] * 0.05;
  score -= tChars.length * 0.02;
  return { score, positions };
}

/**
 * 对一批文本按匹配质量排序(高分在前);query 为空时保持原顺序不变
 * (调用方通常已按"最近优先"排好,空 query 不应打乱)。
 * 返回 [{ text, score }],已过滤掉不匹配的项。
 */
export function fuzzyRank<T extends string>(
  query: string,
  items: readonly T[],
  limit?: number,
): { text: T; score: number }[] {
  if (!query) {
    const head = typeof limit === 'number' ? items.slice(0, limit) : [...items];
    return head.map((text) => ({ text, score: 0 }));
  }
  const scored: { text: T; score: number }[] = [];
  for (const text of items) {
    const m = fuzzyMatch(query, text);
    if (m) scored.push({ text, score: m.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return typeof limit === 'number' ? scored.slice(0, limit) : scored;
}
