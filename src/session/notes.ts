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

// ── Session notes(单会话永久记忆):note_append 写入,reinject 常驻 system ──────
// 设计:notes.md 不止放 Plan。note_append 往预设笔记段追加一条 finding/decision/
// open_question/risk;extractActiveNotesSections 读出活跃笔记段正文(排除 Plan/Done),
// 按 5k token 预算裁剪后由 reinjectSessionStateIntoSystem 注入 system prompt——compact
// 后仍能恢复,让 agent 始终记得本会话做过什么、发现过什么(单会话永久记忆)。

/** note_append 接受的预设段 key → 渲染标题。 */
const NOTE_SECTION_TITLES: Record<string, string> = {
  findings: 'Findings',
  decisions: 'Decisions',
  open_questions: 'Open Questions',
  risks: 'Risks',
  // compaction_snapshot 是压缩成功后自动写入的机器快照(非 note_append 手填):
  // 让摘要的 Objective/In Progress/Next Steps 在压缩后仍作为活跃笔记段注入。
  compaction_snapshot: 'Compaction Snapshot',
};
/** 预设段 key 列表(供工具 schema enum 与校验用)。 */
export const NOTE_SECTION_KEYS = Object.keys(NOTE_SECTION_TITLES);
/** 段注入优先级:数值越大越先占预算、越后丢弃正文。Risks 最重要。 */
const SECTION_PRIORITY: Record<string, number> = {
  // compaction_snapshot 提到最高:它是压缩当次的权威进度快照,比手填 findings 更能
  // 直接告诉模型「做到哪了」,压缩后第一步最该看到的就是它。
  compaction_snapshot: 5,
  risks: 4, findings: 3, decisions: 2, open_questions: 1,
};

/** 常驻笔记正文总预算(token)。5k:占百万级 context 的 0.5%,可常驻相当量笔记。 */
const NOTES_INJECT_BUDGET_TOKENS = 5000;
/** 单段正文上限(token):防单段独占预算。 */
const NOTES_PER_SECTION_TOKENS = 2000;
/** 单条笔记上限(token):防一条过长吃掉整段预算。 */
const NOTES_PER_ENTRY_TOKENS = 800;

/**
 * 轻量 token 估算(启发式,不依赖 tokenizer):CJK ≈ 0.6 token/字,
 * ASCII ≈ 0.25 token/字。对 GLM/DeepSeek/Qwen 等中文偏多的后端略偏保守
 * (估算略高于实际 → 注入实际 token 略低于预算 → 安全侧)。仅供笔记 cap 用,
 * 不替换 llm/estimatePromptTokens 的主口径。
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other * 0.25);
}

/** 把标题映射回预设 key(非预设段返 '',优先级 0,最后注入)。 */
function matchSectionKey(title: string): string {
  const t = title.trim().toLowerCase();
  for (const [k, v] of Object.entries(NOTE_SECTION_TITLES)) {
    if (v.toLowerCase() === t) return k;
  }
  return '';
}

/**
 * 往 notes.md 的指定笔记段追加一条。段存在则在其末尾追加(保留其它段不动);
 * 段不存在则在文件末新建。返回 { path } 或 { error }。
 */
