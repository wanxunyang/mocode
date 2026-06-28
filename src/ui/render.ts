import { stdout } from 'node:process';
import { ui } from './theme.js';

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

/** 去除 SGR 颜色转义(\x1B[…m),用于度量带色串的真实可见宽度。 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
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

const BOX_W = 76; // 内容区显示宽度(容下完整工具列表 + 命令提示)
const MARGIN = '  '; // 盒外左缩进

function boxBorder(left: string, mid: string, right: string): string {
  return `${ui.gray}${left}${mid.repeat(BOX_W + 2)}${right}${ui.reset}`;
}

function boxLine(content: string): string {
  const inner = padEndDisplay(truncateDisplay(content, BOX_W), BOX_W);
  return `${ui.gray}│${ui.reset} ${inner} ${ui.gray}│${ui.reset}`;
}

function boxEmpty(): string {
  return `${ui.gray}│${ui.reset} ${' '.repeat(BOX_W)} ${ui.gray}│${ui.reset}`;
}

function labelRow(label: string, value: string): string {
  return boxLine(`${ui.dim}${padEndDisplay(label, 6)}${ui.reset}${value}`);
}

/** 横幅纯文本(带 ANSI 颜色,不写出)——供 TUI 经 contentWrite 写入内容区以跟踪续写位。 */
export function bannerString(info: BannerInfo): string {
  const rows = [
    boxBorder('╭', '─', '╮'),
    boxLine(
      `${ui.bold}${ui.brightCyan}◆  mocode${ui.reset}  ${ui.dim}终端编码 agent${ui.reset}`
    ),
    boxEmpty(),
    labelRow('模型', info.model),
    labelRow('后端', info.baseURL),
    labelRow('目录', info.cwd),
    labelRow('工具', info.tools),
    boxEmpty(),
    boxLine(`${ui.dim}/exit 退出 · /clear 清空 · /compact 压缩 · /context 用量 · /resume 续接${ui.reset}`),
    boxBorder('╰', '─', '╯'),
  ];
  return (
    rows.map((r) => MARGIN + r).join('\n') +
    '\n\n' +
    `${MARGIN}${ui.dim}直接描述任务,agent 会自动读写文件与执行命令。${ui.reset}\n`
  );
}

/** 启动横幅:带边框的信息盒 + 一行提示。纯渲染,不依赖 config / 业务。 */
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
