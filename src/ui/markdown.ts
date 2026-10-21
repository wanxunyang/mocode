// agent 正文 markdown → ANSI 物理行渲染(纯函数,legacy TUI 用)。
//
// agent 的 onText 流式 chunk 经 layout.contentWriteMd 累积成整段 text,再由此渲染成
// 带色物理行(每行 ≤ cols、自洽带色)写进 content.ts 缓冲。流式安全:每 chunk 重新渲染
// 整段(text 可能停在未闭合 ``` fence 中段,状态机扫到 EOF 仍 inFence 时把已累积代码行
// 当「进行中代码块」照常 emit,边生成边显)。
//
// 样式:代码块 Flat——语言标签 dim 置顶 + 2 空格 gutter + cli-highlight
// 语法高亮 + 软折行,无边框。其余:标题/列表(嵌套)/行内代码/粗体/斜体/删除线/链接/引用块/分隔线。
//
// 硬约束:每行 ansiDisplayWidth ≤ cols(layout.repaintViewport 直出行,超宽会让终端 auto-wrap
// 错位;若上层 <Text wrap=truncate> 补 … U+2026 在中文终端算 2 宽会顶屏)。所有路径软折行 +
// clipAnsiLine 兜底,绝不溢出。颜色一律嵌入式 ANSI(ui.*)写进字符串。
import { getCliHighlight } from './cli-highlight-lazy.js';
import { ui, getThemeVersion } from './theme.js';
import { graphemeAt, displayWidth, ansiDisplayWidth, stripAnsi } from './render.js';

/** 渲染后单个代码块的定位信息(行号为本次输出 lines[] 的 0-based 相对行)。 */
export interface RenderedCodeBlock {
  /** header 行(语言标签 + 右侧复制按钮)在 lines 中的下标。 */
  headerLine: number;
  /** 第一段代码物理行下标(软折行后可能 > 源码行数)。 */
  codeStartLine: number;
  /** 最后一段代码物理行下标;空代码块时 < codeStartLine。 */
  codeEndLine: number;
  /** 复制按钮(` ❐ `,贴 header 行右端)的显示列区间 [buttonColStart, buttonColEnd),0-based;窄窗放不下时为 -1。 */
  buttonColStart: number;
  buttonColEnd: number;
  /** fence 语言标注(可能为空串)。 */
  lang: string;
  /** 代码块原文(不含 fence / 语言行),点击复制时写入剪贴板。 */
  code: string;
}

const RESET = '\x1b[0m';
// theme 无 italic/strike,自备(TTY 感知:!isTTY 退化为空串,同 ui.* 契约)。
const ITALIC = ui.isTTY ? '\x1b[3m' : '';
const STRIKE = ui.isTTY ? '\x1b[9m' : '';

/** 内联 token:可见文本 + 开头要套的 SGR(可叠加嵌套前缀;'' = 默认色)。 */
interface Seg {
  sgr: string;
  text: string;
}

/**
 * ANSI 感知的硬切(**不补 …**):保留串内 SGR 码,按可见宽度截到 ≤ width,末尾补 reset
 * 防断色。用于 markdown 代码行 / 超长单行带色块——绝不能补 …('…' 在中文终端算 2 宽会
 * 触发 auto-wrap 整屏左移)。宽度未超直接原样返回。
 */
function clipAnsiLine(str: string, width: number): string {
  if (ansiDisplayWidth(str) <= width) return str;
  let w = 0;
  let out = '';
  const parts = str.split(/(\x1b\[[0-9;]*m)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i];
      continue;
    }
    const seg = parts[i];
    for (let gi = 0; gi < seg.length; ) {
      const g = graphemeAt(seg, gi);
      const ch = seg.slice(gi, g.end);
      gi = g.end;
      if (g.width > 0 && w + g.width > width) {
        return out + RESET;
      }
      if (g.width > 0) w += g.width;
      out += ch;
    }
  }
  return out;
}
void clipAnsiLine; // 供本模块内部用;亦在下方 export 给 layout/content 复用

// ── 内联 markdown → Seg[] ──

