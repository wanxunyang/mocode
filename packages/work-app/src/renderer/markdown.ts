/**
 * Zero-dependency Markdown renderer.
 *
 * 设计目标:覆盖 Agent 对话里常见的 markdown 子集,渲染质量高但体积小,
 * 与 Mocode Work 的"克制工具感"对齐。不引 marked / highlight.js / dompurify。
 *
 * 特性:
 *  - 块级:标题 h1–h6 / 段落 / 引用 / 有序无序列表 / 任务列表 / 表格 / 水平线 / 围栏代码块
 *  - 行内:**bold** *italic* ~~strike~~ `code` [link](url) 自动链接
 *  - 代码块:语言标签 + copy 按钮 + 折叠(超过 collapseLines 行)+ 轻量高亮
 *  - 安全:所有用户文本先 HTML 转义再插;只允许 markdown 语义产生的标签
 */

export interface RenderOptions {
  /** 代码块超过这个行数时折叠到首屏;0 = 永不折叠。默认 12。 */
  collapseLines?: number;
  /** Copy 按钮文案。默认 "复制"。 */
  copyLabel?: string;
  /** 折叠/展开按钮文案。默认 "展开 N 行" / "收起"。 */
  expandLabel?: (lineCount: number) => string;
  collapseLabel?: string;
}

const DEFAULTS: Required<RenderOptions> = {
  collapseLines: 12,
  copyLabel: '复制',
  expandLabel: (n) => `展开 ${n} 行`,
  collapseLabel: '收起',
};

const ESCAPE: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE[ch]!);
}

/* ─── Inline parser ─────────────────────────────────────── */

function parseInline(text: string): string {
  let out = escapeHtml(text);
  // 行内代码:优先处理,避免内部 * _ 被解析
  out = out.replace(/`([^`\n]+?)`/g, (_, code: string) => `<code>${code}</code>`);
  // 图片: ![alt](src "title") —— 必须在链接之前
  out = out.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt: string, src: string) =>
    `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy" />`);
  // 链接: [text](url) —— URL 只允许 http(s) / mailto,防 javascript:
  out = out.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, label: string, url: string) => {
    const safe = sanitizeUrl(url);
    if (!safe) return label;
    return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // 自动链接:裸露的 http(s)://x
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)(?=[\s),.]|$)/g, (_, lead: string, url: string) =>
    `${lead}<a href="${escapeAttr(sanitizeUrl(url) ?? url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  // 删除线
  out = out.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  // 加粗:必须在斜体之前
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  // 斜体
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(trimmed)) return trimmed; // 同源相对路径
  return null;
}

/* ─── Block parser ──────────────────────────────────────── */

interface CodeBlock { lang: string; content: string; }

function extractCodeFences(input: string): { text: string; codes: CodeBlock[] } {
  const codes: CodeBlock[] = [];
  const text = input.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang: string, content: string) => {
    const idx = codes.length;
    codes.push({ lang: lang.toLowerCase(), content });
    return `\u0000CODE${idx}\u0000`;
  });
  return { text, codes };
}

function restoreCodeFences(placeholder: string, codes: CodeBlock[], options: Required<RenderOptions>): string {
  return placeholder.replace(/\u0000CODE(\d+)\u0000/g, (_, idx: string) => {
    const block = codes[Number(idx)];
    if (!block) return '';
    return renderCodeBlock(block.lang, block.content, options);
  });
}

function parseBlocks(input: string, options: Required<RenderOptions>): string {
  const { text, codes } = extractCodeFences(input);
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 空行
    if (!line.trim()) { i += 1; continue; }

    // 围栏代码(占位符,说明还在 fenced 边界内)
    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
      out.push(restoreCodeFences(line.trim(), codes, options));
      i += 1;
      continue;
    }

    // 水平线
    if (/^ {0,3}([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && /^\s*[-*_](\s*[-*_]){2,}\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // 标题 ATX
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${parseInline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${parseBlocks(quote.join('\n'), options)}</blockquote>`);
      continue;
    }

    // 表格
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1]!)) {
      const headerCells = splitTableRow(line);
      i += 2; // 跳过 header + 分隔行
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i]!)) {
        bodyRows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      out.push(renderTable(headerCells, bodyRows));
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const listResult = parseList(lines, i);
      out.push(listResult.html);
      i = listResult.next;
      continue;
    }

    // 段落
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|\u0000CODE)/.test(lines[i]!)) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push(`<p>${parseInline(para.join('\n'))}</p>`);
  }

  return out.join('\n');
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function renderTable(header: string[], body: string[][]): string {
  const head = `<tr>${header.map((c) => `<th>${parseInline(c)}</th>`).join('')}</tr>`;
  const rows = body.map((r) => `<tr>${r.map((c) => `<td>${parseInline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

interface ListResult { html: string; next: number; }

function parseList(lines: string[], start: number): ListResult {
  const ordered = /^\s*\d+\.\s+/.test(lines[start]!);
  const tag = ordered ? 'ol' : 'ul';
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!bullet) break;
    // 缩进:bullet 前的空白决定嵌套
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent > 0 && items.length > 0) {
      // 嵌套列表:作为上一个 li 的内容
      const nested = parseList(lines, i);
      items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `${nested.html}</li>`);
      i = nested.next;
      continue;
    }
    // 任务列表?
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2]!);
    let content: string;
    if (taskMatch) {
      const checked = taskMatch[1]!.toLowerCase() === 'x';
      content = `<label class="md-task"><input type="checkbox" disabled ${checked ? 'checked' : ''} />${parseInline(taskMatch[2]!)}</label>`;
    } else {
      // 收集同段(行内 + 后续缩进行)
      const buf: string[] = [bullet[2]!];
      i += 1;
      while (i < lines.length) {
        const next = lines[i]!;
        if (!next.trim()) break;
        if (/^\s+/.test(next) && !/^\s*([-*+]|\d+\.)\s+/.test(next)) {
          buf.push(next.trim());
          i += 1;
        } else break;
      }
      content = parseInline(buf.join(' '));
      // 注意:我们没把 i 推进来,交给外层 while 用 bullet 重判
      items.push(`<li>${content}</li>`);
      continue;
    }
    items.push(`<li>${content}</li>`);
    i += 1;
  }
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

