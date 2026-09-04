import { ui } from '../ui/theme.js';
import * as layout from '../ui/layout.js';
import * as batch from '../ui/batch.js';
import { displayWidth, padEndDisplay, summarizeToolCall, summarizeToolResult } from '../ui/render.js';
import { renderChip } from '../attachments/image.js';
import { PROMPT } from './commands.js';
import type { ChatMessage } from '../llm/index.js';
import type { ImageAttachment } from '../attachments/image.js';

/** side channel:history 中 user 消息的 index → 附件列表,供 renderHistory 复显文件名。runTurn 在 push 前设。 */
export const messageAttachments = new Map<number, ImageAttachment[]>();

export function formatUserMessage(lines: string[], trailingBlank = true): string {
  const cols = layout.getGeo().cols;
  const promptW = displayWidth(PROMPT);
  const indent = ' '.repeat(promptW);
  const { userBg, reset } = ui;
  return (
    lines
      .map((l, i) => {
        const prefix = i === 0 ? PROMPT : indent;
        const full = prefix + l;
        const padded = padEndDisplay(full, cols);
        return `${userBg}${padded}${reset}`;
      })
      .join('\n') + (trailingBlank ? '\n\n' : '\n')
  );
}

/** 把任意消息 content 拍平成字符串(OpenAI 可能 string / null / 多模态数组)。 */
export function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c == null) return '';
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''))).join('');
  }
  return String(c);
}

/** 从旧 session 的消息历史回填输入历史；新 session 使用独立 queryHistory，避免混入合成 user 消息。 */
export function queryHistoryFromMessages(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => textOf((message as { content?: unknown }).content))
    .filter((query) => query.trim().length > 0);
}

/**
 * 把会话历史渲染成静态文本进内容区(回滚 / 续接 / --resume 后复显上下文):
 * user→❯ 回显、assistant→正文(+ tool_calls 折叠成 ● 摘要行)、tool→↳ 结果预览;system 跳过。
 * 思考段不持久(history 只存正文),故无思考折叠。渲染后续写位在末尾,紧接 enterInputMode 画输入框。
 * 内容长于屏时 viewport 显尾(最近轮次),PgUp 可看更早——与流式态一致。
 * user 多模态:用 textOf 取 text parts;若侧 channel messageAttachments 有原文件名则追加 chip 行
 * (避免 base64 解码不可逆,旧 session 没侧 channel 时只显文本,文件名 fallback 到 image/* mime)。
 *
 * 折叠策略:遇到 assistant + tool_calls 不立即打 ● 行,而是累积到 batchEntries;
 * 跟随的连续 tool 消息按 tool_call_id 反查填 resultSummary;遇下一个非 tool 消息(或末尾)时,
 * 用 batch.writeSummaryOnly 出单行摘要(与实时 runAgent 同一渲染器,UI 一致)。
 * 回放默认全折叠;用户可鼠标点击摘要行展开(由 BatchRenderer 接管,见 ui/batch.ts)。
 */
export function renderHistory(history: ChatMessage[]): void {
  const idToEntry = new Map<string, batch.BatchEntry>();
  // 普通工具可跨 assistant 步聚合；mutation 各自占一个 group，并切断前后普通工具。
  let pendingBatches: batch.BatchEntry[][] = [];
  let normalBatch: batch.BatchEntry[] | null = null;
  const flushBatch = (): void => {
    for (const entries of pendingBatches) batch.writeSummaryOnly(entries, layout);
    pendingBatches = [];
    normalBatch = null;
  };
  for (let idx = 0; idx < history.length; idx++) {
    const m = history[idx];
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      flushBatch(); // 上一轮 batch(若有)收尾
      const lines = textOf((m as { content?: unknown }).content).split('\n');
      layout.contentWrite(formatUserMessage(lines));
      const atts = messageAttachments.get(idx);
      if (atts && atts.length > 0) {
        for (const a of atts) {
          layout.contentWrite(`  ${ui.dim}${renderChip(a)}${ui.reset}\n`);
        }
      } else if (Array.isArray((m as { content?: unknown }).content)) {
        // 旧 session 没侧 channel:从 data URL 头抽 mime,显一个通用 chip
        const c = (m as { content?: unknown }).content as unknown[];
        for (const p of c) {
          if (p && typeof p === 'object' && (p as { type?: string }).type === 'image_url') {
            const url = (p as { image_url?: { url?: string } }).image_url?.url ?? '';
            const mime = url.startsWith('data:') ? url.slice(5, url.indexOf(';')) : 'image';
            layout.contentWrite(`  ${ui.dim}📷 ${mime}${ui.reset}\n`);
          }
        }
      }
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf((m as { content?: unknown }).content);
      if (text) {
        flushBatch(); // 文本前若有累积 batch 先收尾(罕见:连续两个 assistant tool_calls 文本间)
        layout.contentWriteMdOnce(text);
      }
      const tcs = (
        m as {
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        }
      ).tool_calls;
      if (Array.isArray(tcs) && tcs.length > 0) {
        if (text) {
          // contentWriteMdOnce 会裁掉 markdown 尾部空行，而 history 中的原始 text 是否以 \n
          // 结尾并不能代表当前物理布局。按缓冲中的视觉行归一化，和实时“正文 → 工具”
          // 边界一致地保留一条空行，避免 /resume 回放时工具摘要紧贴正文。
          layout.normalizeMutationBoundary();
        }
        // 累积到 pendingBatch,顺序 = tool_calls 序
        for (const tc of tcs) {
          const name = tc?.function?.name ?? '';
          const args = tc?.function?.arguments ?? '';
          const entry: batch.BatchEntry = {
            name,
            callSummary: summarizeToolCall(name, args),
            resultSummary: '',
            diffBlock: null,
          };
          if (batch.isMutationToolName(name)) {
            normalBatch = null;
            pendingBatches.push([entry]);
          } else {
            if (!normalBatch) {
              normalBatch = [];
              pendingBatches.push(normalBatch);
            }
            normalBatch.push(entry);
          }
          if (tc?.id) idToEntry.set(tc.id, entry);
        }
        continue; // 跳过后续 tool 消息处理循环(由下一分支填 result)
      }
      // 无 tool_calls:若有 pending batch(文本+无 tool_calls 的 assistant),不常见,先收尾
      flushBatch();
      continue;
    }
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
      const target = idToEntry.get(id);
      const name = target?.name ?? '';
      const output = textOf((m as { content?: unknown }).content);
      const preview = summarizeToolResult(name, output);
      if (target) {
        target.resultSummary = preview;
        target.fullOutput = output;
      }
      // 不直接写屏——等 flushBatch 时出单行摘要
      continue;
    }
  }
  flushBatch(); // 末尾兜底
}
