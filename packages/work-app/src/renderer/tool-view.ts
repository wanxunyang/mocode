/**
 * 工具块的人类可读视图（渲染层）。
 *
 * 为什么需要它：`tool_completed` 带回来的 output 是**给模型看的文本**，不是给人看的——
 *   · read_file 首行是 `[artifact source=read_file path=… hash=…]`（模型做去重用的标记）；
 *   · browser / dev_server 是 `JSON.stringify(payload, null, 2)`；
 *   · plan_update / note_append 首行是一句元信息，真正的内容在 markdown 里；
 *   · sub-agent 首行是 `[SubAgentResult status=… tokens=… cached=…]`。
 * 以前这些都被原样塞进 <pre>，用户看到的是 hash、token 计数和转义换行。
 *
 * 本模块把每类输出还原成它本来就是的结构（代码 / 终端 / 文件列表 / 命中分组 / 清单 /
 * 搜索结果 / 键值对），并给出**一行摘要**（"128 行"、"3 处匹配"、"失败"）供折叠行使用。
 * 解析不出来就返回 null，调用方回退到原始文本 —— 宁可显示原文，也不能显示错的解读。
 *
 * 纯渲染叶子模块：不依赖 i18n 运行时（文案由调用方注入，同 diff-view.ts 的做法）。
 */
import { highlightCodeLine, langForPath } from './markdown.js';

/** 一次工具块能拿到的全部非文本信息（来自 host 转发的结构化字段，见 src/host/stdio.ts）。 */
export interface ToolOutcomeInfo {
  status?: string;
  code?: string;
  changedFiles?: string[];
  editStartLine?: number;
  preWriteOld?: string | null;
  multiHunks?: ReadonlyArray<{ oldStr: string; newStr: string; startLine: number }>;
}

export interface ToolViewLabels {
  failed: string;
  denied: string;
  aborted: string;
  noOutput: string;
  truncated: string;
  lines: (n: number) => string;
  matches: (n: number) => string;
  files: (n: number) => string;
  results: (n: number) => string;
  changedFiles: (n: number) => string;
  steps: (done: number, total: number) => string;
  /** 代码块里「还有 n 行未显示」 */
  moreLines: (n: number) => string;
}

export interface ToolView {
  /** 折叠行右侧的状态文本（"128 行" / "3 处匹配" / "失败"）。 */
  summary: string;
  /** 展开区 HTML。 */
  html: string;
}

/** 展开区里最多渲染的行数：超长输出一律走「还有 n 行」尾注，避免一个块撑爆整个会话。 */
const MAX_RENDERED_LINES = 200;
/** 单行最大字符：minified JS / 单行 JSON 不截断会把横向撑爆。 */
const MAX_LINE_CHARS = 400;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

function clipLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…`;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function nonEmptyLines(text: string): string[] {
  return splitLines(text).filter((line) => line.trim().length > 0);
}

/** 解析 JSON 入参；失败返回 null（调用方回退原始文本）。 */
function parseArgs(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 带行号的代码块（read_file / 命中行 / 模板等共用）。startLine 是首行在文件里的真实行号。 */
function codeBlockHtml(lines: string[], options: { lang?: string; startLine?: number; labels: ToolViewLabels }): string {
  const lang = options.lang ?? 'text';
  const start = options.startLine ?? 1;
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const rows = shown
    .map((line, index) => {
      const text = line === '' ? '&nbsp;' : highlightCodeLine(clipLine(line), lang);
      return `<div class="tool-diff-row ctx"><span class="ln">${start + index}</span><span class="gut"></span><code>${text}</code></div>`;
    })
    .join('');
  const hidden = lines.length - shown.length;
  const tail = hidden > 0
    ? `<div class="tool-diff-row ellipsis"><span class="ln"></span><span class="gut"></span><code>${escapeHtml(options.labels.moreLines(hidden))}</code></div>`
    : '';
  return `<div class="tool-diff"><div class="tool-diff-body">${rows}${tail}</div></div>`;
}

/** 终端形态：命令行 + 原样输出（保留空白与缩进，不做高亮）。 */
function terminalHtml(command: string, body: string, labels: ToolViewLabels): string {
  const head = command
    ? `<div class="tool-term-cmd"><span class="tool-term-prompt">$</span>${escapeHtml(clipLine(command))}</div>`
    : '';
  const lines = splitLines(body);
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const hidden = lines.length - shown.length;
  return `<div class="tool-term">${head}<pre class="tool-term-out">${escapeHtml(shown.map(clipLine).join('\n'))}${hidden > 0 ? `\n${escapeHtml(labels.moreLines(hidden))}` : ''}</pre></div>`;
}

/** read_file：剥掉给模型看的 artifact 头，正文按行号 + 语法高亮渲染。 */
function readFileView(args: Record<string, unknown> | null, output: string, labels: ToolViewLabels): ToolView {
  const header = /^\[artifact[^\]]*path=(.+?) hash=[^\]]*\]\s*/i.exec(output);
  const body = header ? output.slice(header[0].length) : output;
  const rawPath = typeof args?.path === 'string' ? args.path : header?.[1] ?? '';
  const numbered: string[] = [];
  let firstLine = 1;
  for (const line of splitLines(body)) {
    const match = /^\s*(\d+)\t(.*)$/.exec(line);
    if (match) {
      if (numbered.length === 0) firstLine = Number(match[1]);
      numbered.push(match[2]!);
    } else if (line.startsWith('... (')) {
      // 分页尾注交给下面的正文行数统计，不再混进代码里
    } else {
      numbered.push(line);
    }
  }
  if (!numbered.length) {
    return { summary: labels.lines(0), html: `<pre class="tool-preview">${escapeHtml(labels.noOutput)}</pre>` };
  }
  const html = codeBlockHtml(numbered, { lang: langForPath(rawPath), startLine: firstLine, labels });
  return { summary: labels.lines(nonEmptyLines(body).length), html };
}

/** glob：纯路径列表。 */
function globView(output: string, labels: ToolViewLabels): ToolView {
  const files = nonEmptyLines(output).filter((line) => !line.startsWith('...'));
  if (!files.length) return { summary: labels.files(0), html: `<pre class="tool-preview">${escapeHtml(output.trim())}</pre>` };
  const items = files.slice(0, MAX_RENDERED_LINES)
    .map((file) => `<li><span class="tool-file-path">${escapeHtml(clipLine(file))}</span></li>`)
    .join('');
  return { summary: labels.files(files.length), html: `<ul class="tool-filelist">${items}</ul>` };
}

/**
 * grep：每文件一个分组头（`path: N 处匹配,行号 [...]`）+ 命中行（`  L3: 文本` / `  L3- 上下文`）。
 * 行号前缀剥进 gutter，与终端可读性一致；`--` 分隔保留为空行。
 */
function grepView(args: Record<string, unknown> | null, output: string, labels: ToolViewLabels): ToolView {
  const lang = typeof args?.path === 'string' ? langForPath(args.path) : 'text';
  const groups: string[] = [];
  let current: { header: string; rows: string[] } | null = null;
  let matches = 0;
  const flush = (): void => {
    if (!current) return;
    const body = current.rows.length
      ? `<div class="tool-diff-body">${current.rows.join('')}</div>`
      : '';
    groups.push(`<div class="tool-grep-group"><div class="tool-grep-head">${escapeHtml(current.header)}</div>${body}</div>`);
    current = null;
  };
  for (const line of splitLines(output)) {
    const header = /^(.+?):\s*(\d+)\s*处匹配/.exec(line);
    if (header) {
      flush();
      matches += Number(header[2]);
      current = { header: `${header[1]}: ${labels.matches(Number(header[2]))}`, rows: [] };
      continue;
    }
    if (!current) continue;
    const hit = /^ {2}L(\d+)([:-])\s?(.*)$/.exec(line);
    if (hit) {
      const op = hit[2] === ':' ? 'add' : 'ctx';
      current.rows.push(
        `<div class="tool-diff-row ${op}"><span class="ln">${hit[1]}</span><span class="gut">${hit[2] === ':' ? '·' : ''}</span><code>${highlightCodeLine(clipLine(hit[3] ?? ''), lang)}</code></div>`,
      );
    } else if (line.startsWith('  --')) {
      current.rows.push(`<div class="tool-diff-row ellipsis"><span class="ln"></span><span class="gut"></span><code>--</code></div>`);
    }
  }
  flush();
  if (!groups.length) {
    return { summary: labels.matches(matches), html: `<pre class="tool-preview">${escapeHtml(output.trim())}</pre>` };
  }
  return { summary: labels.matches(matches), html: groups.join('') };
}

/** run_command：首行是 `[退出码 N]` 这类状态徽标，其余是命令输出。 */
function runCommandView(args: Record<string, unknown> | null, output: string, labels: ToolViewLabels): ToolView {
  const command = typeof args?.command === 'string' ? args.command : '';
  const lines = splitLines(output.trim());
  let badge = '';
  let rest = lines;
  if (lines.length && /^\[(退出码|exit code)/.test(lines[0]!.trim())) {
    badge = lines[0]!.trim();
    rest = lines.slice(1);
  }
  const body = rest.join('\n').trimEnd();
  const html = `${badge ? `<div class="tool-term-badge">${escapeHtml(badge)}</div>` : ''}${terminalHtml(command, body || labels.noOutput, labels)}`;
  return { summary: labels.lines(rest.filter((line) => line.trim().length > 0).length), html };
}

/** plan_update：把 `- [x] N. **标题** — 内容` 清单还原成复选框列表。 */
function planView(output: string, labels: ToolViewLabels): ToolView {
  const steps: Array<{ done: boolean; current: boolean; title: string; detail: string }> = [];
  for (const line of splitLines(output)) {
    const match = /^- \[(x| )]\s*(?:\d+\.\s*)?(.*)$/.exec(line.trim());
    if (!match) continue;
    const raw = match[2] ?? '';
    const current = /◀/.test(raw);
    const body = raw.replace(/\s*◀.*$/, '');
    const bold = /^\*\*(.+?)\*\*\s*—\s*(.*)$/.exec(body);
    steps.push({ done: match[1] === 'x', current, title: bold ? bold[1]! : body, detail: bold ? bold[2]! : '' });
  }
  const headline = splitLines(output)[0]?.trim() ?? '';
  if (!steps.length) {
    return { summary: labels.steps(0, 0), html: `<pre class="tool-preview">${escapeHtml(output.trim())}</pre>` };
  }
  const done = steps.filter((step) => step.done).length;
  const items = steps
    .map((step) => {
      const mark = step.done ? '✓' : step.current ? '▸' : '·';
      const tone = step.done ? 'is-done' : step.current ? 'is-current' : '';
      const detail = step.detail ? `<span class="tool-plan-detail">${escapeHtml(clipLine(step.detail))}</span>` : '';
      return `<li class="tool-plan-step ${tone}"><span class="tool-plan-mark">${mark}</span><span class="tool-plan-title">${escapeHtml(clipLine(step.title))}</span>${detail}</li>`;
    })
    .join('');
  const head = headline ? `<div class="tool-plan-head">${escapeHtml(clipLine(headline))}</div>` : '';
  return { summary: labels.steps(done, steps.length), html: `${head}<ul class="tool-plan">${items}</ul>` };
}

/** note_append：剥掉那行元信息，只留笔记正文。 */
function noteView(output: string, labels: ToolViewLabels): ToolView {
  const lines = splitLines(output.trim());
  const head = lines[0] ?? '';
  const body = lines.slice(1).join('\n').trim();
  const html = `<div class="tool-note-head">${escapeHtml(clipLine(head))}</div><pre class="tool-preview">${escapeHtml(body || labels.noOutput)}</pre>`;
  return { summary: labels.lines(nonEmptyLines(body).length), html };
}

/** web_search：`[1] 标题` / `    url` / `    snippet` 还原成结果列表。 */
function webSearchView(output: string, labels: ToolViewLabels): ToolView {
  const results: Array<{ index: string; title: string; url: string; body: string[] }> = [];
  for (const line of splitLines(output)) {
    const head = /^\[(\d+)]\s*(.*)$/.exec(line);
    if (head) {
      results.push({ index: head[1]!, title: head[2] ?? '', url: '', body: [] });
      continue;
    }
    const current = results[results.length - 1];
    if (!current) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed) && !current.url) current.url = trimmed;
    else current.body.push(trimmed);
  }
  if (!results.length) {
    return { summary: labels.results(0), html: `<pre class="tool-preview">${escapeHtml(output.trim())}</pre>` };
  }
  const items = results
    .slice(0, 20)
    .map((result) => {
      const link = result.url
        ? `<a class="tool-search-url" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(clipLine(result.url))}</a>`
        : '';
      const body = result.body.length
        ? `<p class="tool-search-snippet">${escapeHtml(clipLine(result.body.join(' ')))}</p>`
        : '';
      return `<li class="tool-search-item"><div class="tool-search-title"><span class="tool-search-index">${escapeHtml(result.index)}</span>${escapeHtml(clipLine(result.title))}</div>${link}${body}</li>`;
    })
    .join('');
  return { summary: labels.results(results.length), html: `<ol class="tool-search">${items}</ol>` };
}

/** web_fetch：首行 `url (HTTP 200, text/html)` 当标题，其余是正文。 */
function webFetchView(output: string, labels: ToolViewLabels): ToolView {
  const lines = splitLines(output.trim());
  const head = /^(https?:\/\/\S+)\s*\((.*)\)$/.exec((lines[0] ?? '').trim());
  const title = head
    ? `<a class="tool-search-url" href="${escapeHtml(head[1]!)}" target="_blank" rel="noreferrer">${escapeHtml(clipLine(head[1]!))}</a><span class="tool-fetch-meta">${escapeHtml(head[2] ?? '')}</span>`
    : '';
  const body = (head ? lines.slice(1) : lines).join('\n').trim();
  const html = `${title ? `<div class="tool-fetch-head">${title}</div>` : ''}<pre class="tool-preview">${escapeHtml(body.slice(0, 8000))}${body.length > 8000 ? `\n${labels.truncated}` : ''}</pre>`;
  return { summary: labels.lines(nonEmptyLines(body).length), html };
}

/** browser / dev_server：输出是 JSON，转成键值行让人扫得动。 */
function jsonView(output: string, labels: ToolViewLabels): ToolView | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  const rows: string[] = [];
  const walk = (entry: unknown, depth: number): void => {
    if (entry === null || typeof entry !== 'object') return;
    for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
      const indent = depth > 0 ? ` style="padding-left:${depth * 10}px"` : '';
      if (item !== null && typeof item === 'object') {
        rows.push(`<div class="tool-kv-row"${indent}><span class="tool-kv-key">${escapeHtml(key)}</span></div>`);
        if (depth < 3) walk(item, depth + 1);
      } else {
        rows.push(`<div class="tool-kv-row"${indent}><span class="tool-kv-key">${escapeHtml(key)}</span><span class="tool-kv-value">${escapeHtml(clipLine(String(item)))}</span></div>`);
      }
    }
  };
  walk(value, 0);
  if (!rows.length) return null;
  return { summary: labels.lines(rows.length), html: `<div class="tool-kv">${rows.join('')}</div>` };
}

/**
 * sub-agent：首行 `[SubAgentResult status=… tokens=…]` 是给模型的元数据，剥掉只留结论。
 *
 * 运行期这个工具的 output 是 spawn 回吐的进度行（`▸ read_file  src/foo.ts`），
 * 那时还没有结论 —— 渲染成一份「它正在干什么」的清单，而不是一坨纯文本。
 * 这是 GUI 里唯一能看到子 agent 内部动作的地方（终端走 batch 实时渲染，GUI 没有那条路）。
 */
function subAgentView(args: Record<string, unknown> | null, output: string, labels: ToolViewLabels): ToolView {
  const marker = /^\[SubAgentResult[^\]]*]\s*/.exec(output.trim());
  const body = marker ? output.trim().slice(marker[0].length) : output.trim();
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  // 折叠行已经显示 prompt（tool-target），这里只在它会被截断时补全文，否则重复两遍很吵。
  const head = prompt && prompt.length > 120 ? `<div class="tool-note-head">${escapeHtml(prompt)}</div>` : '';

  const progress: string[] = [];
  const rest: string[] = [];
  for (const line of splitLines(body)) {
    if (/^[▸●↳]\s/.test(line.trim())) progress.push(line.trim());
    else rest.push(line);
  }
  const conclusion = rest.join('\n').trim();
  const progressHtml = progress.length
    ? `<ul class="tool-progress">${progress
        .slice(-40)
        .map((line) => `<li><span class="tool-progress-mark">${escapeHtml(line[0] ?? '·')}</span>${escapeHtml(clipLine(line.slice(1).trim()))}</li>`)
        .join('')}</ul>`
    : '';
  if (!conclusion) {
    // 还在跑：只有进度行。
    return { summary: labels.lines(progress.length), html: `${head}${progressHtml || `<pre class="tool-preview">${escapeHtml(labels.noOutput)}</pre>`}` };
  }
  return {
    summary: labels.lines(nonEmptyLines(conclusion).length),
    html: `${head}${progressHtml}<pre class="tool-preview">${escapeHtml(conclusion)}</pre>`,
  };
}

/**
 * 工具失败 / 被拒 / 中断：这三种结局的正文本身就是给人看的原因，
 * 不做结构化解读，只保证视觉上区分得开（不再是「成功但输出很怪」）。
 */
function statusView(info: ToolOutcomeInfo, output: string, labels: ToolViewLabels): ToolView | null {
  const status = info.status;
  if (status === 'denied') {
    return { summary: labels.denied, html: `<pre class="tool-preview tool-preview-error">${escapeHtml(output.trim() || labels.denied)}</pre>` };
  }
  if (status === 'aborted') {
    return { summary: labels.aborted, html: `<pre class="tool-preview tool-preview-error">${escapeHtml(output.trim() || labels.aborted)}</pre>` };
  }
  if (status === 'error') {
    return { summary: labels.failed, html: `<pre class="tool-preview tool-preview-error">${escapeHtml(output.trim() || labels.failed)}</pre>` };
  }
  return null;
}

/**
 * 主入口：按工具名挑渲染器。
 * 返回 null 表示「这类输出我没有可靠解读」——调用方回退原始参数 + 原文（宁可朴素，不能误导）。
 */
export function buildToolView(
  name: string,
  rawArgs: string,
  output: string,
  info: ToolOutcomeInfo,
  labels: ToolViewLabels,
): ToolView | null {
  const args = parseArgs(rawArgs);
  const failed = statusView(info, output, labels);

  // 文件编辑走 diff 视图（renderer 侧先试），这里不重复实现。
  if (name === 'edit_file' || name === 'write_file') return failed;

  if (failed) {
    // 失败时仍然尽量给「它在干什么」的上下文：错误文本 + 该工具的对象。
    return failed;
  }
  const text = output.trim();
  if (!text) return { summary: labels.noOutput, html: `<pre class="tool-preview">${escapeHtml(labels.noOutput)}</pre>` };

  switch (name) {
    case 'read_file':
    case 'view_image':
      return readFileView(args, text, labels);
    case 'run_command':
      return runCommandView(args, text, labels);
    case 'dev_server':
    case 'browser':
    case 'computer':
      return jsonView(text, labels) ?? { summary: labels.lines(nonEmptyLines(text).length), html: `<pre class="tool-preview">${escapeHtml(text.slice(0, 8000))}</pre>` };
    case 'glob':
      return globView(text, labels);
    case 'grep':
      return grepView(args, text, labels);
    case 'web_search':
      return webSearchView(text, labels);
    case 'web_fetch':
      return webFetchView(text, labels);
    case 'plan_update':
      return planView(text, labels);
    case 'note_append':
      return noteView(text, labels);
    case 'sub-agent':
      return subAgentView(args, text, labels);
    default:
      return null;
  }
}