export function appendNoteToSection(
  section: string,
  entry: string,
  tag?: string,
  sessionId = getCurrentSessionId(),
): { path: string } | { error: string } {
  const title = NOTE_SECTION_TITLES[section];
  if (!title) return { error: `unknown note section "${section}"` };
  const p = getNotesFilePath(sessionId);
  if (!p) return { error: 'no active session' };
  const line = tag ? `- **[${tag}]** ${entry}` : `- ${entry}`;
  let existing = '';
  try {
    existing = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
  } catch {
    existing = '';
  }
  const header = `## ${title}`;
  const lines = existing.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  let next: string;
  if (start >= 0) {
    // 段末 = 下一个 ## 或文件末
    let end = lines.length;
    for (let k = start + 1; k < lines.length; k++) {
      if (/^##\s/.test(lines[k])) { end = k; break; }
    }
    const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
    const sectionLines = lines.slice(start, end);
    // 去段尾空行后追加新条目
    while (sectionLines.length && sectionLines[sectionLines.length - 1].trim() === '') sectionLines.pop();
    sectionLines.push(line);
    const section = sectionLines.join('\n');
    const after = lines.slice(end).join('\n').replace(/^\s+/, '');
    next = [before, section, after].filter((s) => s.length > 0).join('\n\n') + '\n';
  } else {
    // 新建段:放文件末,与已有内容以空行分隔
    const rest = existing.trim();
    const newSection = `${header}\n${line}`;
    next = rest ? `${rest}\n\n${newSection}\n` : `${newSection}\n`;
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next, 'utf8');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { path: p };
}

/** 按字符二分截断条目到 token 上限,加省略标记。条目不长,线性二分足够。 */
function truncateEntry(entry: string, maxTokens: number): string {
  if (estimateTokens(entry) <= maxTokens) return entry;
  let lo = 0;
  let hi = entry.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(entry.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return entry.slice(0, lo).replace(/\s+$/, '') + ' …[truncated]';
}

/** 把单段正文按条目分割,从末尾(最近)保留,丢最旧,裁到 token 预算内。 */
function trimSectionToBudget(body: string, budgetTokens: number): string | null {
  if (budgetTokens <= 0) return null;
  const bodyLines = body.split('\n');
  const header = bodyLines[0] ?? '';
  const rest = bodyLines.slice(1);
  // 分条目:以 "- " 开头为一条起始,后续非 "- " 行归入该条
  const entries: string[] = [];
  let cur: string[] = [];
  for (const ln of rest) {
    if (/^-\s+/.test(ln)) {
      if (cur.length) entries.push(cur.join('\n'));
      cur = [ln];
    } else {
      cur.push(ln);
    }
  }
  if (cur.length) entries.push(cur.join('\n'));
  const kept: string[] = [];
  let used = estimateTokens(header);
  for (let k = entries.length - 1; k >= 0; k--) {
    let e = entries[k];
    if (estimateTokens(e) > NOTES_PER_ENTRY_TOKENS) {
      e = truncateEntry(e, NOTES_PER_ENTRY_TOKENS);
    }
    const t = estimateTokens(e);
    if (used + t > budgetTokens) break;
    kept.unshift(e);
    used += t;
  }
  if (kept.length === 0) return null;
  return `${header}\n${kept.join('\n')}`;
}

/**
 * 读 notes.md,提取所有活跃笔记段正文(排除 `## Plan:` 与 `## Done:`),
 * 按 NOTES_INJECT_BUDGET_TOKENS 裁剪后返回——供 reinject 注入 system prompt。
 * 裁剪策略:段按优先级排序(Risks>Findings>Decisions>Open Questions>自定义),
 * 逐段注入累计 token;单段超 per-section 则段内从最近条目保留丢最旧;
 * 总预算用尽则后续段不注入正文(其标题仍由 buildNotepadSection 索引常驻,
 * agent 可 read_file 取细节)。这样 5k 预算内"写了就常驻",超出降级为索引+按需 read。
 */
export function extractActiveNotesSections(
  budget = NOTES_INJECT_BUDGET_TOKENS,
  sessionId = getCurrentSessionId(),
): string {
  const p = getNotesFilePath(sessionId);
  if (!p) return '';
  let content = '';
  try {
    content = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
  } catch {
    return '';
  }
  const lines = content.split('\n');
  const sections: { key: string; body: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) { i++; continue; }
    const title = m[1];
    // 跳过 Plan/Done 段(Plan 有专属 ACTIVE_PLAN_MARKER 重注入;Done 是归档不常驻)
    if (/^Plan:/.test(title) || /^Done:/.test(title)) {
      i++;
      while (i < lines.length && !/^##\s/.test(lines[i])) i++;
      continue;
    }
    const start = i;
    i++;
    while (i < lines.length && !/^##\s/.test(lines[i])) i++;
    const body = lines.slice(start, i).join('\n').trim();
    if (body) sections.push({ key: matchSectionKey(title), body });
  }
  // 按优先级降序(优先级高的先占预算)
  sections.sort((a, b) => (SECTION_PRIORITY[b.key] ?? 0) - (SECTION_PRIORITY[a.key] ?? 0));
  let used = 0;
  const out: string[] = [];
  for (const s of sections) {
    const remaining = budget - used;
    if (remaining <= 0) break;
    const bodyTokens = estimateTokens(s.body);
    if (bodyTokens <= Math.min(remaining, NOTES_PER_SECTION_TOKENS)) {
      out.push(s.body);
      used += bodyTokens;
      continue;
    }
    // 段超预算:段内裁条目(从最近保留)
    const cap = Math.min(remaining, NOTES_PER_SECTION_TOKENS);
    const trimmed = trimSectionToBudget(s.body, cap);
    if (trimmed) {
      out.push(trimmed);
      used += estimateTokens(trimmed);
    }
    // 预算用尽则后续段不再注入正文(降级为索引)
    if (used >= budget) break;
  }
  return out.join('\n\n');
}

// ── Compaction Snapshot(压缩时自动固结的进度快照)──────────────────────────
// 由 compactHistory 在摘要成功后写入;替代「模型需自觉 plan_update」的软约定——
// 压缩那一刻 notes.md 里一定有当前进度的权威副本,压缩后恢复提示据此续工。
// 与 plan/notes 不同:这是机器产出、整段替换(不逐条累积),因此不会跨压缩膨胀。

/** 快照段标题。extractActiveNotesSections 经 matchSectionKey 识别并注入。 */
export const COMPACTION_SNAPSHOT_TITLE = NOTE_SECTION_TITLES.compaction_snapshot;

/**
 * 把压缩摘要的关键段固结到 notes.md 的 `## Compaction Snapshot` 段。
 * 整段替换旧快照(不累积);仅在当前无活跃 plan 时写入(已有 plan 时权威计划仍在,
 * 快照只会重复)。body 为空时不动。永不抛错:压缩主流程不能因快照失败而失败。
 */
export function writeCompactionSnapshot(
  body: string,
  sessionId = getCurrentSessionId(),
): void {
  try {
    const trimmed = (body ?? '').trim();
    if (!trimmed) return;
    if (readActivePlanTitle(sessionId)) return; // 已有权威计划,快照是冗余
    const p = getNotesFilePath(sessionId);
    if (!p) return;
    let existing = '';
    try {
      existing = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
    } catch {
      existing = '';
    }
    const header = `## ${COMPACTION_SNAPSHOT_TITLE}`;
    const newSection = `${header}\n${trimmed}`;
    const lines = existing.split('\n');
    const start = lines.findIndex((l) => l.trim() === header);
    let next: string;
    if (start >= 0) {
      // 段末 = 下一个 ## 或文件末;整段替换
      let end = lines.length;
      for (let k = start + 1; k < lines.length; k++) {
        if (/^##\s/.test(lines[k])) { end = k; break; }
      }
      const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
      const after = lines.slice(end).join('\n').replace(/^\s+/, '');
      next = [before, newSection, after].filter((s) => s.length > 0).join('\n\n') + '\n';
    } else {
      const rest = existing.trim();
      next = rest ? `${rest}\n\n${newSection}\n` : `${newSection}\n`;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next, 'utf8');
  } catch {
    // 快照是 best-effort 增强,绝不影响压缩主流程。
  }
}
