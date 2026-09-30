/**
 * 工作区命令组:/diff
 *
 * `/diff` = 最近一轮 agent turn 的快照(before) vs 工作区当前内容(after),
 * 逐文件渲染 unified diff 到内容区;`/diff <N>` 选第 N 轮(1-based,与 /rollback
 * 轮次口径一致);`/diff all` = 全部轮次的累计改动(最早的 before vs 现在)。
 *
 * 数据源:rollback 快照(每轮文件修改前捕获,不依赖 git)——好处是「没有 git 的目录」
 * 也能看 agent 改了什么,且口径与 /rollback 完全一致(所见即可撤)。
 * 限制:run_command 等不透明工具的工作区扫描快照在文件超 CAPTURE_FILE_LIMIT 时只留
 * 指纹(contentUnavailable),这些文件显示「快照不可用」而非 diff。
 *
 * diff 算法:前后缀等行消除 + 单 hunk 输出,不引依赖(与 agent/index.ts lineDelta
 * 同思路)。文件较少、行数中等的会话内 diff 足够快。
 */
import { readFileSync } from 'node:fs';
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { getActiveRollbackStore, type Snapshot } from '../../rollback/index.js';
import { unhandled, next, type CommandHandler } from './types.js';

const MAX_DIFF_LINES = 400; // 单文件输出上限:防止把万行生成文件刷满内容区
const MAX_FILES = 60; // 单次命令最多渲染文件数(超出提示收窄)
const CONTEXT = 3; // hunk 上下文行数

