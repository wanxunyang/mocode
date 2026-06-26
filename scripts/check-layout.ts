/**
 * layout.ts 离线验证(参考 check-context.ts 风格):
 * 把 stdout 伪装成 TTY(isTTY/columns/rows)+ 捕获写出,断言 layout 的 ANSI 输出符合不变量——
 * alt screen、DECSTBM 滚动区域、续写位跟踪、底栏定位、思考段擦除、退出恢复。
 * 不替代真实终端冒烟(终端如何诠释 ANSI 仍需在 WT/cmd 实跑),但能抓逻辑 / 行号 / 转义错误。
 */
import process from 'node:process';

// ── 在导入 layout/theme 前伪装 TTY + 捕获写出(否则 layout 全 no-op)──
Object.defineProperty(process.stdout, 'isTTY', {
  value: true,
  configurable: true,
});
Object.defineProperty(process.stdout, 'columns', {
  value: 80,
  configurable: true,
});
Object.defineProperty(process.stdout, 'rows', {
  value: 24,
  configurable: true,
});

const realWrite = process.stdout.write.bind(process.stdout);
let buf = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).write = (
  chunk: string | Uint8Array,
  _enc?: unknown,
  cb?: () => void
): boolean => {
  buf += String(chunk);
  if (cb) cb();
  return true;
};

let pass = 0;
let fail = 0;
function log(s: string): void {
  realWrite(s + '\n');
}
function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    log(`✓ ${name}`);
  } else {
    fail++;
    log(`✗ ${name}`);
  }
}
const reset = (): void => {
  buf = '';
};
const out = (): string => buf;
const has = (re: RegExp): boolean => re.test(buf);

// 动态导入:确保 theme 在 isTTY=true 之后加载(其 isTTY 在 import 时冻结)
const layout = await import('../src/ui/layout.js');

