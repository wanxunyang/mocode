import fs from 'node:fs';
import path from 'node:path';
import { ui } from '../ui/theme.js';
import * as layout from '../ui/layout.js';
import { t } from '../i18n/index.js';
import { config } from '../config/index.js';
import { contextState } from '../session/index.js';
import { DEFAULT_BUDGET_POLICY } from '../context/budget.js';
import { estimateMessagesTokens, estimatePromptTokens, estimateTokens, chatTools } from '../llm/index.js';
import { computePruneStats } from '../context/relevance.js';
import { formatArtifactTokenSources } from '../context/artifacts.js';
import { getAgentMode } from '../agent/mode.js';
import { getCurrentSessionId } from '../session/state.js';
import { getSandboxRoot } from '../sandbox/root.js';
import { planStepLabel } from '../session/notes.js';
import type { ChatMessage, ChatUsage } from '../llm/index.js';

/** /context 的用量条(详情版,进内容区):只算对话内容(不含 system prompt),方便用户感知自己发了多少、agent 回复了多少。 */
export function renderContextBar(history: ChatMessage[]): string {
  // 过滤掉 system 消息,只算对话内容
  const dialog = history.filter((m) => m.role !== 'system');
  const est = estimateMessagesTokens(dialog);
  const win = config.contextWindowTokens;
  const pct = Math.min(1, est / win);
  const W = 10;
  const filled = Math.round(pct * W);
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
  const src = contextState.lastUsage ? t('status.measured') : t('status.estimated');
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio ? ui.yellow : ui.accent;
  const lifecycle = contextState.lifecycleStats;
  const archived = computePruneStats(history);
  const artifactStats = contextState.artifactStats;
  const artifactLine = artifactStats
    ? `\n  artifacts · fresh ${artifactStats.fresh} · stale ${artifactStats.stale} · stubbed ${archived.stubbed} · tokens ${formatArtifactTokenSources(artifactStats)}`
    : '\n  artifacts · no file-backed facts recorded';
  const lifecycleLine = lifecycle
    ? `\n  lifecycle · live ${lifecycle.live} · referenced ${lifecycle.referenced} · digested ${lifecycle.digested} · stubbed ${lifecycle.stubbed}`
    : '\n  lifecycle · no active snapshot (run a tool-enabled turn first)';
  const archiveLine = `\n  archived tool results · ${archived.stubbed}`;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${Math.round(pct * 100)}%  ${k(est)}/${k(win)} tokens · ${t('status.messages', { count: history.length })} (${src})${ui.reset}${artifactLine}${lifecycleLine}${archiveLine}`;
}

/** 状态行用量条(精简版,进底栏):[bar] pct% k/k。
 * 必须**用全 prompt 估算**(消息 + 工具 schema + 尾部 ephemeral 注入),与压缩触发器
 * evaluateBudget 的 system+history+toolOld+toolRecent 总账对齐——任何一段漏算都会让
 * bar 与触发器口径不一致、看着没到 80% 实际已经在压。
 * 触发器用 `Math.max(rawTotal, total) >= 0.8 * window`,bar 也照搬:校正后和校正前
 * 哪个大取哪个,确保不会因 correction<1 而低估。ephemeral 文本由 agent/core 每步写入
 * contextState.ephemeralText(避免在 bar 里再读一次 notes.md)。
 *
 * /context 命令仍是 dialog-only(见 renderContextBar):它的设计意图是"我说了多少"而非
 * "还剩多少空间",两条职责分开。 */
export function renderContextBarInline(history: ChatMessage[]): string {
  const baseRaw = estimatePromptTokens(history, chatTools, 1);
  const baseAdj = estimatePromptTokens(history, chatTools, contextState.correction);
  const ephemeral = contextState.ephemeralText ? estimateTokens(contextState.ephemeralText) : 0;
  // 与触发器同样的「取大」语义:correction<1 时 raw 更大,bar 不会假装很安全。
  const est = Math.max(baseRaw, baseAdj) + ephemeral;
  const win = config.contextWindowTokens;
  const pct = Math.min(1, est / win);
  const W = 10;
  const filled = Math.round(pct * W);
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio ? ui.yellow : ui.accent;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${pctCol}${Math.round(pct * 100)}%${ui.reset} ${ui.dim}${k(est)}/${k(win)}${ui.reset}`;
}

interface NotesPlanStatus {
  fingerprint: string;
  summary: string;
}

// 宿主侧记录已结束轮次最后看到的 plan。notes.md 仍完整保留，只抑制未变化的旧 plan 状态栏，
// 避免 agent 忘记把 `## Plan:` 改成 `## Done:` 时输入框上方永久悬挂。
let settledPlanFingerprint: string | undefined;