/** 快照 before 内容 → 文本(null → 无内容/不可用;base64 解码失败按 null)。 */
function snapshotText(snapshot: Snapshot): string | null {
  if (snapshot.before === null) return null;
  if (snapshot.encoding === 'base64') {
    try {
      return Buffer.from(snapshot.before, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return snapshot.before; // v1 快照:UTF-8 原文
}

/** 是否可当文本 diff:kind=file 且非 contentUnavailable(目录/软链/超预算跳过)。 */
function diffable(snapshot: Snapshot): boolean {
  return snapshot.kind === 'file' && snapshot.contentUnavailable !== true;
}

/** 按行求公共前缀/后缀长度(与 lineDelta 同思路,但这里要保留行号做 hunk)。 */
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
 * 行级 unified diff 单文件段(纯文本,颜色渲染层加)。
 * 策略:前后缀等行消除后,中间区整段输出为「先删后加」的单 hunk。对单文件一次
 * 编辑(agent 编辑的绝大多数形态:改一处/几处)等价于标准 diff;全文重写时输出
 * 体积与正确 diff 同量级,只是 hunk 划分更粗。无变化返回 ''(指纹差异但文本相同)。
 */
export function unifiedFileDiff(pathRel: string, beforeText: string | null, afterText: string | null): string {
  const before = beforeText === null ? [] : beforeText.split('\n');
  const after = afterText === null ? [] : afterText.split('\n');
  const { head, tail } = hunkBoundaries(before, after);
  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  if (midBefore.length === 0 && midAfter.length === 0) return '';

  const contextStart = Math.max(0, head - CONTEXT);
  const tailStartBefore = before.length - tail;
  const tailStartAfter = after.length - tail;
  const contextEndBefore = Math.min(before.length, tailStartBefore + CONTEXT);
  const contextEndAfter = Math.min(after.length, tailStartAfter + CONTEXT);

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

/** 渲染一条 diff 行:加绿/删红/hunk 头青/上下文 dim。 */
function writeDiffLine(line: string): void {
  if (line.startsWith('+')) layout.contentWrite(`${ui.green}${line}${ui.reset}\n`);
  else if (line.startsWith('-')) layout.contentWrite(`${ui.red}${line}${ui.reset}\n`);
  else if (line.startsWith('@@')) layout.contentWrite(`${ui.cyan}${line}${ui.reset}\n`);
  else layout.contentWrite(`${ui.dim}${line}${ui.reset}\n`);
}

/** 读当前文件(不存在→null=「删除」;读失败→null)。 */
function readCurrent(full: string): string | null {
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

export const diffCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/diff' && !ctx.line.startsWith('/diff ')) return unhandled();
    const arg = ctx.line === '/diff' ? '' : ctx.line.slice('/diff '.length).trim();
    const store = getActiveRollbackStore();
    const turns = store.listTurns();
    if (turns.length === 0) {
      layout.contentWrite(`${ui.dim}(本会话尚无文件改动记录——rollback 快照为空)${ui.reset}\n`);
      return next();
    }

    // 轮次选择:/diff = 最近一轮;/diff N = 第 N 轮(1-based,与 /rollback 同口径);/diff all = 全部累计。
    let label: string;
    let minTurnIdExclusive: number; // 只统计 turnId > 此值的快照
    if (arg === '') {
      const last = turns[turns.length - 1]!;
      minTurnIdExclusive = last.turnId - 1;
      label = `第 ${turns.length} 轮(最近)`;
    } else if (arg === 'all') {
      minTurnIdExclusive = 0;
      label = '全部轮次累计';
    } else {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > turns.length) {
        layout.contentWrite(
          `${ui.yellow}(轮次无效:本会话共 ${turns.length} 轮,可用 /diff 1..${turns.length} 或 /diff all)${ui.reset}\n`,
        );
        return next();
      }
      minTurnIdExclusive = (turns[n - 1]!.turnId ?? 0) - 1;
      label = `第 ${n} 轮`;
    }

    // 每 path 取最早快照的 before(= 该范围开始前的状态)。addSnapshot 已保证同
    // turnId+path 只留最早 sequence 的 before,跨 turnId 再取 turnId 最小者。
    interface Entry {
      snapshot: Snapshot;
      unavailable: boolean;
    }
    const byPath = new Map<string, Entry>();
    for (const snapshot of store.snapshotsSince(minTurnIdExclusive)) {
      const existing = byPath.get(snapshot.path);
      if (!existing || snapshot.turnId < existing.snapshot.turnId) {
        byPath.set(snapshot.path, {
          snapshot,
          unavailable: (existing?.unavailable ?? false) || !diffable(snapshot),
        });
      } else if (!diffable(snapshot)) {
        existing.unavailable = true;
      }
    }

    if (byPath.size === 0) {
      layout.contentWrite(`${ui.dim}(${label}:无文件改动记录)${ui.reset}\n`);
      return next();
    }

    const root = process.cwd();
    const files = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b));
    const shown = files.slice(0, MAX_FILES);
    layout.contentWrite(
      `${ui.bold}${ui.accent}● ${label} 文件改动${ui.reset}  ${ui.dim}${shown.length}/${files.length} 文件${ui.reset}\n`,
    );

    for (const [rel, entry] of shown) {
      if (entry.unavailable) {
        layout.contentWrite(`${ui.yellow}  ⚠ ${rel}(快照不可用:超出捕获预算或非文本,无法展示 diff)${ui.reset}\n`);
        continue;
      }
      const beforeText = snapshotText(entry.snapshot);
      const afterText = readCurrent(`${root}${rel.startsWith('/') || rel.startsWith('\\') ? '' : '/'}${rel}`);
      const diffText = unifiedFileDiff(rel, beforeText, afterText);
      if (!diffText) {
        // 快照记录了变更但当前内容已与 before 相同(后续轮改回/用户手改回):
        // 仍列文件名,让用户知道它被动过,只是无净变化。
        layout.contentWrite(`${ui.dim}  = ${rel}(已与轮前状态一致,无净变化)${ui.reset}\n`);
        continue;
      }
      layout.contentWrite(`\n${ui.bold}${rel}${ui.reset}\n`);
      const lines = diffText.split('\n');
      const truncated = lines.length > MAX_DIFF_LINES;
      for (const line of lines.slice(0, MAX_DIFF_LINES)) writeDiffLine(line);
      if (truncated) {
        layout.contentWrite(
          `${ui.dim}  …(diff 超过 ${MAX_DIFF_LINES} 行已截断,如需完整内容请直接 read_file)${ui.reset}\n`,
        );
      }
    }
    if (files.length > MAX_FILES) {
      layout.contentWrite(
        `${ui.dim}  …(${files.length - MAX_FILES} 个文件未展示;改动面过大,建议 /diff <N> 收窄到单轮)${ui.reset}\n`,
      );
    }
    layout.contentWrite('\n');
    return next();
  },
];
