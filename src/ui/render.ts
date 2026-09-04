import { stdout } from 'node:process';
import { createRequire } from 'node:module';
import { ui } from './theme.js';
import { t } from '../i18n/index.js';

let VERSION = '0.0.0';
try {
  VERSION = createRequire(import.meta.url)('../../package.json').version as string;
} catch {
  // 非标准布局(测试编译产物、自定义打包)不含 package.json:版本号回落,不阻断模块加载。
}

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
 * 毫秒 → 耗时串:运行中状态行走时与轮次结束摘要行共用。
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
    if (cw <= 0) {
      i += ch.length;
      continue;
    } // 零宽(组合符):不占列
    if (w + cw > visCol) break; // 落在该字符显示区间内 → 停在其左侧
    w += cw;
    i += ch.length;
  }
  return i;
}

export interface DisplayPoint {
  line: number;
  col: number;
}

function flattenedOffset(lines: string[], point: DisplayPoint): number {
  const line = Math.max(0, Math.min(point.line, Math.max(0, lines.length - 1)));
  let offset = 0;
  for (let i = 0; i < line; i++) offset += stripAnsi(lines[i]).length;
  const plain = stripAnsi(lines[line] ?? '');
  return offset + visColToCharCol(plain, point.col);
}

function pointAtFlattenedOffset(lines: string[], offset: number, preferNextAtBoundary: boolean): DisplayPoint {
  if (lines.length === 0) return { line: 0, col: 0 };
  let remaining = Math.max(0, offset);
  for (let line = 0; line < lines.length; line++) {
    const plain = stripAnsi(lines[line]);
    if (
      remaining < plain.length ||
      (remaining === plain.length && (!preferNextAtBoundary || line === lines.length - 1))
    ) {
      return { line, col: displayWidth(plain.slice(0, remaining)) };
    }
    remaining -= plain.length;
  }
  const last = stripAnsi(lines[lines.length - 1]);
  return { line: lines.length - 1, col: displayWidth(last) };
}

/**
 * 同一段文本重新软折行后迁移一个“物理行 + 显示列”端点。
 *
 * 常规段落在去 ANSI、去物理换行后文本完全一致，直接按 UTF-16 边界精确迁移；列表、
 * 引用等可能因续行缩进导致扁平文本不同，此时退化为“非空白字符序号 + 尾随空白数”映射，
 * 使端点仍跟随同一个内容字符，而不是按物理行比例漂移。
 */
