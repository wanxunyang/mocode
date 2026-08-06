// session/notes.ts - Session Notepad(notes.md)的 plan 状态单一事实源。
// 负责:canonical 文件路径、plan 结构化模型、markdown 渲染、以及"只替换活跃 ## Plan: 段、
// 保留其它笔记段"的写入。被 plan_update 工具、agent core(事件驱动重同步/nag)、
// config(notepad 索引 / compact 重注入)共用,避免路径与段解析逻辑散落多处。

import fs from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';
import { getCurrentSessionId } from './state.js';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  /** 自包含步骤描述:目标文件/符号 + 改动 + 验收方式(压缩免疫)。 */
  content: string;
  status: PlanStepStatus;
  /** in_progress 时的进行时标签(可选),用于 markdown 与状态栏展示。 */
  activeForm?: string;
}

export interface PlanState {
  title: string;
  goal?: string;
  steps: PlanStep[];
}

/** 单个活跃 plan 允许的最大步骤数(防无限膨胀,对齐 Claude Code TodoWrite 的 20 上限)。 */
export const PLAN_MAX_STEPS = 20;

/** 当前会话 notes.md 的绝对路径;无会话时返 null。 */
export function getNotesFilePath(sessionId = getCurrentSessionId()): string | null {
  if (!sessionId) return null;
  const root = getSandboxRoot() ?? process.cwd();
  return path.join(root, '.mocode', 'sessions', sessionId, 'notes.md');
}

/** notes.md 的 mtime(ms),不存在或不可读返 null。供 core 判断"本步是否改动了 notes.md"。 */
export function getNotesMtime(sessionId = getCurrentSessionId()): number | null {
  const p = getNotesFilePath(sessionId);
  if (!p) return null;
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 把 plan 渲染为 canonical markdown 段(不含首尾多余空行)。
 * 复选框格式 `- [ ] N.` / `- [x] N.` 与 repl 状态栏 chip 的计数正则严格对齐;
 * in_progress 步骤追加 ` ◀ 当前` 后缀(仍计为未完成),让 compact 重注入后模型能直接续上。
 * 全部完成时标题写为 `## Done:`(自动结算),extractActivePlanSection 随之返回 null。
 */
export function renderPlanSection(plan: PlanState): string {
  const allDone = plan.steps.length > 0 && plan.steps.every((s) => s.status === 'completed');
  const header = allDone ? `## Done: ${plan.title}` : `## Plan: ${plan.title}`;
  const lines: string[] = [header];
  if (plan.goal) lines.push(`Goal: ${plan.goal}`);
  lines.push('', '### Steps');
  plan.steps.forEach((s, i) => {
    const box = s.status === 'completed' ? '[x]' : '[ ]';
    const suffix = s.status === 'in_progress'
      ? `  ◀ ${(s.activeForm ?? '').trim() || 'current'}`
      : '';
    lines.push(`- ${box} ${i + 1}. ${s.content}${suffix}`);
  });
  const done = plan.steps.filter((s) => s.status === 'completed').length;
  lines.push('', '### Progress', `- ${done}/${plan.steps.length} steps complete`);
  return lines.join('\n');
}

/** 读取当前活跃 `## Plan:` 段的标题;无活跃 plan 返 null。 */
export function readActivePlanTitle(sessionId = getCurrentSessionId()): string | null {
  const p = getNotesFilePath(sessionId);
  if (!p) return null;
  try {
    const normalized = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
    const headerLine = normalized.split('\n').find((l) => /^## Plan:\s*.+$/.test(l));
    return headerLine?.match(/^## Plan:\s*(.+)$/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * 把 plan 写入 notes.md:替换已有活跃 `## Plan:` 段(原位),否则插到文件顶部;
 * 其它所有笔记段(findings / Open Questions / 已结算 ## Done:)原样保留。
 * 文件不存在则创建(含父目录)。返回 { path, settled } 或 { error }。
 */
export function writePlanToNotes(
  plan: PlanState,
  sessionId = getCurrentSessionId(),
): { path: string; settled: boolean } | { error: string } {
  const p = getNotesFilePath(sessionId);
  if (!p) return { error: 'no active session' };
  const section = renderPlanSection(plan);
  let existing = '';
  try {
    existing = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
  } catch {
    existing = '';
  }

  let next: string;
  const lines = existing.split('\n');
  const start = lines.findIndex((l) => /^## Plan:\s*.+$/.test(l));
  if (start >= 0) {
    const endOffset = lines.slice(start + 1).findIndex((l) => /^##\s/.test(l));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
    const after = lines.slice(end).join('\n').replace(/^\s+/, '');
    next = [before, section, after].filter((s) => s.length > 0).join('\n\n') + '\n';
  } else {
    const rest = existing.trim();
    next = rest ? `${section}\n\n${rest}\n` : `${section}\n`;
  }

  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next, 'utf8');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { path: p, settled: plan.steps.length > 0 && plan.steps.every((s) => s.status === 'completed') };
}
