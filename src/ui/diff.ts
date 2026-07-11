import { highlight, plain, type Theme } from 'cli-highlight';
import { ui, type ColorKey } from './theme.js';
import { charWidth, displayWidth } from './render.js';

/**
 * 文件改动 diff 渲染:
 *   Update(path) / Create(path) + Added N lines, removed M lines
 *   正文带文件行号 + `-` 红 / `+` 绿 gutter + 代码经 cli-highlight 语法高亮。
 *
 * 纯渲染叶子模块——不依赖 config / 业务;颜色经 theme 非 TTY 退化为空串,
 * 输出供 layout.contentWrite 写入(区域滚动 / 底栏保护 / 续写位跟踪均由其内置)。
 * 高亮逐行做(每行自成 SGR 闭区间,末尾补 reset 防跨行泄漏);多行构造(块注释 / 模板串)的内部行可能不上色,可接受。
 */

/** 行级 diff 单元:ctx 不变 / add 新增 / del 删除。 */
export type DiffOp = 'ctx' | 'add' | 'del';
export interface DiffLine {
  op: DiffOp;
  text: string;
}

const MAX_FULL_DIFF_LINES = 800; // 任一边超此行数则跳过全量 LCS(避免大文件 O(n·m) 高开销)
const MAX_BODY_LINES = 24; // 正文最多展示行数(超出尾注「还有 N 行未显示」)
const MAX_LINE_DISPLAY = 120; // 单行截断显示宽度(CJK / 全角按 2 计)
const HEAD_INDENT = '  ';
const BODY_INDENT = '    ';

/** 扩展名 / 文件名 → cli-highlight(hljs)语言 id;未命中则不高亮(纯文本)。 */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.json': 'json', '.json5': 'json',
  '.md': 'markdown', '.markdown': 'markdown',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.svg': 'xml',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.c': 'cpp', '.h': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.sql': 'sql', '.lua': 'lua', '.r': 'r', '.dart': 'dart', '.scala': 'scala', '.groovy': 'groovy',
  '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'ini',
  '.dockerfile': 'dockerfile', 'dockerfile': 'dockerfile', 'makefile': 'makefile', '.mk': 'makefile',
};

function langForPath(p: string): string | undefined {
  const lower = p.toLowerCase();
  const slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot);
    if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  }
  return LANG_BY_EXT[base];
}

/**
 * 包一层:token 文本 + 颜色 + reset,自成闭区间(防 SGR 跨行泄漏)。
 * 取 ColorKey 而非 ANSI 串——闭包调用时才读 `ui[key]`,故 setTheme 后 diff 高亮即跟随。 */
const paint = (key: ColorKey) => (s: string): string => `${ui[key]}${s}${ui.reset}`;

/** 自定义主题:default=plain(未匹配文本不着色,避免默认主题把普通代码染黄),常见 token 用 mocode ui 色板。 */
const THEME: Theme = {
  default: plain,
  keyword: paint('magenta'),
  'built_in': paint('cyan'),
  type: paint('cyan'),
  literal: paint('cyan'),
  number: paint('green'),
  string: paint('green'),
  subst: paint('green'),
  comment: paint('gray'),
  doctag: paint('gray'),
  function: paint('blue'),
  title: paint('blue'),
  class: paint('brightCyan'),
  meta: paint('gray'),
  'meta-keyword': paint('magenta'),
  regexp: paint('red'),
  attr: paint('cyan'),
  attribute: paint('cyan'),
  variable: paint('red'),
  tag: paint('red'),
  name: paint('cyan'),
  symbol: paint('cyan'),
  section: paint('brightMagenta'),
  addition: paint('green'),
  deletion: paint('red'),
};

function highlightLine(text: string, lang: string | undefined): string {
  if (!lang || text === '') return text;
  try {
    return highlight(text, { language: lang, theme: THEME });
  } catch {
    return text; // 语言未注册 / 解析失败:退化为纯文本
  }
}

/** 按行切分;去掉末尾单个空行(由末尾 \n 产生)与行尾 \r(CRLF 兼容)。 */
function splitLines(s: string): string[] {
  const a = s.split('\n');
  if (a.length > 1 && a[a.length - 1] === '') a.pop();
  for (let i = 0; i < a.length; i++) {
    if (a[i].endsWith('\r')) a[i] = a[i].slice(0, -1);
  }
  return a;
}

