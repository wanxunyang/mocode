/**
 * 压缩命令组:/compact [focus] · /compact --no-force [focus]
 *
 * 摘要是几十秒的 LLM 调用:包一层 startRunningListener 让 Ctrl+C 能掐断
 * (信号透传 manualCompact → maybeCompact → compactHistory → chat)。
 * 中断时 history 未被改动(重建发生在摘要成功之后),直接提示回输入态。
 *
 * 会话状态(plan + 笔记段)不在此处回写 history[0]:agent/core 每步都在
 * requestHistory 末尾注入最新副本(buildSessionStateReminder),压缩后下一步
 * 自然恢复,且系统提示保持逐字节稳定以命中 prompt 缓存。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { t } from '../../i18n/index.js';
import { manualCompact, appendCurrentSessionRuntimeEvent, hashTraceValue } from '../../session/index.js';
import { startRunningListener, stopRunningListener } from '../running-input.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const compactCommands: CommandHandler[] = [
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/compact' && !line.startsWith('/compact ')) return unhandled();
    // /compact 默认强制压缩(force=true),不受阈值/保护区限制
    const rest = line.slice('/compact'.length).trim();
    let force = true; // 默认强制
    let focus: string | undefined;
    if (rest === '--no-force') force = false;
    else if (rest.startsWith('--no-force ')) {
      force = false;
      focus = rest.slice('--no-force '.length).trim() || undefined;
    } else if (rest) focus = rest;
    // 走调度器路径:与自动每步压缩完全一致——五区按 ROI 压(cold tools 优先 → history 摘要最后)。
    // focus 透传到 compact_history action 的 LLM 摘要 prompt。
    // 返回 SchedulerRunLog 给 UI 显示决策;退化路径(开关关时)在 manualCompact 内部走 compactHistory。
    const log = await (async () => {
      const signal = startRunningListener(t('running.compacting'));
      try {
        return await manualCompact(ctx.history, focus, { force, signal });
      } finally {
        stopRunningListener();
      }
    })().catch((e: unknown) => {
      // 中断:history 未被改动(重建在摘要成功之后),直接提示并回到输入态。
      if (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) {
        layout.contentWrite(`${ui.dim}(已取消压缩)${ui.reset}\n`);
        return null;
      }
      throw e;
    });
    if (!log) return next();
    const d = log.compactDetail;
    appendCurrentSessionRuntimeEvent('compact', {
      source: 'manual',
      force,
      called: log.compactHistoryCalled,
      reason: d?.reason ?? 'unknown',
      estimateBefore: d?.estimateBefore,
      estimateAfter: d?.estimateAfter,
      focusHash: focus ? hashTraceValue(focus) : undefined,
    });
    if (!d) {
      // 兜底(旧调用):只显示 old 文案
      if (!log.compactHistoryCalled) {
        layout.contentWrite(`${ui.dim}(无需压缩:没有可压缩的旧消息)${ui.reset}\n`);
      } else if (focus) {
        layout.contentWrite(`${ui.dim}(带焦点压缩:${focus})${ui.reset}\n`);
      }
      return next();
    }
    // 详细文案:按 reason 分类
    const reason = d.reason;
    const before = d.estimateBefore;
    const after = d.estimateAfter;
    const proto = d.protectedRatio !== undefined ? `保护区占比 ${(d.protectedRatio * 100).toFixed(0)}%` : '';
    const oldCt = d.oldGroupCount !== undefined ? `旧区组数 ${d.oldGroupCount}` : '';
    const focusNote = focus ? `焦点:${focus}` : '';
    const stats = [proto, oldCt].filter(Boolean).join(' · ');

    if (reason === 'microcompact') {
      layout.contentWrite(`${ui.cyan}✓ 微压缩:${ui.reset} ${before} → ${after} tokens${stats ? `  (${ui.dim}${stats}${ui.reset})` : ''}\n`);
    } else if (reason === 'summarize') {
      layout.contentWrite(`${ui.cyan}✓ LLM 摘要:${ui.reset} ${before} → ${after} tokens${focusNote ? `  (${ui.dim}${focusNote}${ui.reset})` : ''}\n`);
    } else if (reason === 'noop-empty') {
      layout.contentWrite(`${ui.dim}(history 太短,只有 system 提示,无可压旧区)${ui.reset}\n`);
    } else if (reason === 'noop-protected') {
      layout.contentWrite(`${ui.dim}(无可压旧区:全部在保护区 system + 当前轮)${ui.reset}${stats ? `  ${ui.dim}(${stats})${ui.reset}` : ''}\n`);
      layout.contentWrite(`${ui.dim}提示:/compact --force 强行把早期对话压成摘要${ui.reset}\n`);
    } else if (reason === 'noop-ml-only') {
      layout.contentWrite(`${ui.dim}(LLM 摘要失败,且无超大单条可微压;可能是后端不可用)${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}回退:只跑了 keep-current 结构,history 未变${ui.reset}\n`);
    } else if (reason === 'noop-shrunk-too-large') {
      layout.contentWrite(`${ui.yellow}● 上下文已超阈但无可压缩项(全在保护区),建议 /clear 或缩短输入。${ui.reset}\n`);
      if (stats) layout.contentWrite(`${ui.dim}(${stats})${ui.reset}\n`);
    } else if (reason === 'noop-noold-noop') {
      layout.contentWrite(`${ui.dim}(无需压缩:没有可压缩的旧消息,且不在手动触发)${ui.reset}\n`);
    } else {
      layout.contentWrite(`${ui.dim}(reason=${reason},${before} → ${after} tokens)${ui.reset}\n`);
    }
    return next();
  },
];
