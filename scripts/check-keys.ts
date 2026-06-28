/**
 * 按键 / 鼠标序列诊断(一次性,定位滚动键 + 滚轮的 readline 解析行为)。
 *
 * 用法:
 *   npx tsx scripts/check-keys.ts            # 不启用鼠标模式(模拟当前 REPL)
 *   npx tsx scripts/check-keys.ts --mouse    # 启用 SGR 鼠标模式(候选修复)
 *
 * 跑起来后:上下滚滚轮、按 PgUp/PgDn/↑/↓/Ctrl+↑/Ctrl+↓ 各几下,看 [data]/[key] 输出;
 * Ctrl+C 退出。把输出贴回给 Claude。
 *
 * 看 [key] 行:滚轮时 name 是什么、sequence 是什么——决定用 key.name 还是 sequence 匹配。
 * 看 [data] 行:原始字节,确认终端发的确切序列(SGR 鼠标 \x1b[<b;c;rM 还是 ↑↓ \x1b[A/B)。
 */
import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline';

const enableMouse = process.argv.includes('--mouse');

function hex(buf: Buffer): string {
  return [...buf].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}

stdout.write(
  `按键/鼠标诊断(鼠标模式:${enableMouse ? '启用' : '未启用'})。滚轮/PgUp/↑↓/Ctrl+↑↓ 各几下,Ctrl+C 退出。\n`
);
if (enableMouse) stdout.write('\x1b[?1006h\x1b[?1000h'); // SGR 坐标 + 普通鼠标报告

// 原始字节(stdin 'data',先于 readline 的 keypress 解析)
stdin.on('data', (d: Buffer) => {
  stdout.write(`[data] hex=${hex(d)} str=${JSON.stringify(d.toString())}\n`);
});

readline.emitKeypressEvents(stdin);
try {
  stdin.setRawMode(true);
} catch {
  stdout.write('(setRawMode 失败:非 TTY?请在真实终端跑)\n');
}
stdin.resume();

stdin.on('keypress', (str: string, key?: readline.Key) => {
  stdout.write(
    `[key]  str=${JSON.stringify(str)} name=${key?.name ?? '∅'} ctrl=${key?.ctrl} meta=${key?.meta} shift=${key?.shift} seq=${JSON.stringify(key?.sequence)}\n`
  );
  if (key?.ctrl && key?.name === 'c') {
    if (enableMouse) stdout.write('\x1b[?1000l\x1b[?1006l');
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    stdout.write('(退出)\n');
    process.exit(0);
  }
});