/* ─── Code block (fenced) ───────────────────────────────── */

function renderCodeBlock(lang: string, content: string, options: Required<RenderOptions>): string {
  const lines = content.replace(/\n$/, '').split('\n');
  const isLong = options.collapseLines > 0 && lines.length > options.collapseLines;
  const highlighted = highlightCode(lines, lang || 'text');
  const label = lang ? lang.toUpperCase() : 'TEXT';
  const escapedId = `mdc_${Math.random().toString(36).slice(2, 9)}`;

  const expandBtn = isLong
    ? `<button type="button" class="md-code-expand" data-target="${escapedId}">${options.expandLabel(lines.length - options.collapseLines)}</button>`
    : '';
  const collapseBtn = isLong
    ? `<button type="button" class="md-code-collapse hidden" data-target="${escapedId}">${options.collapseLabel}</button>`
    : '';
  const bodyClass = isLong ? 'md-code-body md-code-collapsed' : 'md-code-body';
  const tail = isLong
    ? `<div class="md-code-fade" data-target="${escapedId}"></div>`
    : '';

  return `<div class="md-code" data-md-code="${escapedId}">
    <header class="md-code-head">
      <span class="md-code-lang">${escapeHtml(label)}</span>
      <button type="button" class="md-code-copy" data-target="${escapedId}">${options.copyLabel}</button>
    </header>
    <pre class="${bodyClass}" id="${escapedId}"><code class="lang-${escapeAttr(lang || 'text')}">${highlighted}</code></pre>
    ${tail}
    ${expandBtn}
    ${collapseBtn}
  </div>`;
}

/* ─── Lightweight syntax highlighter ────────────────────── */

const TOKEN_KEYWORDS: Record<string, string[]> = {
  javascript: ['await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'],
  typescript: ['abstract', 'any', 'as', 'asserts', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'constructor', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield'],
  python: ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'],
  bash: ['alias', 'break', 'case', 'cd', 'command', 'continue', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'export', 'false', 'fi', 'for', 'function', 'if', 'in', 'local', 'printf', 'read', 'return', 'set', 'shift', 'source', 'then', 'true', 'unalias', 'unset', 'until', 'while'],
  json: [],
  css: ['auto', 'block', 'bold', 'border', 'center', 'column', 'dashed', 'display', 'flex', 'grid', 'hidden', 'inline', 'italic', 'left', 'none', 'right', 'solid', 'static', 'sticky', 'transparent', 'underline', 'var'],
  html: ['a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'],
  markdown: ['true', 'false', 'null'],
  yaml: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
};

const LANG_ALIAS: Record<string, keyof typeof TOKEN_KEYWORDS> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html', xml: 'html', svg: 'html',
  text: 'markdown', txt: 'markdown', '': 'markdown',
};

function highlightCode(lines: string[], lang: string): string {
  const key = LANG_ALIAS[lang] ?? (lang as keyof typeof TOKEN_KEYWORDS);
  const keywords = new Set(TOKEN_KEYWORDS[key] ?? []);
  const commentStyle = commentStyleFor(key);

  return lines.map((line) => {
    // 先做整行的注释 / 整行字符串(简化处理)
    if (commentStyle?.line && commentStyle.line.test(line)) {
      return `<span class="hl-c">${escapeHtml(line)}</span>`;
    }
    return highlightLine(line, key, keywords, commentStyle);
  }).join('\n');
}

interface CommentStyle { line?: RegExp; block?: { start: string; end: string }; strings: 'quote' | 'double' | 'single' | 'both' | 'none'; }

