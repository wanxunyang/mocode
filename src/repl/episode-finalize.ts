// episode-finalize.ts —— 把「当前会话」落成一条情节记忆(R6.1)的 REPL 侧胶水。
//
// 为什么放在 repl/ 而不是 memory/episodic.ts:
// 内容来源横跨两个子系统——请求与改动文件来自 `history`(repl/agent 的资产),
// 未完成项来自 `notes.md`(session/notes)。真把它们塞进 memory/episodic.ts 会让
// memory 反向依赖 session,而 session/retention.ts 已经 import 了 memory/index
// (memory → session 与 session → memory 同时成立就是环)。
// 所以 episodic.ts 保持叶子(只认参数),本文件负责组装,依赖方向 repl → {memory, session}。
//
// 产出是**确定性、零 LLM**的(理由见 episodic.ts 头注释):退出路径不能等模型。

import { readFileSync } from 'node:fs';
import { isMemoryEnabled } from '../config/index.js';
import { getNotesFilePath } from '../session/notes.js';
import {
  collectChangedFiles,
  extractCompactionSummary,
  parsePendingSteps,
  recordSessionEpisode,
  type RecordEpisodeResult,
} from '../memory/episodic.js';
import type { ChatMessage } from '../llm/index.js';

/** 读 notes.md 正文;无文件/读失败返 null(不是错误——大多数会话没有 notes)。 */
function readNotes(sessionId: string): string | null {
  const p = getNotesFilePath(sessionId);
  if (!p) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 把当前会话落成情节记忆。幂等:同一会话被调用多次(退出 + /clear + /resume 切换)
 * 只会刷新同一条,不会产生多条。
 *
 * 调用时机(全部在**会话状态还完整**时):
 *  ① REPL 主循环退出前;
 *  ② `/clear` 丢弃 history 之前;
 *  ③ `/resume`/`/sessions` 换掉 history 之前。
 *
 * 关于 Ctrl+C:TUI 下终端常驻 raw 模式(`editor.ts` 的 setRawMode(true)),此时 Ctrl+C 只是
 * 一个按键、**不产生 SIGINT**——输入框为空时 `onCtrlC()` reject 后由主循环 `catch { break }`
 * 接住,因此照样走 ①,情节正常落盘。真正跳过本函数的只有非 raw 模式(非 TTY / setRawMode
 * 失败退化 readline)下的进程级 SIGINT → `process.exit(130)`,那条路径不承诺副作用完成,
 * 与 drainMemoryBackground 的既有取舍一致。
 */
export function finalizeCurrentEpisode(
  sessionId: string | undefined,
  history: readonly ChatMessage[],
  queries: readonly string[],
): RecordEpisodeResult {
  if (!sessionId) return { ok: false, reason: 'no-session' };
  if (!isMemoryEnabled()) return { ok: false, reason: 'disabled' };
  const notes = readNotes(sessionId);
  return recordSessionEpisode({
    sessionId,
    queries,
    changedFiles: collectChangedFiles(history),
    summaryText: extractCompactionSummary(history),
    pendingSteps: parsePendingSteps(notes),
  });
}
