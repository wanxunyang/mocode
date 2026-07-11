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
import { highlight, supportsLanguage } from 'cli-highlight';
import { ui, getThemeVersion } from './theme.js';
import { charWidth, displayWidth, ansiDisplayWidth, stripAnsi } from './render.js';

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
    for (const ch of parts[i]) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
      if (cw > 0 && w + cw > width) {
        return out + RESET;
      }
      if (cw > 0) w += cw;
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
    for (const ch of tok) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
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
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
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
      cols
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
      out.push(rowLine(wrapped.map((w) => w[k] ?? ''), widths));
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

const MEMO = new Map<string, { cols: number; lines: string[]; themeVersion: number }>();
const MEMO_CAP = 16;

function renderMarkdownImpl(text: string, cols: number): string[] {
  const out: string[] = [];
  const src = text.split('\n');
  let i = 0;
  let inFence = false;
  let fenceChar = '';
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

  const flushCode = () => {
    if (lang) out.push(`  ${ui.dim}${lang}${ui.reset}`);
    const highlighted = highlightCodeBlock(codeBuf.join('\n'), lang);
    const codeW = Math.max(1, cols - 2);
    for (const l of wrapAnsiString(highlighted, codeW)) {
      out.push(clipAnsiLine(`  ${l}`, cols));
    }
    out.push('');
    inFence = false;
    fenceChar = '';
    lang = '';
    codeBuf = [];
    prevBlank = true;
  };

  while (i < src.length) {
    const line = src[i];
    // fence 探测(``` 或 ~~~,≥3)
    const fm = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fm) {
      if (!inFence) {
        flushPara();
        inFence = true;
        fenceChar = fm[2][0];
        lang = fm[3].trim();
        codeBuf = [];
      } else if (fm[2][0] === fenceChar) {
        flushCode();
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
      for (const l of wrapWithPrefix(renderInline(bm[1]), prefix, cont, cols)) {
        out.push(l);
      }
      prevBlank = false;
      i++;
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
    // GFM 表格:表头(含 |,≥2 cell)+ 紧跟 |---| 分隔行 → 收齐整块渲染(详见 renderTable)
    if (line.includes('|')) {
      const headerCells = parseTableRow(line);
      if (headerCells.length >= 2 && i + 1 < src.length) {
        const sepCells = parseTableRow(src[i + 1]);
        if (
          sepCells.length === headerCells.length &&
          sepCells.every((c) => /^:?-+:?$/.test(c.trim()))
        ) {
          flushPara();
          const aligns = parseAlign(sepCells);
          i += 2;
          const trows: string[][] = [];
          while (i < src.length) {
            const r = src[i];
            if (r.trim() === '' || !r.includes('|')) break;
            trows.push(parseTableRow(r));
            i++;
          }
          for (const l of renderTable(headerCells, aligns, trows, cols)) out.push(l);
          out.push('');
          prevBlank = true;
          continue;
        }
      }
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
  while (out.length > 0 && isVisualBlank(out[0])) out.shift();
  // 末尾不留空行:agent onText 后接 onToolCall 的 contentWrite('\n') 会补 1 空行分隔正文与 ● 行;
  // 若 md 末尾自带空行(段落/代码块后)则叠成 2 空行。裁掉末尾连续空行,让 onToolCall / 轮末
  // contentWrite('\n') 恰好补 1 行(与改造前 raw 文本行为一致)。块间空行(flushPara/flushCode 中段
  // push 的)不受影响——只裁末尾。
  while (out.length > 0 && isVisualBlank(out[out.length - 1])) out.pop();
  return out;
}

/**
 * 把 markdown 文本渲染成 ANSI 物理行数组(每行 ansiDisplayWidth ≤ cols,自洽带色)。
 * 纯函数 + LRU memo(key=text,值 {cols, lines, themeVersion}):同一 text 同一 cols 同一主题版本直接
 * 命中(MRU 提升),cols 变(resize)或切主题(themeVersion 变)则重算覆写。供 layout.contentWriteMd
 * 每 chunk 调用(memo 使重复渲染命中缓存)。themeVersion 使 setTheme 后全量重绘不命中旧主题缓存行。
 */
export function renderMarkdown(text: string, cols: number): string[] {
  const hit = MEMO.get(text);
  if (hit && hit.cols === cols && hit.themeVersion === getThemeVersion()) {
    MEMO.delete(text);
    MEMO.set(text, hit); // MRU 提升
    return hit.lines;
  }
  const lines = renderMarkdownImpl(text, cols);
  if (MEMO.has(text)) MEMO.delete(text);
  else if (MEMO.size >= MEMO_CAP) MEMO.delete(MEMO.keys().next().value as string);
  MEMO.set(text, { cols, lines, themeVersion: getThemeVersion() });
  return lines;
}

// 供 check 脚本 / 单元验证用(不进 layout 运行时路径)。
export const __test = { clipAnsiLine, renderInline, wrapAnsiString, segsToAnsi };