/** 找从 from 起、连续 ch 长度 ≥ run 的运行起点;无则 -1。用于配对 `code` 反引号运行。 */
function findRun(text: string, ch: string, from: number, run: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === ch) {
      let c = 0;
      while (i + c < text.length && text[i + c] === ch) c++;
      if (c >= run) return i;
      i += c;
    } else {
      i++;
    }
  }
  return -1;
}

/** 尝试在 from(`[`)处匹配 [text](url);成功返 {text, end=')' 后下标},否则 null。 */
function matchLink(text: string, from: number): { text: string; end: number } | null {
  let i = from + 1;
  while (i < text.length && text[i] !== ']') i++;
  if (i >= text.length) return null;
  const linkText = text.slice(from + 1, i);
  i++; // 跳过 ]
  if (text[i] !== '(') return null;
  i++;
  while (i < text.length && text[i] !== ')') i++;
  if (i >= text.length) return null;
  return { text: linkText, end: i + 1 };
}

/**
 * 内联 markdown → Seg[](有序 token 流)。支持:行内 code、bold、italic、strike、link。
 * _italic_ 带词边界 flank 检查(避免 snake_case 被斜体)。emphasis 递归一层(粗体内可含
 * 斜体/代码);code/link 内部当字面量(不再递归)。未配对的标记按字面量透传;反斜杠转义下一字符。
 */