/** 读取 notes.md 中唯一活跃的 `## Plan:` 段。进度只统计该段，避免其他笔记 checkbox 污染计数。 */
export function readPlanStatusFromNotes(): NotesPlanStatus | null {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return null;

  const root = getSandboxRoot() ?? process.cwd();
  const p = path.join(root, '.mocode', 'sessions', sessionId, 'notes.md');
  try {
    const normalized = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const start = lines.findIndex((line) => /^## Plan:\s*.+$/.test(line));
    if (start < 0) return null;
    const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s/.test(line));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    const section = lines.slice(start, end).join('\n').trimEnd();
    const title = lines[start].match(/^## Plan:\s*(.+)$/)?.[1].trim();
    if (!title) return null;

    const total = (section.match(/^\s*-\s*\[[ xX]\]\s*\d+\./gm) || []).length;
    const currentMatch = section.match(/^\s*-\s*\[ \]\s*(\d+)\.\s*(.+)$/m);
    const current = currentMatch ? planStepLabel(currentMatch[2]) : undefined;
    // 括号进度 = 「当前执行到的步骤序号/总数」(执行第 1 步显示 1/3),与 `▸ 当前步` 后缀自洽;
    // 旧语义 done/total 会永远慢一拍(执行第 2 步显示 1/3)。全勾选时显示 total/total(通常已自动结算为 Done,chip 消失)。
    const activeNo = currentMatch ? Number(currentMatch[1]) : total;
    const summary = `plan: ${title} (${activeNo}/${total})`;
    // mtime 让“相同内容被重写为一项新计划”也能重新出现，而不被旧轮次误抑制。
    const fingerprint = `${sessionId}\0${fs.statSync(p).mtimeMs}\0${section}`;
    return { fingerprint, summary: current ? `${summary} ▸ ${current}` : summary };
  } catch {
    return null;
  }
}

/** 将当前 plan 标记为已结算。只影响状态栏，不修改 agent 的工作笔记。 */
export function settlePlanStatus(): void {
  settledPlanFingerprint = readPlanStatusFromNotes()?.fingerprint;
}

/** 从 notes.md 读取活跃 plan 摘要；已结算且未变化的旧 plan 不再显示。 */
export function readPlanFromNotes(): string {
  const plan = readPlanStatusFromNotes();
  if (!plan || plan.fingerprint === settledPlanFingerprint) return '';
  return plan.summary;
}

/** 状态行基线:模型 / context / cwd / 模式标识 / 活跃 plan chip / 本轮 token。repl 在轮次边界、切模式、plan 变更时调。 */
export function refreshStatusBase(history: ChatMessage[], lastTurnUsage?: ChatUsage): void {
  layout.setStatusBase({
    model: config.model,
    contextBar: renderContextBarInline(history),
    cwd: process.cwd(),
    modeTag: getAgentMode() === 'plan' ? 'Plan' : 'Auto',
    planSummary: readPlanFromNotes(),
    lastTurnUsage,
  });
}

/** 命令 → 运行态状态文字 + 底栏 dim 占位。 */
export function runningStateFor(cmd: string): { status: string; placeholder: string } {
  switch (cmd) {
    case '/compact':
      return { status: t('running.compact'), placeholder: t('running.compacting') };
    case '/resume':
      return { status: t('running.resume'), placeholder: t('running.chooseSession') };
    case '/rollback':
      return { status: t('running.rollback'), placeholder: t('running.chooseTurn') };
    case '/init':
      return { status: t('running.init'), placeholder: t('running.generateMemory') };
    case '/plan':
      return { status: t('running.plan'), placeholder: '…' };
    case '/auto':
      return { status: t('running.auto'), placeholder: '…' };
    case '/clear':
      return { status: t('running.clear'), placeholder: '…' };
    case '/theme':
      return { status: t('running.theme'), placeholder: t('running.chooseTheme') };
    case '/model':
      return { status: t('running.model'), placeholder: t('running.configuring') };
    case '/pet':
      return { status: t('running.pet'), placeholder: t('running.processing') };
    case '/memory_switch':
      return { status: t('running.memory'), placeholder: t('running.switching') };
    case '/memory_status':
      return { status: t('running.memoryStatus'), placeholder: '…' };
    case '/subagent':
      return { status: t('running.subagent'), placeholder: t('running.switching') };
    case '/language':
      return { status: t('running.language'), placeholder: t('running.chooseLanguage') };
    case '/upgrade':
      return { status: t('running.upgrade'), placeholder: t('running.upgrading') };
    default:
      return { status: '', placeholder: '' };
  }
}
