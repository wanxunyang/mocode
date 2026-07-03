import { stdout, platform } from 'node:process';
import { spawn } from 'node:child_process';

/**
 * 系统剪贴板写入(叶子模块,无 UI 依赖)。选区复制(layout 鼠标选择)与 /copy 等命令共用。
 *
 * 双通道:
 *  1. OSC 52(`\x1B]52;c;<base64>\x07`):请求终端把文本写入系统剪贴板。经终端转发,SSH / 远程也生效;
 *     Windows Terminal ≥1.16、iTerm2、kitty、WezTerm 等支持(部分终端默认关,需开"允许应用访问剪贴板")。
 *  2. 本地原生工具(best-effort,失败静默):win32=clip.exe(UTF-16LE)、darwin=pbcopy、
 *     linux=wl-copy / xclip / xsel。覆盖 OSC52 被禁用的场景(如部分 VS Code 集成终端配置)。
 * 两条都发:哪条生效由环境决定,重复写同一内容无副作用。
 */

/** OSC 52:base64(UTF-8) 写系统剪贴板(c=clipboard 选区)。 */
function osc52(text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  // 长度保护:部分终端对 OSC52 载荷有上限(常见 ~74KB / 100KB),超限直接跳过 OSC52
  // (仍走原生通道),避免半截 base64 污染终端。
  if (b64.length > 100000) return;
  stdout.write(`\x1B]52;c;${b64}\x07`);
}

/** spawn 一个吃 stdin 的剪贴板工具,把 buf 写入其 stdin;所有错误静默(best-effort)。 */
function pipeTo(cmd: string, args: string[], buf: Buffer): void {
  try {
    const p = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    p.on('error', () => {}); // 命令不存在等:静默(OSC52 兜底)
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  } catch {
    // 忽略
  }
}

/** 本地原生剪贴板(best-effort)。 */
function nativeCopy(text: string): void {
  if (platform === 'win32') {
    // clip.exe 在 Win10+ 接受 UTF-16LE 字节(无 BOM),可正确处理中文/emoji;
    // 直接管 UTF-8 会按控制台代码页解码致乱码,故用 utf16le。
    pipeTo('clip', [], Buffer.from(text, 'utf16le'));
  } else if (platform === 'darwin') {
    pipeTo('pbcopy', [], Buffer.from(text, 'utf8'));
  } else {
    // linux:Wayland 优先 wl-copy,X11 退 xclip / xsel(装了哪个用哪个;spawn error 静默跳过)
    const b = Buffer.from(text, 'utf8');
    pipeTo('wl-copy', [], b);
    pipeTo('xclip', ['-selection', 'clipboard'], b);
    pipeTo('xsel', ['--clipboard', '--input'], b);
  }
}

/** 写入系统剪贴板(OSC52 + 本地原生双通道)。 */
export function copyToClipboard(text: string): void {
  if (!text) return;
  osc52(text);
  nativeCopy(text);
}