function renderInline(text: string): Seg[] {
  const segs: Seg[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      segs.push({ sgr: '', text: buf });
      buf = '';
    }
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // 转义
    if (ch === '\\' && i + 1 < n) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    // 行内代码:`+ 运行,配对同长度运行
    if (ch === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      const close = findRun(text, '`', i + run, run);
      if (close >= 0) {
        flush();
        segs.push({ sgr: ui.yellow, text: text.slice(i + run, close) });
        i = close + run;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    // 链接 [text](url)
    if (ch === '[') {
      const m = matchLink(text, i);
      if (m) {
        flush();
        segs.push({ sgr: ui.cyan, text: m.text });
        i = m.end;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    // ~~strike~~
    if (ch === '~' && text[i + 1] === '~') {
      const close = text.indexOf('~~', i + 2);
      if (close >= 0) {
        flush();
        for (const s of renderInline(text.slice(i + 2, close))) {
          segs.push({ sgr: STRIKE + s.sgr, text: s.text });
        }
        i = close + 2;
        continue;
      }
      buf += '~~';
      i += 2;
      continue;
    }
    // **bold** / __bold__
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const marker = ch + ch;
      const close = text.indexOf(marker, i + 2);
      if (close >= 0) {
        flush();
        for (const s of renderInline(text.slice(i + 2, close))) {
          segs.push({ sgr: ui.bold + s.sgr, text: s.text });
        }
        i = close + 2;
        continue;
      }
      buf += marker;
      i += 2;
      continue;
    }
    // *italic*(单星号)
    if (ch === '*') {
      const close = text.indexOf('*', i + 1);
      if (close > i + 1) {
        flush();
        for (const s of renderInline(text.slice(i + 1, close))) {
          segs.push({ sgr: ITALIC + s.sgr, text: s.text });
        }
        i = close + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    // _italic_(带 flank:开 _ 前须非词字符;闭 _ 后须非词字符 → snake_case_var 不被斜体)
    if (ch === '_') {
      const prevIsWord = i > 0 && /\w/.test(text[i - 1]);
      if (!prevIsWord) {
        let j = i + 1;
        while (j < n) {
          if (text[j] === '_') {
            const next = j + 1 < n ? text[j + 1] : ' ';
            if (!/\w/.test(next)) break;
          }
          j++;
        }
        if (j < n && j > i + 1) {
          flush();
          for (const s of renderInline(text.slice(i + 1, j))) {
            segs.push({ sgr: ITALIC + s.sgr, text: s.text });
          }
          i = j + 1;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return segs;
}

/** 给每个 seg 的 sgr 前加 prefix(嵌套叠加,如标题 bold+color 套到内联 token 上)。 */
function withPrefix(segs: Seg[], prefix: string): Seg[] {
  return segs.map((s) => ({ sgr: prefix + s.sgr, text: s.text }));
}

/**
 * Seg[] → 自洽 ANSI 串(每个 seg 前 reset+开 sgr,行末 reset):样式不跨 seg 泄漏,
 * 交给 wrapAnsiString 折行时由 activeSgr 跨断行重开。
 */
function segsToAnsi(segs: Seg[]): string {
  let out = '';
  for (const s of segs) out += RESET + s.sgr + s.text;
  return out + RESET;
}

// ── ANSI 感知软折行(支持嵌入 SGR + \n 硬断行 + 跨断行 SGR 续带)──

/**
 * 把含 SGR / \n 的串按可见宽度软折成多行(每行可见宽 ≤ width)。等价 wrap-ansi 语义,零新依赖。
 * - SGR 码 `\x1b[…m` 0 宽原样保留;`\x1b[0m`(reset)清 activeSgr,其余 SGR 累加到 activeSgr。
 * - \n 为硬断行:flush 当前行(末尾补 reset),保留 activeSgr → 下一行重开同款样式
 *   (cli-highlight 多行串/块注释跨行着色不丢)。
 * - 软折行断点:可见字符累加超 width → 当前行补 reset 收尾、新行首重发 activeSgr + 该字符。
 * - 宽字符(CJK=2)在剩余放不下时整字折下行(同 wrapByDisplayWidth);零宽符(组合符)不计宽度。
 * - 每行末尾补 reset(各自直出不串色);空行(源 \n\n 间)返 ''。
 */
function wrapAnsiString(str: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  let activeSgr = '';
  const tokens = str.split(/(\x1b\[[0-9;]*m|\n)/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i % 2 === 1) {
      if (tok === '\n') {
        lines.push(cur === '' ? '' : cur + RESET);
        cur = '';
        curW = 0;
        continue;
      }
      cur += tok;
      if (tok === RESET) activeSgr = '';
      else activeSgr += tok;
      continue;
    }
    for (let gi = 0; gi < tok.length; ) {
      const g = graphemeAt(tok, gi);
      const ch = tok.slice(gi, g.end);
      gi = g.end;
      const cw = g.width;
      if (cw <= 0) {
        cur += ch;
        continue;
      }
      if (curW + cw > w) {
        lines.push(cur + RESET);
        cur = activeSgr + ch;
        curW = cw;
      } else {
        cur += ch;
        curW += cw;
      }
    }
  }
  if (cur !== '' || lines.length === 0) {
    lines.push(cur === '' ? '' : cur.endsWith(RESET) ? cur : cur + RESET);
  }
  return lines;
}

/** 折行后每行套前缀(首行 prefix、续行 contPrefix 对齐),再 clipAnsiLine 兜底 ≤ cols。 */
function wrapWithPrefix(segs: Seg[], prefix: string, contPrefix: string, cols: number): string[] {
  const w = Math.max(1, cols - ansiDisplayWidth(prefix));
  const wrapped = wrapAnsiString(segsToAnsi(segs), w);
  return wrapped.map((l, idx) => clipAnsiLine((idx === 0 ? prefix : contPrefix) + l, cols));
}

// ── 代码块语法高亮 ──

/** 整块高亮(cli-highlight 支持多行构造);未知 lang / 抛错 → 回退原文。 */
function highlightCodeBlock(code: string, lang: string): string {
  if (!lang) return code;
  try {
    const { highlight, supportsLanguage } = getCliHighlight();
    if (supportsLanguage(lang)) {
      return highlight(code, { language: lang, ignoreIllegals: true });
    }
  } catch {
    // 未知 lang 或高亮异常:回退原文(渲染层再加 gutter)
  }
  return code;
}

// ── GFM 表格 ──
// 表头行 + |---| 分隔行 + 数据行。列宽按渲染后可见宽度算(含内联样式),超 cols 时
// 等分列宽上限、cell 软折成多行(行数取各列最大)。流式:每 chunk 重渲染整段(memo),
// 表格按当前已收完整行重画;表头来了分隔没来时表头行暂走段落,分隔行到后整段重算变表格。

type Align = 'left' | 'right' | 'center';

/** 拆表格行成单元格:去首尾 | 后按 | split,每 cell trim。 */
function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  // 末尾 | 只有在未被转义时才是边框(`a \|` 结尾的 \| 是单元格内容)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // 按「未转义、且不在行内代码里」的 | 切分;\| 还原成 |(GFM 规则:转义管道符在代码里也生效)
  const cells: string[] = [];
  let cur = '';
  let ticks = 0; // 当前打开的行内代码反引号数(0 = 不在代码里)
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (s[k + run] === '`') run++;
      if (ticks === 0) ticks = run;
      else if (ticks === run) ticks = 0;
      cur += '`'.repeat(run);
      k += run - 1;
      continue;
    }
    if (ch === '|' && ticks === 0) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 分隔行每 cell :?-+:? → 对齐(left 默认)。 */
function parseAlign(sep: string[]): Align[] {
  return sep.map((c) => {
    const t = c.trim();
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    return l && r ? 'center' : r ? 'right' : 'left';
  });
}

/**
 * 宽容匹配 GFM 表格:src[i] 为表头、src[i+1] 为分隔行。
 * 分隔行本身带 |、每格只含 `-` 与 `:`、至少一格含 `-` 即可(模型常写出列数与表头不一致的分隔行、
 * 漏写竖线的粘连格 `--:----:`、单列表格);列数以表头为准,缺的列按左对齐。
 * 不带 | 的 `---`(hr / setext)与 `~ | ==` 等非法写法返回 null,仍走普通文本。
 * 数据行读到空行或不含 | 的行为止。next 为表格后第一行的下标。
 */
function matchTable(
  src: string[],
  i: number,
): { header: string[]; aligns: Align[]; rows: string[][]; next: number } | null {
  if (i + 1 >= src.length || !src[i].includes('|') || !src[i + 1].includes('|')) return null;
  const header = parseTableRow(src[i]);
  const sepCells = parseTableRow(src[i + 1]);
  if (header.length < 1) return null;
  if (!sepCells.some((c) => c.includes('-')) || !sepCells.every((c) => /^[:-]+$/.test(c))) return null;
  const rows: string[][] = [];
  let j = i + 2;
  while (j < src.length) {
    const r = src[j];
    if (r.trim() === '' || !r.includes('|')) break;
    rows.push(parseTableRow(r));
    j++;
  }
  return { header, aligns: parseAlign(sepCells), rows, next: j };
}

/** ANSI 感知按可见宽度 pad(左/右/中),补空格;不截断(超宽原样返回,由 clipAnsiLine 兜底)。 */
function padAnsi(str: string, width: number, align: Align): string {
  const w = ansiDisplayWidth(str);
  if (w >= width) return str;
  const lack = width - w;
  if (align === 'right') return ' '.repeat(lack) + str;
  if (align === 'center') {
    const l = Math.floor(lack / 2);
    return ' '.repeat(l) + str + ' '.repeat(lack - l);
  }
  return str + ' '.repeat(lack);
}

/** 渲染 cell 为 ANSI 串:表头套 dim+bold,数据行裸(内联 markdown 照常)。 */
function renderCell(text: string, isHeader: boolean): string {
  const segs = isHeader ? withPrefix(renderInline(text), ui.dim + ui.bold) : renderInline(text);
  return segsToAnsi(segs);
}

/**
 * GFM 表格 → ANSI 物理行(│ 边框 + 表头下 ├─┼─┤ 分隔;每行 ≤ cols,clipAnsiLine 兜底)。
 * 自然总宽 ≤ cols:单行模式,各列按自然宽。超 cols:每列等分上限 colMax,cell 软折多行,
 * 行数取各列最大,缺 cell 行补空。对齐按分隔行(: 左 / : 右 / : : 中)。
 */
function renderTable(header: string[], aligns: Align[], rows: string[][], cols: number): string[] {
  const n = header.length;
  const align: Align[] = header.map((_, i) => aligns[i] ?? 'left');
  const hCells = header.map((c) => renderCell(c, true));
  const dCells = rows.map((r) => header.map((_, i) => renderCell(r[i] ?? '', false)));
  const natW = header.map((_, i) => {
    let w = ansiDisplayWidth(hCells[i]);
    for (const r of dCells) w = Math.max(w, ansiDisplayWidth(r[i]));
    return w;
  });
  const borders = n + 1; // │ 数
  const padding = 2 * n; // 每 cell 前后 1 空格
  const totalNat = natW.reduce((a, b) => a + b, 0) + borders + padding;
  const out: string[] = [];

  const rowLine = (cells: string[], widths: number[]): string =>
    clipAnsiLine(
      `${ui.dim}│${ui.reset}${cells
        .map((c, i) => ' ' + padAnsi(c, widths[i], align[i]) + ' ')
        .join(`${ui.dim}│${ui.reset}`)}${ui.dim}│${ui.reset}`,
      cols,
    );
  // 田字格横线:顶 ┌─┬─┐ / 行间(含表头下) ├─┼─┤ / 底 └─┴─┘ —— 每 cell 四周皆边框
  const topLine = (widths: number[]): string =>
    clipAnsiLine(`${ui.dim}┌${widths.map((w) => '─'.repeat(w + 2)).join('┬')}┐${ui.reset}`, cols);
  const midLine = (widths: number[]): string =>
    clipAnsiLine(`${ui.dim}├${widths.map((w) => '─'.repeat(w + 2)).join('┼')}┤${ui.reset}`, cols);
  const botLine = (widths: number[]): string =>
    clipAnsiLine(`${ui.dim}└${widths.map((w) => '─'.repeat(w + 2)).join('┴')}┘${ui.reset}`, cols);

  // cell block:wrap=true 按各列宽软折多行(行数取最大,缺补空);false 直接 pad 单行
  const emitBlock = (cells: string[], widths: number[], wrap: boolean) => {
    const wrapped = wrap ? cells.map((c, i) => wrapAnsiString(c, widths[i])) : cells.map((c) => [c]);
    const lines = Math.max(1, ...wrapped.map((w) => w.length));
    for (let k = 0; k < lines; k++) {
      out.push(
        rowLine(
          wrapped.map((w) => w[k] ?? ''),
          widths,
        ),
      );
    }
  };

  // 顶 → 表头 → (行间 + 数据行)* → 底;无数据行时 top+header+bot
  if (totalNat <= cols) {
    out.push(topLine(natW));
    emitBlock(hCells, natW, false);
    for (const r of dCells) {
      out.push(midLine(natW));
      emitBlock(r, natW, false);
    }
    out.push(botLine(natW));
  } else {
    const colMax = Math.max(1, Math.floor((cols - borders - padding) / n));
    const widths = new Array(n).fill(colMax);
    out.push(topLine(widths));
    emitBlock(hCells, widths, true);
    for (const r of dCells) {
      out.push(midLine(widths));
      emitBlock(r, widths, true);
    }
    out.push(botLine(widths));
  }
  return out;
}

// ── 主渲染 ──

const MEMO = new Map<
  string,
  { cols: number; lines: string[]; codeBlocks: RenderedCodeBlock[]; themeVersion: number }
>();
const MEMO_CAP = 16;

function renderMarkdownImpl(text: string, cols: number): { lines: string[]; codeBlocks: RenderedCodeBlock[] } {
  const out: string[] = [];
  const codeBlocks: RenderedCodeBlock[] = [];
  const src = text.split(/\r?\n/); // 兼容 CRLF:否则行尾 \r 让 fence 正则失配、整块不识别
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0; // 开栏围栏长度:闭合栏须 ≥ 此长度(CommonMark),4 反引号外层可安全包住 3 反引号示例
  let fenceDepth = 0; // 同长度带语言标注的嵌套开栏深度(3 反引号外层包 ```ts 示例的常见写法)
  let fenceIndent = 0; // 开栏缩进(列表项内的围栏):复制原文时按 CommonMark 剥掉这层缩进
  let lang = '';
  let codeBuf: string[] = [];
  let para: string[] = [];
  let prevBlank = false;

  const flushPara = () => {
    if (!para.length) return;
    const segs = renderInline(para.join(' '));
    const wrapped = wrapAnsiString(segsToAnsi(segs), cols);
    for (const l of wrapped) out.push(clipAnsiLine(l, cols));
    out.push('');
    para = [];
    prevBlank = true;
  };

  // 代码块整块铺 codeBg 底色(header + 代码行补满到 cols),与正文区分出「可复制区」。
  // 非 TTY(codeBg 为空串)退化为无底色、不补尾随空格。文本内的 reset 之后重开底色,防高亮 SGR 打断。
  const paintCodeRow = (text: string): string => {
    const bg = ui.codeBg;
    const body = clipAnsiLine(text, cols);
    if (!bg) return body;
    const pad = Math.max(0, cols - ansiDisplayWidth(body));
    return `${bg}${body.split(RESET).join(RESET + bg)}${' '.repeat(pad)}${RESET}`;
  };

  // header 行:左侧 dim 语言标签(始终保留这行以承载按钮),右端 accent 复制图标 ` ❐ `(两侧各留 1 格扩大点击面)。
  // 窄窗放不下按钮时只画标签,buttonCol=-1 表示不可点。
  const COPY_BTN = ' \u2750 ';
  const buildHeader = (language: string): { line: string; colStart: number; colEnd: number } => {
    const btnW = displayWidth(COPY_BTN);
    const left = language ? `  ${ui.dim}${language}${ui.reset}` : '  ';
    const leftW = 2 + displayWidth(language); // '  ' gutter + 语言名
    const spaces = cols - leftW - btnW;
    if (spaces < 0) return { line: paintCodeRow(left), colStart: -1, colEnd: -1 };
    const colStart = leftW + spaces;
    return {
      line: paintCodeRow(`${left}${' '.repeat(spaces)}${ui.accent}${COPY_BTN}${ui.reset}`),
      colStart,
      colEnd: colStart + btnW,
    };
  };

  const flushCode = () => {
    const strip = fenceIndent > 0 ? new RegExp(`^[ \\t]{0,${fenceIndent}}`) : null;
    const code = (strip ? codeBuf.map((l) => l.replace(strip, '')) : codeBuf).join('\n');
    const headerLine = out.length;
    const header = buildHeader(lang);
    out.push(header.line);
    const codeStartLine = out.length;
    const highlighted = highlightCodeBlock(code, lang);
    const codeW = Math.max(1, cols - 2);
    for (const l of wrapAnsiString(highlighted, codeW)) {
      out.push(paintCodeRow(`  ${l}`));
    }
    const codeEndLine = out.length - 1;
    codeBlocks.push({
      headerLine,
      codeStartLine,
      codeEndLine,
      buttonColStart: header.colStart,
      buttonColEnd: header.colEnd,
      lang,
      code,
    });
    out.push('');
    inFence = false;
    fenceChar = '';
    fenceLen = 0;
    fenceDepth = 0;
    fenceIndent = 0;
    lang = '';
    codeBuf = [];
    prevBlank = true;
  };

  while (i < src.length) {
    const line = src[i];
    // 容错关闭 fence：部分模型偶尔把 ``` 的闭合标记少输出一个字符，变成独占一行的 ``。
    // 若不恢复，后续所有标题、列表和下一段代码都会被吞进首个代码块，最终显示成截图里的原始
    // `##` / ```。只接受“独占一行、恰好两个同类字符”，避免误伤代码中的行内双反引号。
    const shortClose = inFence ? line.match(/^\s*(`{2}|~{2})\s*$/) : null;
    if (shortClose && shortClose[1][0] === fenceChar && fenceDepth === 0) {
      flushCode();
      i++;
      continue;
    }
    // fence 探测(``` 或 ~~~,≥3)
    const fm = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fm) {
      if (!inFence) {
        flushPara();
        inFence = true;
        fenceChar = fm[2][0];
        fenceLen = fm[2].length;
        fenceDepth = 0;
        fenceIndent = fm[1].length;
        lang = fm[3].trim();
        codeBuf = [];
      } else if (fm[2][0] === fenceChar && fm[2].length >= fenceLen) {
        if (fm[3].trim()) {
          // 带语言标注的同类围栏不是闭合栏(CommonMark),按嵌套开栏计深度,其配对的裸栏不会提前截断外层块。
          fenceDepth++;
          codeBuf.push(line);
        } else if (fenceDepth > 0) {
          fenceDepth--;
          codeBuf.push(line);
        } else {
          flushCode();
        }
      } else {
        codeBuf.push(line);
      }
      i++;
      continue;
    }
    if (inFence) {
      codeBuf.push(line);
      i++;
      continue;
    }
    // 空行(折叠连续空行)
    if (line.trim() === '') {
      flushPara();
      if (!prevBlank) out.push('');
      prevBlank = true;
      i++;
      continue;
    }
    // 水平分隔线:--- / *** / ___ / - - -
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push(`${ui.dim}${'─'.repeat(cols)}${ui.reset}`);
      out.push('');
      prevBlank = true;
      i++;
      continue;
    }
    // 标题 #(1-6)
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flushPara();
      const level = hm[1].length;
      const color = level <= 1 ? ui.brightCyan : level === 2 ? ui.cyan : ui.gray;
      const segs = withPrefix(renderInline(hm[2]), ui.bold + color);
      for (const l of wrapAnsiString(segsToAnsi(segs), cols)) {
        out.push(clipAnsiLine(l, cols));
      }
      out.push('');
      prevBlank = true;
      i++;
      continue;
    }
    // 引用块 >
    const bm = line.match(/^>\s?(.*)$/);
    if (bm) {
      flushPara();
      const prefix = `  ${ui.dim}│${ui.reset} `;
      const cont = ' '.repeat(ansiDisplayWidth(prefix));
      // 收齐连续的引用行,去掉 > 前缀后再识别表格(否则引用块里的表格会逐行显示成竖线原文)
      const inner: string[] = [];
      let j = i;
      while (j < src.length) {
        const m = src[j].match(/^>\s?(.*)$/);
        if (!m) break;
        inner.push(m[1]);
        j++;
      }
      let k = 0;
      while (k < inner.length) {
        const t = matchTable(inner, k);
        if (t) {
          const tw = Math.max(1, cols - ansiDisplayWidth(prefix));
          for (const l of renderTable(t.header, t.aligns, t.rows, tw)) out.push(clipAnsiLine(prefix + l, cols));
          k = t.next;
          continue;
        }
        for (const l of wrapWithPrefix(renderInline(inner[k]), prefix, cont, cols)) {
          out.push(l);
        }
        k++;
      }
      prevBlank = false;
      i = j;
      continue;
    }
    // 无序列表 - * +
    const um = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (um) {
      flushPara();
      const indent = displayWidth(um[1]);
      const bullet = indent >= 2 ? '◦' : '•';
      const marker = `${' '.repeat(indent)}${bullet} `;
      const cont = ' '.repeat(displayWidth(marker));
      for (const l of wrapWithPrefix(renderInline(um[3]), marker, cont, cols)) {
        out.push(l);
      }
      prevBlank = false;
      i++;
      continue;
    }
    // 有序列表 1.
    const om = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (om) {
      flushPara();
      const indent = displayWidth(om[1]);
      const marker = `${' '.repeat(indent)}${om[2]}. `;
      const cont = ' '.repeat(displayWidth(marker));
      for (const l of wrapWithPrefix(renderInline(om[3]), marker, cont, cols)) {
        out.push(l);
      }
      prevBlank = false;
      i++;
      continue;
    }
    // GFM 表格:表头 + 紧跟分隔行 → 收齐整块渲染(宽容匹配规则见 matchTable / renderTable)
    const tbl = matchTable(src, i);
    if (tbl) {
      flushPara();
      for (const l of renderTable(tbl.header, tbl.aligns, tbl.rows, cols)) out.push(l);
      out.push('');
      prevBlank = true;
      i = tbl.next;
      continue;
    }
    // 没有合法分隔行的竖线行(模型漏写分隔行 / 写法非法):保持逐行显示,
    // 不能并进段落——段落会把多行 join 成一行,竖线文字糊成一团。
    if (/^\s*\|/.test(line)) {
      flushPara();
      while (i < src.length && /^\s*\|/.test(src[i]) && !(i > 0 && matchTable(src, i))) {
        const segs = renderInline(src[i].trim());
        for (const l of wrapAnsiString(segsToAnsi(segs), cols)) out.push(clipAnsiLine(l, cols));
        i++;
      }
      out.push('');
      prevBlank = true;
      continue;
    }
    // 段落:累积(连续非空非特殊行 join ' ' 后渲染)
    para.push(line);
    prevBlank = false;
    i++;
  }
  flushPara();
  if (inFence) flushCode(); // EOF 仍 inFence:流式中未闭合 fence → 照常 emit 进行中代码块
  // 独立 markdown 段的外部间距由 agent/batch 边界统一管理。流式后端可能把
  // "\n\n" 与首段正文拆成不同 chunk；仅清洗首个正文 chunk 不够，因为 mdBuf
  // 累积重渲染时这些换行仍会变成段首空行。这里最终兜底，正文段永不自带前导空行。
  const isVisualBlank = (line: string): boolean => stripAnsi(line).trim().length === 0;
  let headShift = 0;
  while (out.length > 0 && isVisualBlank(out[0])) {
    out.shift();
    headShift++;
  }
  // 末尾不留空行:agent onText 后接 onToolCall 的 contentWrite('\n') 会补 1 空行分隔正文与 ● 行;
  // 若 md 末尾自带空行(段落/代码块后)则叠成 2 空行。裁掉末尾连续空行,让 onToolCall / 轮末
  // contentWrite('\n') 恰好补 1 行(与改造前 raw 文本行为一致)。块间空行(flushPara/flushCode 中段
  // push 的)不受影响——只裁末尾。
  while (out.length > 0 && isVisualBlank(out[out.length - 1])) out.pop();
  // 前导空行被 shift:同步平移仍在输出区内的代码块相对行(被整体裁掉的块丢弃)。
  const blocks = headShift
    ? codeBlocks
        .map((b) => ({
          ...b,
          headerLine: b.headerLine - headShift,
          codeStartLine: b.codeStartLine - headShift,
          codeEndLine: b.codeEndLine - headShift,
        }))
        .filter((b) => b.codeEndLine >= 0)
    : codeBlocks;
  return { lines: out, codeBlocks: blocks };
}

/**
 * 把 markdown 文本渲染成 ANSI 物理行数组(每行 ansiDisplayWidth ≤ cols,自洽带色)。
 * 纯函数 + LRU memo(key=text,值 {cols, lines, themeVersion}):同一 text 同一 cols 同一主题版本直接
 * 命中(MRU 提升),cols 变(resize)或切主题(themeVersion 变)则重算覆写。供 layout.contentWriteMd
 * 每 chunk 调用(memo 使重复渲染命中缓存)。themeVersion 使 setTheme 后全量重绘不命中旧主题缓存行。
 */
export function renderMarkdownWithMeta(
  text: string,
  cols: number,
): {
  lines: string[];
  codeBlocks: RenderedCodeBlock[];
} {
  const hit = MEMO.get(text);
  if (hit && hit.cols === cols && hit.themeVersion === getThemeVersion()) {
    MEMO.delete(text);
    MEMO.set(text, hit); // MRU 提升
    return { lines: hit.lines, codeBlocks: hit.codeBlocks };
  }
  const { lines, codeBlocks } = renderMarkdownImpl(text, cols);
  if (MEMO.has(text)) MEMO.delete(text);
  else if (MEMO.size >= MEMO_CAP) MEMO.delete(MEMO.keys().next().value as string);
  MEMO.set(text, { cols, lines, codeBlocks, themeVersion: getThemeVersion() });
  return { lines, codeBlocks };
}

/** 只取物理行(向后兼容 reflow / 测试);代码块定位信息见 renderMarkdownWithMeta。 */
export function renderMarkdown(text: string, cols: number): string[] {
  return renderMarkdownWithMeta(text, cols).lines;
}

// 供 check 脚本 / 单元验证用(不进 layout 运行时路径)。
export const __test = { clipAnsiLine, renderInline, wrapAnsiString, segsToAnsi };