function commentStyleFor(key: string): CommentStyle | null {
  switch (key) {
    case 'javascript': case 'typescript':
      return { line: /\s*\/\//, block: { start: '/*', end: '*/' }, strings: 'both' };
    case 'python':
    case 'bash':
      return { line: /^\s*#/, strings: 'both' };
    case 'css':
      return { block: { start: '/*', end: '*/' }, strings: 'double' };
    case 'html':
      return { block: { start: '<!--', end: '-->' }, strings: 'double' };
    case 'json':
      return { strings: 'double' };
    case 'yaml':
      return { line: /^\s*#/, strings: 'quote' };
    default:
      return null;
  }
}

function highlightLine(line: string, key: string, keywords: Set<string>, style: CommentStyle | null): string {
  if (!style) return escapeHtml(line);

  // 简化的 tokenizer:把字符串 / 注释 / 数字 / 关键字用 placeholder 替换,最后再 escape + restore
  type Token = { kind: string; text: string };
  const tokens: Token[] = [];

  const push = (kind: string, text: string): void => { tokens.push({ kind, text }); };
  let i = 0;
  const n = line.length;

  while (i < n) {
    const rest = line.slice(i);

    // 块注释
    if (style.block && rest.startsWith(style.block.start)) {
      const end = line.indexOf(style.block.end, i + style.block.start.length);
      const stop = end === -1 ? n : end + style.block.end.length;
      push('c', line.slice(i, stop));
      i = stop;
      continue;
    }

    // 行注释
    if (style.line) {
      const m = style.line.exec(line.slice(i));
      if (m && m.index === 0) {
        push('c', line.slice(i));
        i = n;
        continue;
      }
    }

    // 字符串
    const stringCh = pickString(line, i, style.strings);
    if (stringCh) {
      const stop = scanString(line, i, stringCh);
      push('s', line.slice(i, stop));
      i = stop;
      continue;
    }

    // 数字
    if (/[0-9]/.test(line[i]!) && (i === 0 || /[\s,(\[:=<>+/*-]/.test(line[i - 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9._a-fxA-FX]/.test(line[j]!)) j += 1;
      push('n', line.slice(i, j));
      i = j;
      continue;
    }

    // 标识符 / 关键字
    if (/[A-Za-z_$]/.test(line[i]!)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j]!)) j += 1;
      const word = line.slice(i, j);
      push(keywords.has(word) ? 'k' : 'i', word);
      i = j;
      continue;
    }

    // 其他字符,累积到下一段
    let j = i;
    while (j < n && !/[A-Za-z_$0-9"'`/]/.test(line[j]!) && !style.block?.start.includes(line[j]!)) j += 1;
    if (j === i) { j = i + 1; }
    push('p', line.slice(i, j));
    i = j;
  }

  return tokens.map((t) => {
    if (t.kind === 'p') return escapeHtml(t.text);
    return `<span class="hl-${t.kind}">${escapeHtml(t.text)}</span>`;
  }).join('');
}

function pickString(line: string, i: number, mode: CommentStyle['strings']): string | null {
  const ch = line[i]!;
  if (ch === '"' && (mode === 'double' || mode === 'both')) return '"';
  if (ch === "'" && (mode === 'single' || mode === 'both')) return "'";
  if (ch === '`' && mode === 'both') return '`';
  return null;
}

function scanString(line: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\') { j += 2; continue; }
    if (line[j] === quote) { return j + 1; }
    j += 1;
  }
  return line.length;
}

/* ─── Public API ────────────────────────────────────────── */

export function renderMarkdown(input: string, options: RenderOptions = {}): string {
  if (!input) return '';
  const opts = { ...DEFAULTS, ...options };
  return parseBlocks(input, opts);
}

/**
 * 把带 .md-code 的 DOM 节点装上交互(copy / 展开收起)。
 * 渲染后调用一次即可,绑定事件代理。
 */
export function enhanceCodeBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.md-code').forEach((codeEl) => {
    const id = codeEl.dataset.mdCode;
    if (!id) return;
    if (codeEl.dataset.enhanced) return;
    codeEl.dataset.enhanced = '1';

    const copyBtn = codeEl.querySelector<HTMLButtonElement>('.md-code-copy');
    copyBtn?.addEventListener('click', async () => {
      const pre = document.getElementById(id);
      if (!pre) return;
      const text = pre.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '已复制';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = DEFAULTS.copyLabel; copyBtn.classList.remove('copied'); }, 1500);
      } catch {
        copyBtn.textContent = '复制失败';
        setTimeout(() => { copyBtn.textContent = DEFAULTS.copyLabel; }, 1500);
      }
    });

    const expandBtn = codeEl.querySelector<HTMLButtonElement>('.md-code-expand');
    const collapseBtn = codeEl.querySelector<HTMLButtonElement>('.md-code-collapse');
    const pre = document.getElementById(id);
    const fade = codeEl.querySelector<HTMLElement>('.md-code-fade');

    const expand = (): void => {
      pre?.classList.remove('md-code-collapsed');
      fade?.classList.add('hidden');
      expandBtn?.classList.add('hidden');
      collapseBtn?.classList.remove('hidden');
    };
    const collapse = (): void => {
      pre?.classList.add('md-code-collapsed');
      fade?.classList.remove('hidden');
      expandBtn?.classList.remove('hidden');
      collapseBtn?.classList.add('hidden');
    };
    expandBtn?.addEventListener('click', expand);
    collapseBtn?.addEventListener('click', collapse);
  });
}
