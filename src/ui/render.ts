import { stdout } from 'node:process';
import { createRequire } from 'node:module';
import { ui } from './theme.js';

const VERSION = createRequire(import.meta.url)('../../package.json').version as string;

/**
 * 清空整屏 + 滚动缓冲(向上滚动可见的历史输出),光标归位。
 * 进入会话时调用,让终端只剩当前 agent 对话。非 TTY 时空操作。
 */
export function clearScreen(): void {
  if (!ui.isTTY) return;
  // [2J 清整屏 · [3J 清滚动缓冲 · [H 光标回到左上
  stdout.write('\x1B[2J\x1B[3J\x1B[H');
}

// ── 显示宽度:CJK / 全角算 2,控制符 / 组合符算 0;用于横幅边框对齐 ──

export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // 控制符
  if (cp >= 0x300 && cp <= 0x36f) return 0; // 组合附加符号
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp >= 0x200b && cp <= 0x200f) return 0; // 零宽 / ZWJ
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // 变体选择符
  if (cp >= 0x1100 && cp <= 0x115f) return 2;
  if (cp >= 0x2e80 && cp <= 0x303e) return 2;
  if (cp >= 0x3041 && cp <= 0x33ff) return 2;
  if (cp >= 0x3400 && cp <= 0x4dbf) return 2;
  if (cp >= 0x4e00 && cp <= 0xa4cf) return 2; // CJK 统一表意
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // 韩文音节
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // 全角
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2; // 表情
  if (cp >= 0x20000 && cp <= 0x2fffd) return 2; // CJK 扩展 B-F
  return 1;
}

export function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * 毫秒 → Claude Code 式耗时串:运行中状态行走时与轮次结束摘要行共用。
 * <10s 显 1 位小数(3.2s);10-59s 整数(12s);≥60s m+s(3m 3s);≥1h h+m(1h 2m)。
 */
export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** 去除 SGR 颜色转义(\x1B[…m),用于度量带色串的真实可见宽度。 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 按显示列范围 [start, end) 截取纯文本(不含 ANSI,按 charWidth 计位,CJK/宽字符占 2)。
 *  跨宽字符边界时整字符归入(w+cw>start 即含入),供鼠标选区文本提取用。 */
export function sliceByDisplayCol(str: string, start: number, end: number): string {
  if (start >= end) return '';
  let w = 0;
  let out = '';
  for (const ch of str) {
    if (w >= end) break;
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > start) out += ch;
    w += cw;
  }
  return out;
}

/** 把可视列(0-based)反推为 str 内的字符偏移(JS 字符串下标,UTF-16 code unit)。
 *  点击落在宽字符的"列中段"时归到该字符之前的偏移(停在它左侧边界)——与终端光标行为一致。
 *  visCol 大于串的显示宽度时返回 str.length(点行末的"右边")。
 *  输入框点击定位专用;与 sliceByDisplayCol 互为逆,但语义只关心单点、不关心区间。 */
export function visColToCharCol(str: string, visCol: number): number {
  if (visCol <= 0) return 0;
  let w = 0;
  let i = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw <= 0) { i += ch.length; continue; } // 零宽(组合符):不占列
    if (w + cw > visCol) break; // 落在该字符显示区间内 → 停在其左侧
    w += cw;
    i += ch.length;
  }
  return i;
}

/** 带色串的可见显示宽度(先去 ANSI 再按 displayWidth 度量)。 */
export function ansiDisplayWidth(s: string): number {
  return displayWidth(stripAnsi(s));
}

/** 按显示宽度右补空格。 */
export function padEndDisplay(str: string, width: number): string {
  const w = displayWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}

/** 带色串按可见宽度右补空格(先剥离 ANSI 算真实宽度,空格补在串末,不破坏颜色码)。 */
export function padEndAnsi(str: string, width: number): string {
  const w = ansiDisplayWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}

/** 带色串按可见宽度截断(保留中间 ANSI 码,超出末尾加 …,补 reset 防 … 继承颜色)。 */
export function truncateAnsi(str: string, width: number): string {
  if (ansiDisplayWidth(str) <= width) return str;
  let w = 0;
  let out = '';
  let hasStyle = false;
  // 按 ANSI 转义切分:偶数索引=文本,奇数索引=SGR 码
  const parts = str.split(/(\x1b\[[0-9;]*m)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i];
      hasStyle = parts[i] !== '\x1b[0m';
      continue;
    }
    for (const ch of parts[i]) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
      if (cw > 0 && w + cw + 1 > width) {
        if (hasStyle) out += '\x1b[0m';
        return out + '…';
      }
      if (cw > 0) w += cw;
      out += ch;
    }
  }
  return out;
}

/** 按显示宽度截断,超出加 …。 */
export function truncateDisplay(str: string, width: number): string {
  if (displayWidth(str) <= width) return str;
  let w = 0;
  let out = '';
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw + 1 > width) break; // +1 留给末尾的 …
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * 按显示宽度从头部截断(保留尾部),超出前缀加 …。
 * 用于单行只读预览需要始终看到最新内容的场景(如运行态输入回显:光标恒在文本末尾,
 * 超长时应保留刚打的字,而非 truncateDisplay 那样保留开头、把刚打的内容截没)。
 */
export function truncateDisplayHead(str: string, width: number): string {
  if (displayWidth(str) <= width) return str;
  const chars = Array.from(str);
  let w = 0;
  const kept: string[] = [];
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i].codePointAt(0) ?? 0);
    if (w + cw + 1 > width) break; // +1 留给前导的 …
    kept.unshift(chars[i]);
    w += cw;
  }
  return '…' + kept.join('');
}

