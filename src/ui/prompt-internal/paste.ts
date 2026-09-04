import { stdin } from 'node:process';

// ── 二次确认发送(MOCODE_CONFIRM_SEND=long 时启用,默认关)──
// 长 prompt 首次 Enter 只武装,窗口内再按一次才真发。默认 opt-in:新交互默认不打扰既有习惯。
export const CONFIRM_SEND_MS = 2000;
export const LONG_INPUT_CHARS = 120;

/** 二次确认模式:only 'long' 会启用(长/多行输入需按两次 Enter)。每次读 env,便于运行期改配置生效。 */
export function confirmSendMode(): 'never' | 'long' {
  return process.env.MOCODE_CONFIRM_SEND === 'long' ? 'long' : 'never';
}

// ── 粘贴检测(块级 + 时间窗)──
// 用状态对象包裹模块级可变变量,使拆分到不同文件的 editor/pickers 都能直接读写同一状态。
// 块级:多字节大块(len>8)或含 CR/LF 的小块 = 粘贴(键盘单键 1 字节,Enter=\r 单字节)。
// 时间窗:每块重置 50ms 计时器,静默 50ms 即"粘贴结束"→ onPasteEnd。跨多块的大粘贴(块间 <50ms)累积进
// 同一个 pasteParts、末尾一次性落 chip——避免"首块成 chip、后续块泄成文本"。粘贴中 onKey 把键累积进
// pasteParts(不编辑 lines)。不启用 bracketed paste——emitKeypressEvents 会把 \x1B[200~ 标记当按键砸进输入框。
export const pasteState = {
  pasting: false,
  pasteParts: [] as string[],
  pasteTimer: null as NodeJS.Timeout | null,
  /** 粘贴结束回调(prompt 注入:落 chip 或保留为文本) */
  onPasteEnd: null as (() => void) | null,
};

let pasteDetectorInstalled = false;

export function ensurePasteDetector(): void {
  if (pasteDetectorInstalled) return;
  pasteDetectorInstalled = true;
  stdin.on('data', (chunk: Buffer | string) => {
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // 剔除 SGR 鼠标报告(\x1B[<…M/m,连半截也匹配):拖拽选区时终端连续发 motion 报表,
    // 一个 chunk 里可能拼多条(22+ 字符 > 16 阈值)误判粘贴 50ms、把后续真按键泄进 pasteParts。
    const text = raw.replace(/\x1b\[<[0-9;]*[Mm]/g, '');
    const hasNL = text.indexOf('\r') >= 0 || text.indexOf('\n') >= 0;
    // 按字符数(码点)判粘贴,非字节:CJK 汉字占 3 UTF-8 字节,旧阈值(len>8 字节)会把 IME 提交的
    // 3-10 个汉字误判为粘贴 → 进 50ms 缓冲 → finalizePaste→insertText 落字(且旧 insertText 把光标
    // 置插入文本长度而非末尾,致"后续打字插到行中间")。改:含换行(多行粘贴)或 >16 字符(大块单行
    // 粘贴)才算粘贴;普通 IME 提交走正常按键路径(逐字直插、光标随进、无延迟)。
    const charCount = [...text].length;
    if (!(charCount > 16 || (charCount > 1 && hasNL))) return;
    pasteState.pasting = true;
    if (pasteState.pasteTimer) clearTimeout(pasteState.pasteTimer);
    const t = setTimeout(() => {
      pasteState.pasteTimer = null;
      pasteState.pasting = false;
      pasteState.onPasteEnd?.();
    }, 50);
    t.unref();
    pasteState.pasteTimer = t;
  });
}