export function remapWrappedPoint(oldLines: string[], newLines: string[], point: DisplayPoint): DisplayPoint {
  if (newLines.length === 0) return { line: 0, col: 0 };
  const oldPlain = oldLines.map(stripAnsi);
  const newPlain = newLines.map(stripAnsi);
  const oldFlat = oldPlain.join('');
  const newFlat = newPlain.join('');
  const oldOffset = flattenedOffset(oldLines, point);
  const preferNext = point.line > 0 && point.col === 0;
  if (oldFlat === newFlat) {
    return pointAtFlattenedOffset(newLines, Math.min(oldOffset, newFlat.length), preferNext);
  }

  const prefix = oldFlat.slice(0, oldOffset);
  let contentChars = 0;
  let trailingWhitespace = 0;
  for (const ch of prefix) {
    if (/\s/u.test(ch)) trailingWhitespace++;
    else {
      contentChars++;
      trailingWhitespace = 0;
    }
  }

  let seen = 0;
  let mappedOffset = 0;
  while (mappedOffset < newFlat.length && seen < contentChars) {
    const cp = newFlat.codePointAt(mappedOffset) ?? 0;
    const ch = String.fromCodePoint(cp);
    mappedOffset += ch.length;
    if (!/\s/u.test(ch)) seen++;
  }
  let spaces = 0;
  while (mappedOffset < newFlat.length && spaces < trailingWhitespace) {
    const cp = newFlat.codePointAt(mappedOffset) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (!/\s/u.test(ch)) break;
    mappedOffset += ch.length;
    spaces++;
  }
  return pointAtFlattenedOffset(newLines, mappedOffset, preferNext);
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

/**
 * 用指定背景色把 ANSI 行补到目标宽度。
 *
 * 普通 padEndAnsi 会把空格追加在行末 reset 之后，视觉上仍是终端原底色；这里重新开启
 * background 再补空格，供用户消息气泡在终端放宽后动态延伸到底。原串不改写，避免破坏
 * 行内前景色或已有 reset；补段自身闭合，保证下一行不继承背景。
 */
export function padEndAnsiBackground(str: string, width: number, background: string, reset = '\x1B[0m'): string {
  const w = ansiDisplayWidth(str);
  if (w >= width) return str;
  return `${str}${background}${' '.repeat(width - w)}${reset}`;
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
  /** 记忆子系统开关:由 config.isMemoryEnabled() 喂入,关闭时 banner 显示「关闭」 */
  memoryEnabled: boolean;
}

const MARGIN = '  '; // 盒外左缩进

// ── MoCode 块字符 logo(4 行,neofetch 风)──
const LOGO_W = 35; // logo 区显示宽度
const LOGO_GAP = 0; // logo 与信息区之间的间隔
// 块字符画 4 行:M / o / C / o / d / e,块字符上半/下半合并两个 ASCII 行
const LOGO_LINES: string[] = [
  '                        ▄     ',
  '█▀█▀█ █▀▀█ ▄▄▄▄ ▄▄▄▄ ▄▄▄█ ▄▄▄▄',
  '█ █ █ █  █ █  ▀ █  █ █  █ █▄▄█',
  '▀ ▀ ▀ ▀▀▀▀ █▄▄█ █▄▄█ █▄▄█ █▄▄▄',
];

/** 取第 idx 行 logo(着色 + 补宽 + LOGO_GAP 间隔),与 info 行直接拼接(neofetch 风)。 */
function logoLine(idx: number): string {
  return `${ui.accent}${padEndDisplay(LOGO_LINES[idx], LOGO_W)}${ui.reset}${' '.repeat(LOGO_GAP)}`;
}

function labelContent(label: string, value: string, width: number): string {
  return `${ui.dim}${padEndDisplay(label, width)}${ui.reset}${value}`;
}

/** 把记忆开关转成本地化标签。 */
function memoryLabel(on: boolean): string {
  return on ? t('banner.enabled') : t('banner.disabled');
}

/** 记忆状态染色:开启用 ui.accent(亮),关闭用 ui.dim(弱),让远观有差别。
 *  banner 里整体仍走 ui.reset 兜底——染色只贴在值那一列。 */
function memoryValue(on: boolean): string {
  return on ? `${ui.accent}${memoryLabel(on)}${ui.reset}` : `${ui.dim}${memoryLabel(on)}${ui.reset}`;
}

/** 横幅纯文本(带 ANSI 颜色,不写出)——供 TUI 经 contentWrite 写入内容区以跟踪续写位。
 *  布局:大字 logo(4 行,块字符)左对齐,右侧并排放标题/信息(neofetch 风)。 */
export function bannerString(info: BannerInfo): string {
  const title = `${ui.bold}${ui.accent}●  MoCode${ui.reset}  ${ui.dim}v${VERSION}${ui.reset}`;
  const labels = [t('banner.model'), t('banner.directory'), t('banner.memory')];
  // 标签列按当前语言最长文本动态定宽，并至少留两个空格；中文保持原 6 列，英文扩至 11 列。
  const labelWidth = Math.max(...labels.map(displayWidth)) + 2;
  const rows = [
    logoLine(0) + title,
    logoLine(1) + labelContent(labels[0], info.model, labelWidth),
    logoLine(2) + labelContent(labels[1], truncateDisplay(info.cwd, 48), labelWidth),
    logoLine(3) + labelContent(labels[2], memoryValue(info.memoryEnabled), labelWidth),
  ];
  return rows.map((r) => MARGIN + r).join('\n') + '\n\n';
}

/** 启动横幅:大字 logo + 标题/信息。纯渲染,不依赖 config / 业务。 */
export function printBanner(info: BannerInfo): void {
  stdout.write(bannerString(info));
}

/**
 * 与 bannerString 等价但返**自洽 ANSI 行数组**(每行均以 \x1B[0m 收尾),供 layout.writeBanner
 * 直接灌入 content 缓冲,免去 contentWrite 走字符流再 breakRow 的列宽折行问题。
 *
 * 行集合 = bannerString 解析后的所有物理行。layout 记录此长度作
 * bannerH,rewriteBanner 必须按等长替换(否则 layout 抛错)。
 *
 * 返回前会 normalize:每行若未以 \x1B[0m 收尾则补,统一自洽,避免 setLines / replaceHead
 * 内部 ANSI 状态机把后续 SGR 当 curSgr 残留继承下去。
 */
export function bannerLines(info: BannerInfo): string[] {
  const raw = bannerString(info);
  // bannerString 形如 "行1\n行2\n行3\n行4\n",split('\n') 长度 = 5(末尾 \n 后空串)
  // 行集合真实包含 4 行(4 行 logo+info);filter(Boolean?) 不可 — 空行也要算
  // 仅过滤最后那个 \n 切出的尾空
  const split = raw.split('\n');
  const lines = split.length > 0 && split[split.length - 1] === '' ? split.slice(0, -1) : split;
  return lines.map((s) => (s.endsWith('\x1B[0m') ? s : `${s}\x1B[0m`));
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
  const s = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return s('path') || truncateDisplay(argsRaw, 80);
    case 'run_command':
      return truncateDisplay(s('command') || argsRaw, 100);
    case 'dev_server': {
      const action = s('action');
      const detail = s('command') || s('id') || s('readyUrl');
      return truncateDisplay(detail ? `${action}  ·  ${detail}` : action || argsRaw, 100);
    }
    case 'browser': {
      // 刻意不显示 fill 的 value:可能是密码等敏感输入。
      const action = s('action');
      const detail = s('url') || s('selector') || s('key') || s('sessionId');
      return truncateDisplay(detail ? `${action}  ·  ${detail}` : action || argsRaw, 100);
    }
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
      return nonEmpty.length ? t('toolSummary.lines', { count: nonEmpty.length }) : t('toolSummary.emptyFile');
    case 'glob':
      return nonEmpty.length ? t('toolSummary.files', { count: nonEmpty.length }) : t('toolSummary.noMatches');
    case 'grep':
      return nonEmpty.length ? t('toolSummary.matches', { count: nonEmpty.length }) : t('toolSummary.noMatches');
    case 'run_command':
      return truncateDisplay(nonEmpty[0] ?? '', 100) || t('toolSummary.noOutput');
    default:
      return truncateDisplay(nonEmpty[0] ?? '', 100);
  }
}