/** 按显示宽度截断(不含省略号);CJK / 全角按 2 计,零宽符附上不推进。 */
function truncatePlain(s: string, width: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw <= 0) {
      out += ch;
      continue;
    }
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** 截断(plain)→ 高亮 → 末尾补 reset(+ 截断尾注)。 */
function codeText(text: string, lang: string | undefined): string {
  let plain = text;
  let cut = false;
  if (displayWidth(plain) > MAX_LINE_DISPLAY) {
    plain = truncatePlain(plain, MAX_LINE_DISPLAY - 1);
    cut = true;
  }
  return highlightLine(plain, lang) + ui.reset + (cut ? `${ui.dim}…${ui.reset}` : '');
}

/**
 * 行级 LCS diff。返回 op 序列(ctx/add/del)。
 * 任一边超 MAX_FULL_DIFF_LINES 返回 null(降级,由调用方走「省略 diff」分支)。
 */
export function lineDiff(oldS: string, newS: string): DiffLine[] | null {
  const a = splitLines(oldS);
  const b = splitLines(newS);
  if (a.length > MAX_FULL_DIFF_LINES || b.length > MAX_FULL_DIFF_LINES) return null;
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', text: a[i] });
      i++;
    } else {
      out.push({ op: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ op: 'add', text: b[j] });
    j++;
  }
  return out;
}

type Item =
  | { kind: 'ctx'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ellipsis'; count: number };

/** 连续 ctx 折叠:run ≤3 全显;>3 显首 + …(n) + 尾(保留紧邻改动的上下文)。 */
function compactCtx(ops: DiffLine[]): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op !== 'ctx') {
      items.push({ kind: ops[i].op, text: ops[i].text });
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].op === 'ctx') j++;
    const run = ops.slice(i, j);
    if (run.length <= 3) {
      for (const r of run) items.push({ kind: 'ctx', text: r.text });
    } else {
      items.push({ kind: 'ctx', text: run[0].text });
      items.push({ kind: 'ellipsis', count: run.length - 2 });
      items.push({ kind: 'ctx', text: run[run.length - 1].text });
    }
    i = j;
  }
  return items;
}

function gutterOf(op: DiffOp): string {
  if (op === 'del') return `${ui.red}-${ui.reset}`;
  if (op === 'add') return `${ui.green}+${ui.reset}`;
  return `${ui.dim} ${ui.reset}`;
}

function lineWord(n: number): string {
  return n === 1 ? 'line' : 'lines';
}

/**
 * 渲染文件改动块(供 layout.contentWrite 写入)。
 *  - kind:'edit' 头行用 Update;kind:'write' 用 Update(覆盖)/ Create(oldStr===null 新建)。
 *  - oldStr===null 表示新建:正文只显 + 行,行号从 1。
 *  - startLine:diff 首行对应的文件行号(edit_file 由调用方定位 old_string 起始行;write_file 传 1)。
 *  - diff 过大(超 MAX_FULL_DIFF_LINES)时仅显头行 + 「file too large, diff omitted」。
 */
export function renderFileChange(opts: {
  path: string;
  kind: 'edit' | 'write';
  oldStr: string | null;
  newStr: string;
  startLine?: number;
}): string {
  const { path, kind, oldStr, newStr } = opts;
  const startLine = opts.startLine ?? 1;
  const lang = langForPath(path);
  const pathDisp = path; // 路径原样展示(不做截断,长路径由 contentWrite 折行)
  const verb = oldStr === null ? 'Create' : 'Update';

  // 头行:Update(path) / Create(path)
  const head = `${HEAD_INDENT}${ui.bold}${ui.accent}${verb}${ui.reset}${ui.gray}(${ui.reset}${ui.accent}${pathDisp}${ui.reset}${ui.gray})${ui.reset}`;

  // 新建:整文件作 + 行,行号从 1
  if (oldStr === null) {
    const lines = splitLines(newStr);
    const counts = `${HEAD_INDENT}  ${ui.dim}Added ${ui.reset}${ui.green}${lines.length}${ui.reset}${ui.dim} ${lineWord(lines.length)}${ui.reset}`;
    const padW = Math.max(3, String(startLine + lines.length - 1).length);
    return renderBody(head, counts, lines.map((l) => ({ kind: 'add', text: l })), padW, startLine, lang);
  }

  const ops = lineDiff(oldStr, newStr);
  if (ops === null) {
    return `${head}\n${HEAD_INDENT}  ${ui.dim}(file too large, diff omitted)${ui.reset}\n`;
  }
  let add = 0;
  let del = 0;
  for (const o of ops) {
    if (o.op === 'add') add++;
    else if (o.op === 'del') del++;
  }
  // 计数行:Added N lines, removed M lines(按需省略 0 项)
  const parts: string[] = [];
  if (add > 0) parts.push(`${ui.dim}Added ${ui.reset}${ui.green}${add}${ui.reset}${ui.dim} ${lineWord(add)}`);
  if (del > 0) parts.push(`${ui.dim}removed ${ui.reset}${ui.red}${del}${ui.reset}${ui.dim} ${lineWord(del)}`);
  const counts =
    parts.length > 0
      ? `${HEAD_INDENT}  ${parts.join(`${ui.dim}, ${ui.reset}`)}${ui.reset}`
      : `${HEAD_INDENT}  ${ui.dim}No changes${ui.reset}`;
  if (add === 0 && del === 0) return `${head}\n${counts}\n`;
  const oldLen = splitLines(oldStr).length;
  const newLen = splitLines(newStr).length;
  const padW = Math.max(3, String(startLine + Math.max(oldLen, newLen) - 1).length);
  return renderBody(head, counts, compactCtx(ops), padW, startLine, lang);
}

