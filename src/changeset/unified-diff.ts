/**
 * 行级 unified diff（纯函数，无 UI / 无 fs 依赖）。
 *
 * 从 src/repl/commands/diff.ts 抽出来的原因：同一份 diff 现在有两个消费方
 * ——终端 `/diff` 命令，和 work-app 的 host（`changes` 命令）。
 * 后者跑在 stdio 子进程里，不能拉进 ui/layout 那一整套终端渲染栈。
 *
 * 算法与抽出来之前完全一致（前缀/后缀等行消除 + 单 hunk 输出，不引依赖）：
 * 对单文件一次编辑（agent 编辑的绝大多数形态）等价于标准 diff；全文重写时输出
 * 体积与正确 diff 同量级，只是 hunk 划分更粗。
 */

/** hunk 上下文行数。 */
export const DIFF_CONTEXT_LINES = 3;

/** 按行求公共前缀/后缀长度（保留行号做 hunk，不能用更省事的整体比较）。 */
function hunkBoundaries(before: string[], after: string[]): { head: number; tail: number } {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return { head, tail };
}

/**
 * 单文件 unified diff 文本（不含颜色）。无净变化返回 ''。
 *
 * @param pathRel 展示用相对路径（写进 --- a/ 与 +++ b/ 头）
 * @param beforeText null = 文件此前不存在（新建）
 * @param afterText  null = 文件已删除
 */
export function unifiedFileDiff(
  pathRel: string,
  beforeText: string | null,
  afterText: string | null,
  contextLines: number = DIFF_CONTEXT_LINES,
): string {
  const before = beforeText === null ? [] : beforeText.split('\n');
  const after = afterText === null ? [] : afterText.split('\n');
  const { head, tail } = hunkBoundaries(before, after);
  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  if (midBefore.length === 0 && midAfter.length === 0) return '';

  const contextStart = Math.max(0, head - contextLines);
  const tailStartBefore = before.length - tail;
  const tailStartAfter = after.length - tail;
  const contextEndBefore = Math.min(before.length, tailStartBefore + contextLines);
  const contextEndAfter = Math.min(after.length, tailStartAfter + contextLines);

  const lines: string[] = [];
  lines.push(`--- a/${pathRel}`);
  lines.push(`+++ b/${pathRel}`);
  lines.push(
    `@@ -${contextStart + 1},${contextEndBefore - contextStart} +${contextStart + 1},${contextEndAfter - contextStart} @@`,
  );
  for (let i = contextStart; i < head; i++) lines.push(` ${before[i]}`);
  for (const line of midBefore) lines.push(`-${line}`);
  for (const line of midAfter) lines.push(`+${line}`);
  for (let i = tailStartBefore; i < contextEndBefore; i++) lines.push(` ${before[i]}`);
  return lines.join('\n');
}
