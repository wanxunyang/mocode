import { readFileSync } from 'node:fs';
import { ui } from '../ui/theme.js';
import { renderFileChange, renderMultiFileChange } from '../ui/diff.js';
import { isToolErrorOutput } from '../tools/result.js';
import { jailResolve } from '../sandbox/index.js';
import * as layout from '../ui/layout.js';
import * as batch from '../ui/batch.js';
import { displayWidth, padEndDisplay, summarizeToolCall, summarizeToolResult } from '../ui/render.js';
import { renderChip } from '../attachments/image.js';
import { t } from '../i18n/index.js';
import { PROMPT } from './commands.js';
import type { ChatMessage } from '../llm/index.js';
import type { ImageAttachment } from '../attachments/image.js';

/** compact 摘要消息头(与 session/compact.ts SUMMARY_MARKER 同值;本地复制避免拉入 compact 的重依赖图,同 retention.ts)。 */
const SUMMARY_MARKER = '# 会话摘要';
/** 回放时摘要最多显示的字符数(摘要上限 6000,全量回放会淹没保留的用户原话)。 */
const SUMMARY_REPLAY_MAX_CHARS = 3000;

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

const toLf = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** 回放用的行号定位:在**当前**文件里找 text 的唯一命中行(edit 已落盘,找新文本);找不到/不唯一退回 1。 */
function locateLine(filePath: string, text: string): number {
  if (!text) return 1;
  try {
    const data = toLf(readFileSync(jailResolve(filePath), 'utf8'));
    const needle = toLf(text);
    const first = data.indexOf(needle);
    if (first < 0 || data.indexOf(needle, first + needle.length) !== -1) return 1;
    return data.slice(0, first).split('\n').length;
  } catch {
    return 1;
  }
}

/**
 * 由历史里的工具参数重建 edit_file/write_file 的 diff 块(回放时自动展开用)。
 * history 只存参数不存执行前快照,所以是尽力还原:
 *  - write_file 无旧内容 → 按 Create 展示全部为新增行;
 *  - edit_file 行号在当前文件里按新文本定位,定位不到退回相对行号 1;
 *  - 行号区间模式(无 old_string)、失败结果、参数非法 → 返回 null,退回单行摘要。
 */
export function buildReplayDiff(name: string, rawArgs: string, output: string): string | null {
  if (isToolErrorOutput(output)) return null;
  let parsed: Record<string, unknown>;
  try {
    const v = JSON.parse(rawArgs);
    if (!v || typeof v !== 'object') return null;
    parsed = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const filePath = String(parsed.path ?? '');
  if (!filePath) return null;
  if (name === 'write_file') {
    if (typeof parsed.content !== 'string') return null;
    return renderFileChange({ path: filePath, kind: 'write', oldStr: null, newStr: parsed.content, startLine: 1 });
  }
  if (name !== 'edit_file') return null;
  if (Array.isArray(parsed.replacements) && parsed.replacements.length > 0) {
    const hunks: Array<{ oldStr: string; newStr: string; startLine: number }> = [];
    for (const item of parsed.replacements) {
      const rec = item as Record<string, unknown> | null;
      if (!rec || typeof rec.old_string !== 'string' || typeof rec.new_string !== 'string') return null;
      hunks.push({
        oldStr: rec.old_string,
        newStr: rec.new_string,
        startLine: locateLine(filePath, rec.new_string),
      });
    }
    return (
      renderMultiFileChange({ path: filePath, hunks }) ??
      renderFileChange({
        path: filePath,
        kind: 'edit',
        oldStr: hunks.map((h) => h.oldStr).join('\n'),
        newStr: hunks.map((h) => h.newStr).join('\n'),
        startLine: hunks[0].startLine,
      })
    );
  }
  if (typeof parsed.old_string !== 'string' || typeof parsed.new_string !== 'string') return null;
  return renderFileChange({
    path: filePath,
    kind: 'edit',
    oldStr: parsed.old_string,
    newStr: parsed.new_string,
    startLine: locateLine(filePath, parsed.new_string),
  });
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
  const idToArgs = new Map<string, string>(); // tool_call id → 原始参数 JSON,供重建 mutation diff
  // 普通工具可跨 assistant 步聚合；mutation 各自占一个 group，并切断前后普通工具。
  let pendingBatches: batch.BatchEntry[][] = [];
  let normalBatch: batch.BatchEntry[] | null = null;
  const flushBatch = (): boolean => {
    if (pendingBatches.length === 0) return false;
    // 气泡/正文 → 摘要行边界:尾部视觉空行幂等收成 1 条(与实时 writeToolHeader 同语义)。
    layout.normalizeMutationBoundary();
    for (const entries of pendingBatches) batch.writeSummaryOnly(entries, layout);
    pendingBatches = [];
    normalBatch = null;
    return true;
  };
  for (let idx = 0; idx < history.length; idx++) {
    const m = history[idx];
    if (m.role === 'system') {
      // compact 摘要是被压缩掉的助手回复/工具过程的唯一留存:回放时显示出来(history[0] 的系统提示仍跳过)。
      const body = textOf((m as { content?: unknown }).content);
      if (idx > 0 && body.startsWith(SUMMARY_MARKER)) {
        flushBatch();
        layout.normalizeMutationBoundary();
        layout.contentWrite(`${ui.dim}${t('repl.compactedNotice')}${ui.reset}\n\n`);
        const text = body.slice(SUMMARY_MARKER.length).trim();
        if (text.length > SUMMARY_REPLAY_MAX_CHARS) {
          layout.contentWriteMdOnce(text.slice(0, SUMMARY_REPLAY_MAX_CHARS));
          layout.contentWrite(
            `${ui.dim}${t('repl.compactedTruncated', { total: text.length, shown: SUMMARY_REPLAY_MAX_CHARS })}${ui.reset}\n`,
          );
        } else {
          layout.contentWriteMdOnce(text);
        }
        layout.normalizeMutationBoundary();
      }
      continue;
    }
    if (m.role === 'user') {
      flushBatch(); // 上一轮 batch(若有)收尾
      // 上一条 agent 正文 → 本条用户气泡:contentWriteMdOnce 会裁掉 markdown 尾部空行,
      // 不归一的话气泡紧贴正文(实时对话由 REPL 循环顶部的 normalizeInputBoundary 保证恰好 1 条空行)。
      layout.normalizeInputBoundary();
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
          if (tc?.id) {
            idToEntry.set(tc.id, entry);
            idToArgs.set(tc.id, args);
          }
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
      if (target) {
        // mutation 成功:重建 diff 块,回放时自动展开(与实时一致);否则退回单行摘要。
        const diff = batch.isMutationToolName(name) ? buildReplayDiff(name, idToArgs.get(id) ?? '', output) : null;
        target.diffBlock = diff;
        target.resultSummary = diff ? '' : summarizeToolResult(name, output);
        target.fullOutput = output;
      }
      // 不直接写屏——等 flushBatch 时出单行摘要
      continue;
    }
  }
  flushBatch(); // 末尾兜底
}