/** 头行 + 计数行 + 正文(折叠 + 截断 + 行号),每行尾 \n。 */
function renderBody(head: string, counts: string, items: Item[], padW: number, startLine: number, lang: string | undefined): string {
  const lines: string[] = [head, counts];
  const metaPrefix = `${BODY_INDENT}${' '.repeat(padW)}   `; // 对齐到代码列(num + 空格 + gutter + 空格)

  let oldLine = startLine;
  let newLine = startLine;
  let shown = 0;
  let overflow = 0;

  const pushBody = (num: number, op: DiffOp, text: string): void => {
    const numStr = String(num).padStart(padW);
    // 行级底色:仅代码区包裹主题底色(addBg/delBg),行号与 gutter 不着底色
    // (避免整行被背景化,符合 GitHub / VSCode 视觉)。行末由 codeText 内置 reset 闭合 →
    // bg 不污染下一行。
    //   同时,代码区由 cli-highlight 渲染,内部会反复 ${fg}tok${reset}tok${fg}tok${reset}…
    //   每个 reset 都会清掉外层 bg → 后面的 token 变无色。所以要在每个 reset 后重发 bg SGR
    //   (行末那枚 reset 是收尾的,后面紧跟换行而非字符,不需补 bg)。
    const bg = op === 'add' ? ui.addBg : op === 'del' ? ui.delBg : '';
    const rawCode = codeText(text, lang);
    if (bg === '') {
      lines.push(`${BODY_INDENT}${ui.gray}${numStr}${ui.reset} ${gutterOf(op)} ${rawCode}`);
      return;
    }
    const codeWithBg = `${bg}${rawCode}${ui.reset}`;
    // 在每个非行末的 ${ui.reset} 后重发 bg。行末 reset 紧跟行尾或换行,无需补。
    // 用 split 走一遍:找出所有 reset 位置(除最后那个),在其后插入 bg。
    const resetStr = ui.reset;
    const lastResetIdx = codeWithBg.lastIndexOf(resetStr);
    if (lastResetIdx < 0) {
      lines.push(`${BODY_INDENT}${ui.gray}${numStr}${ui.reset} ${gutterOf(op)} ${codeWithBg}`);
      return;
    }
    const prefix = codeWithBg.slice(0, lastResetIdx);
    const tail = codeWithBg.slice(lastResetIdx);
    const parts = prefix.split(resetStr);
    let rebuilt = parts[0];
    for (let i = 1; i < parts.length; i++) {
      rebuilt += resetStr + bg + parts[i];
    }
    lines.push(`${BODY_INDENT}${ui.gray}${numStr}${ui.reset} ${gutterOf(op)} ${rebuilt + tail}`);
  };

  for (const it of items) {
    if (shown >= MAX_BODY_LINES) {
      overflow++;
      continue;
    }
    if (it.kind === 'ellipsis') {
      oldLine += it.count;
      newLine += it.count;
      lines.push(`${metaPrefix}${ui.dim}…(${it.count} 行不变)${ui.reset}`);
      shown++;
      continue;
    }
    if (it.kind === 'del') {
      pushBody(oldLine, 'del', it.text);
      oldLine++;
    } else if (it.kind === 'add') {
      pushBody(newLine, 'add', it.text);
      newLine++;
    } else {
      pushBody(newLine, 'ctx', it.text);
      oldLine++;
      newLine++;
    }
    shown++;
  }
  if (overflow > 0) {
    lines.push(`${metaPrefix}${ui.dim}…(还有 ${overflow} 行未显示)${ui.reset}`);
  }
  return lines.join('\n') + '\n';
}