/**
 * 按显示宽度把文本软折行为多行(供输入框软换行):每行可见宽度 ≤ width。
 * 宽字符(CJK / emoji = 2)在剩余宽度放不下时整字折到下行(留尾部空格,与终端自动折行一致),
 * 而非劈开半个字。零宽字符(组合符等)不计宽度、附在当前行。空串返回 [''](占一行)。
 * 输入文本应全为可见字符(无控制码 / SGR)。
 */
export function wrapByDisplayWidth(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw <= 0) {
      cur += ch; // 零宽:不计宽度
      continue;
    }
    if (curW + cw > w) {
      out.push(cur);
      cur = ch;
      curW = cw;
    } else {
      cur += ch;
      curW += cw;
    }
  }
  out.push(cur);
  return out;
}

// ── 启动横幅 ──

export interface BannerInfo {
  model: string;
  baseURL: string;
  cwd: string;
  tools: string;
}

const BOX_W = 60; // 内容区显示宽度(logo 区 + 信息区)
const MARGIN = '  '; // 盒外左缩进

// ── MoCode 块字符 logo(3 行 x 30 字符,neofetch 风)──
const LOGO_W = 30; // logo 区显示宽度 = art 真宽,无补宽(让 LOGO_GAP 精确生效)
const LOGO_GAP = 2; // logo 与信息区之间的间隔

// ASCII 字符画 6 字母(M/o/C/o/d/e)压缩一半高度:每对原 ASCII 行用 ▀▄█ 块字符合并
// 偶行 `█` 进奇行同一列 → █(满块)/▀(上块)/▄(下块);无前导缩进,让 logo 紧贴 MARGIN 左缘
const LOGO_LINES = [
  '▄▄▄▄▄ ▄▄▄▄ ▄▄▄▄ ▄▄▄▄    ▄ ▄▄▄▄',
  '█ █ █ █  █ █    █  █ █▀▀█ █▀▀▀',
  '▀ ▀ ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
];

/** 取第 idx 行 logo(着色 + 补宽 + LOGO_GAP 间隔),与 info 行直接拼接(neofetch 风)。 */
function logoLine(idx: number): string {
  return `${ui.accent}${padEndDisplay(LOGO_LINES[idx], LOGO_W)}${ui.reset}${' '.repeat(LOGO_GAP)}`;
}

function labelContent(label: string, value: string): string {
  return `${ui.dim}${padEndDisplay(label, 6)}${ui.reset}${value}`;
}

/** 横幅纯文本(带 ANSI 颜色,不写出)——供 TUI 经 contentWrite 写入内容区以跟踪续写位。
 *  布局:大字 logo(3 行,块字符)左对齐,右侧并排放标题/信息(neofetch 风),末尾空行 + 提示。 */
export function bannerString(info: BannerInfo): string {
  const title = `${ui.bold}${ui.accent}◆  MoCode${ui.reset}  ${ui.dim}v${VERSION}${ui.reset}`;
  const rows = [
    logoLine(0) + title,
    logoLine(1) + labelContent('模型', info.model),
    logoLine(2) + labelContent('目录', truncateDisplay(info.cwd, 48)),
  ];
  return (
    rows.map((r) => MARGIN + r).join('\n') +
    '\n\n' +
    `${MARGIN}${ui.dim}直接描述任务,agent 会自动读写文件与执行命令。${ui.reset}\n`
  );
}

/** 启动横幅:大字 logo + 标题/信息 + 一行提示。纯渲染,不依赖 config / 业务。 */
export function printBanner(info: BannerInfo): void {
  stdout.write(bannerString(info));
}

// ── 工具调用 / 结果 摘要 ──

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 把工具调用的 JSON 参数提炼成人可读的一行(路径 / 模式 / 命令)。 */
export function summarizeToolCall(name: string, argsRaw: string): string {
  const args = tryParse(argsRaw);
  if (!args) return truncateDisplay(argsRaw, 80);
  const s = (k: string): string =>
    typeof args[k] === 'string' ? (args[k] as string) : '';
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return s('path') || truncateDisplay(argsRaw, 80);
    case 'run_command':
      return truncateDisplay(s('command') || argsRaw, 100);
    case 'glob':
      return s('pattern') || argsRaw;
    case 'grep': {
      const p = s('pattern');
      const path = s('path');
      return path ? `${p}  ·  ${path}` : p || argsRaw;
    }
    default:
      return truncateDisplay(argsRaw, 80);
  }
}

/** 工具结果的人可读一行预览(行数 / 匹配数 / 首行);喂回 LLM 的全文不变。 */
export function summarizeToolResult(name: string, output: string): string {
  const nonEmpty = output.split('\n').filter((l) => l.trim().length > 0);
  switch (name) {
    case 'read_file':
      return nonEmpty.length ? `${nonEmpty.length} 行` : '(空文件)';
    case 'glob':
      return nonEmpty.length ? `${nonEmpty.length} 个文件` : '(无匹配)';
    case 'grep':
      return nonEmpty.length ? `${nonEmpty.length} 处匹配` : '(无匹配)';
    case 'run_command':
      return truncateDisplay(nonEmpty[0] ?? '', 100) || '(无输出)';
    default:
      return truncateDisplay(nonEmpty[0] ?? '', 100);
  }
}