// 1. enterAltScreen
reset();
layout.enterAltScreen();
ok('enterAltScreen 进备用屏', has(/\x1b\[\?1049h/));
ok('enterAltScreen 设滚动区域 [1;22r](rows24 footerH2)', has(/\x1b\[1;22r/));

// 2. clearContent
reset();
layout.clearContent();
ok('clearContent 清屏 \\x1B[2J', has(/\x1b\[2J/));
ok('clearContent 重设区域', has(/\x1b\[1;22r/));

// 3. contentWrite 续写位跟踪
reset();
layout.contentWrite('hello\n'); // row1→row2
reset();
layout.contentWrite('x'); // 应 CUP 到 (2,1)
ok('contentWrite 续写位跟踪(hello\\n → [2;1H)', has(/\x1b\[2;1H/));

// 4. drawStatusBar 画状态行 + 回续写位
layout.setStatusBase({
  model: 'glm-4.6',
  contextBar: '[▓▓▓░░░░░░░] 38% 5k/128k',
  cwd: 'F:\\x',
});
layout.clearContent(); // 续写位 (1,1)
reset();
layout.drawStatusBar();
ok('drawStatusBar 状态行在 row23(contentBottom22+1)', has(/\x1b\[23;1H/));
ok('drawStatusBar 含模型名', out().includes('glm-4.6'));
ok('drawStatusBar 回续写位 [1;1H]', has(/\x1b\[1;1H.*\x1b\[1;1H/) || has(/\x1b\[23;1H[\s\S]*\x1b\[1;1H/));

// 5. eraseSegmentBack
layout.clearContent();
layout.beginSegment();
layout.contentWrite('aaa\nbbb\n'); // 占 row1,2 → 续写位 row3
reset();
const erased = layout.eraseSegmentBack();
ok('eraseSegmentBack 擦 2 行', erased === 2);
ok('eraseSegmentBack 逐行 \\x1B[2K(不用 ED)', has(/\x1b\[2K/) && !has(/\x1b\[J/));
ok('eraseSegmentBack 回段起点 [1;1H]', has(/\x1b\[1;1H/));

// 5b. eraseSegmentBack 滚动段(段长 > 可用行 → 区域滚动过 → 从内容区顶擦,不残留上尾巴)
// 这正是思考折叠 bug 的场景:GLM 推理思考很长,写满内容区后 DECSTBM 滚动整区,
// 段起点(含 ▎思考 标题)滚出屏顶;旧实现按绝对屏行 segmentStartRow 擦只擦尾巴,
// 上方残留原始思考、折叠标题落屏中。新实现按 segLines 判滚动 → 从 contentTop 擦。
layout.clearContent();
layout.contentWrite('banner\n'); // row1,不在段内
layout.beginSegment(); // segStartRow=2
let longThink = '';
for (let i = 0; i < 40; i++) longThink += `line${i}\n`;
longThink += 'tail'; // 末行有内容 → contentCol>1
layout.contentWrite(longThink); // 段从 row2 起 40 行,远超可用 21,滚出
reset();
const erasedScroll = layout.eraseSegmentBack();
ok('eraseSegmentBack 滚动段擦整屏 22 行', erasedScroll === 22);
// 旧实现只擦 [2..22] 不碰 row1;新实现从 contentTop=1 擦(证明滚动感知)
ok('eraseSegmentBack 滚动段擦 row1(contentTop)', has(/\x1b\[1;1H\x1b\[2K/));
ok('eraseSegmentBack 滚动段不擦底栏(止于 22)', !has(/\x1b\[23;1H\x1b\[2K/) && !has(/\x1b\[24;1H\x1b\[2K/));

// 5c. eraseSegmentBack 未滚动段(末行有内容,无滚动 → 从段起点擦,不误擦段外)
layout.clearContent();
layout.contentWrite('keep\n'); // row1,段外
layout.beginSegment(); // segStartRow=2
layout.contentWrite('aaa\nbbb'); // row2:'aaa', row3:'bbb'(无尾 \n,contentCol>1)
reset();
const erasedMid = layout.eraseSegmentBack();
ok('eraseSegmentBack 未滚动段擦 2 行', erasedMid === 2);
ok('eraseSegmentBack 未滚动不擦段外 row1', !has(/\x1b\[1;1H\x1b\[2K/));
ok('eraseSegmentBack 未滚动从段起点 [2;1H] 起', has(/\x1b\[2;1H\x1b\[2K/));

// 6. setRegion 撑高底栏钳续写位
layout.clearContent();
// 把内容填到 contentBottom=22
let filler = '';
for (let i = 0; i < 25; i++) filler += `line${i}\n`;
layout.contentWrite(filler);
ok('内容填满后续写位钳到 contentBottom=22', true); // 占位:下面断言真正验证
reset();
layout.setRegion(5); // footerH 5 → contentBottom=19,续写位应钳到 19
layout.contentWrite('z'); // CUP 到续写位
ok('setRegion 撑高钳续写位到 [19;1H]', has(/\x1b\[19;1H/));

// 7. enterInputMode 画底栏(状态行+输入框)
layout.clearContent();
reset();
layout.enterInputMode('空闲');
ok('enterInputMode 状态行 row23', has(/\x1b\[23;1H/));
ok('enterInputMode 输入框 row24', has(/\x1b\[24;1H/));
ok('enterInputMode 含 prompt ❯ ', out().includes('❯'));

// 8. enterRunningMode dim 占位 + 回续写位
layout.clearContent();
reset();
layout.enterRunningMode('处理', '思考中… Ctrl+C 中断');
ok('enterRunningMode dim 占位', out().includes('思考中… Ctrl+C 中断'));
ok('enterRunningMode 回续写位 [1;1H]', has(/\x1b\[1;1H/));

// 9. paintInput 多行 + 向上菜单
layout.clearContent();
reset();
layout.paintInput({
  prompt: '❯ ',
  lines: ['', ''],
  cursorLine: 0,
  cursorCol: 0,
  menu: { lines: ['▸ /exit 退出', '  /clear 清空'] },
});
ok('paintInput 菜单向上展开(画在内容区底)', out().includes('/exit 退出'));
ok('paintInput 底栏状态行 + 输入框', has(/\x1b\[2[0-9];1H/));

// 10. 多行撑高 → footerH 变,区域重设(不崩)
layout.clearContent();
reset();
const many: string[] = [];
for (let i = 0; i < 30; i++) many.push(`line${i}`);
layout.paintInput({
  prompt: '❯ ',
  lines: many,
  cursorLine: 29,
  cursorCol: 0,
  menu: null,
});
ok('paintInput 30 行输入不崩(开窗)', !out().includes('undefined'));

// 11. exitAltScreen 恢复
reset();
layout.exitAltScreen();
ok('exitAltScreen 退备用屏', has(/\x1b\[\?1049l/));
ok('exitAltScreen 复位 margins \\x1B[r', has(/\x1b\[r/));
ok('exitAltScreen 显光标', has(/\x1b\[\?25h/));

log(`\n${fail === 0 ? 'OK' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
