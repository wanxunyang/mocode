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
const content = await import('../src/ui/content.js');

// 1. enterAltScreen
reset();
layout.enterAltScreen();
ok('enterAltScreen 进备用屏', has(/\x1b\[\?1049h/));
ok('enterAltScreen 设滚动区域 [1;22r](rows24 footerH2)', has(/\x1b\[1;22r/));
ok('enterAltScreen 启 alt 滚轮转发(1007h)', has(/\x1b\[\?1007h/));

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

// 5d. eraseSegmentBack 滚动回看态:段未物理写(contentWrite 跳过),折叠不物理清屏(只删缓冲),不覆盖历史视图
// 修:用户流式输出时 PgUp 回看历史,思考折叠把整屏擦白(而非在底部默默隐藏)的 bug。
layout.clearContent();
layout.setRegion(2);
for (let i = 0; i < 30; i++) layout.contentWrite(`hist${i}\n`); // 31 行(30 提交 + 当前空),够滚动
layout.scrollBy(9); // 上滚 offset=9,viewport 显历史(hist0..hist21)
ok('5d 前置:已滚动(offset>0)', layout.isScrolled());
reset();
// 思考段(滚动态:contentWrite 只喂缓冲,不物理写)
layout.beginSegment();
layout.contentWrite('\x1b[2m▎ 思考\x1b[0m\n');
layout.contentWrite('\x1b[2m思考原文\x1b[0m\n');
ok('滚动态 contentWrite 零物理输出(段未写屏)', out() === '');
// 折叠(滚动态):eraseSegmentBack 不应物理清屏
const erasedScrolled = layout.eraseSegmentBack();
ok('滚动态 eraseSegmentBack 零物理输出(不擦屏)', out() === '');
ok('滚动态 eraseSegmentBack 返回 0(未物理擦)', erasedScrolled === 0);
// 缓冲段已删:回尾后 viewport 不含思考原文
layout.scrollBy(-9);
ok('滚动态折叠后回尾不含思考原文(缓冲已删)', !out().includes('思考原文'));

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

// 10b. 软折行(单逻辑行长于宽度)→ 撑高底栏、折到可视行,不溢出屏底
// 旧实现只按 lines.length 算行数(单行=1),长文本被终端自动折到屏外、第二行藏底栏下——本测试锁住修复。
layout.clearContent();
reset();
const longLine = 'a'.repeat(100); // W=cols(80)-promptW(2)=78 → 折成 78+22 两可视行
layout.paintInput({
  prompt: '❯ ',
  lines: [longLine],
  cursorLine: 0,
  cursorCol: 100,
  menu: null,
});
ok('软折行撑高底栏 footerH=3 → 区域 [1;21r]', has(/\x1b\[1;21r/));
ok('软折行画首可视行(78 个 a)', out().includes('a'.repeat(78)));
ok('软折行画次可视行(22 个 a)', out().includes('a'.repeat(22)));
ok('软折行光标落次可视行末 [24;25H]', has(/\x1b\[24;25H/));
ok('软折行不写到屏底之外(无 row≥25)', !has(/\x1b\[(2[5-9]|[3-9]\d);/));

// 10c. 软折行遇宽字符(CJK=2):行尾放不下整字折下行、本行留尾空格,光标按各行实际宽度定位(非除法)
layout.clearContent();
layout.setRegion(2); // 复位底栏高(上例 10b 留下 footerH=3),使本例撑高可观测
reset();
const cjkLine = 'a'.repeat(77) + '字'; // 77(宽1)+字(宽2)=79 > W78 → 字折下行,首行留 1 空格
layout.paintInput({
  prompt: '❯ ',
  lines: [cjkLine],
  cursorLine: 0,
  cursorCol: 79, // 光标在末尾(字之后)
  menu: null,
});
ok('宽字折行撑高 footerH=3', has(/\x1b\[1;21r/));
ok('宽字折行光标落次行字后 [24;5H]', has(/\x1b\[24;5H/));

// ── Phase 2:content 缓冲 + viewport 滚动 ──

// 12. content 缓冲收行(breakRow 各成行;totalRows 含当前行)
content.reset();
content.feedChar('a');
content.feedChar('b');
content.breakRow(); // 'ab\n' → 1 提交 + 当前空行
ok('content breakRow 后 totalRows=2(提交+当前空)', content.totalRows() === 2);
content.feedChar('c'); // 当前空行填 'c'
ok('content 填当前行 totalRows 仍 2', content.totalRows() === 2);
content.breakRow(); // 'c\n' → 2 提交 + 当前空
ok('content 再 breakRow totalRows=3', content.totalRows() === 3);

// 13. content SGR 自洽:行内开合 dim/reset,单行含正确码
content.reset();
content.feedSgr('\x1b[2m');
content.feedChar('a');
content.feedChar('b');
content.feedSgr('\x1b[0m');
content.feedChar('c');
content.breakRow();
const sgrRow = content.sliceFromEnd(0, 10)[0];
ok(
  'content 行内开合 SGR 自洽(\\x1b[2m ab \\x1b[0m c)',
  sgrRow === '\x1b[2mab\x1b[0mc\x1b[0m'
);

// 14. content 跨行继承 dim:折行后下行前缀含 dim
content.reset();
content.feedSgr('\x1b[2m');
content.feedChar('a');
content.breakRow(); // 'a' 提交(dim),下行继承 dim
content.feedChar('b');
content.feedSgr('\x1b[0m');
content.breakRow();
const inherited = content.sliceFromEnd(0, 10)[1];
ok('content 跨行继承 dim(下行以 \\x1b[2m 起)', inherited.startsWith('\x1b[2m') && inherited.includes('b'));

// 15. content eraseSegment 删段:begin→写段→erase,缓冲回段前、不含段内容
content.reset();
content.feedChar('x');
content.breakRow(); // 段外 'x'
content.beginSegment();
content.feedChar('a');
content.breakRow();
content.feedChar('b'); // 段:'a\n' + 当前 'b'
const erasedCnt = content.eraseSegment();
ok('content eraseSegment 返回段行数 2', erasedCnt === 2);
ok(
  'content erase 后缓冲不含段内容(a/b)',
  !content.sliceFromEnd(0, 10).some((r) => r.includes('a') || r.includes('b'))
);
ok('content erase 后缓冲回段前(只剩 x + 当前空)', content.totalRows() === 2);

// 16. contentWrite 喂缓冲(layout 路径):写 30 行,缓冲 totalRows=31(30 提交 + 当前空)
layout.clearContent();
for (let i = 0; i < 30; i++) layout.contentWrite(`line${i}\n`);
ok('contentWrite 喂缓冲 30 行 → totalRows 31', content.totalRows() === 31);
// 尾窗 offset=0:末 22 行 = line9..line29(21)+当前空(1),首行 line9
const tailWin = content.sliceFromEnd(0, 22);
ok('content 尾窗 offset=0 含 line29(最新)', tailWin.some((r) => r.includes('line29')));
ok('content 尾窗 offset=0 不含 line0(更旧)', !tailWin.some((r) => r.includes('line0')));
// offset=9(往旧):窗 = line0..line21,含 line0
const oldWin = content.sliceFromEnd(9, 22);
ok('content offset=9 含 line0(最旧)', oldWin.some((r) => r.includes('line0')));

// 17. scrollBy 钳位 + isScrolled + resetScroll
ok('scrollBy 前未滚动', !layout.isScrolled());
layout.scrollBy(10000); // 往旧,钳到 maxOff=31-22=9
ok('scrollBy(+大) 钳到 maxOff=9 后处于滚动', layout.isScrolled());
layout.scrollBy(-10000); // 往新,钳到 0
ok('scrollBy(-大) 回尾后未滚动', !layout.isScrolled());
layout.scrollBy(5);
ok('scrollBy(+5) 滚动到 offset 5', layout.isScrolled());
layout.resetScroll();
ok('resetScroll 回尾', !layout.isScrolled());

// 18. repaintViewport offset=0 重画 == 尾窗(写 line0..line29 后,尾窗含 line29 不含 line0)
layout.clearContent();
layout.setRegion(2); // 重置底栏高度(contentBottom=22,免受前面 paintInput 撑高影响)
for (let i = 0; i < 30; i++) layout.contentWrite(`line${i}\n`);
reset();
layout.scrollBy(9); // 往旧到 offset 9,viewport 显 line0..line21
ok('repaintViewport offset=9 含 line0', out().includes('line0'));
reset();
layout.scrollBy(-9); // 回尾
ok('repaintViewport offset=0 含 line29(尾) 不含 line0', out().includes('line29') && !out().includes('line0'));

// 19. paintInput 重画 contentBottom(底栏上一行)从缓冲——防 WT 边距漏影
layout.clearContent();
layout.contentWrite('hello\n'); // 内容在 row1,contentBottom=22 为空
reset();
layout.enterInputMode('空闲');
ok('paintInput 清 contentBottom(row22)防漏影', has(/\x1b\[22;1H\x1b\[2K/));

// 20. 思考折叠后缓冲只剩标题(滚动回看不现原文)——agent onThinking→flushThinkCollapsed 路径
layout.clearContent();
layout.setRegion(2);
layout.contentWrite('reply-before\n'); // 段前内容
layout.beginSegment();
layout.contentWrite('\x1b[2m▎ 思考\x1b[0m\n'); // 展开标题
layout.contentWrite('\x1b[2m这里是思考原文内容\x1b[0m\n'); // 思考原文
layout.eraseSegmentBack(); // 折叠(擦屏 + content.eraseSegment 删缓冲段)
layout.contentWrite('\x1b[2m▎ 思考 ▸ (16 字符)\x1b[0m\n'); // 折叠标题
const scrollback = content.sliceFromEnd(0, 50).join('');
ok('思考折叠后缓冲含折叠标题(思考 ▸)', scrollback.includes('思考 ▸'));
ok('思考折叠后缓冲不含思考原文', !scrollback.includes('思考原文'));
ok('思考折叠后缓冲保留段前内容', scrollback.includes('reply-before'));

// ── RUNNING 态交互(typeahead 输入 + 滚动回看 + 中断)不变量 ──
layout.setStatusBase({ model: 'm', contextBar: '', cwd: '/' });

// 21. contentWrite 滚动感知:scrollOffset>0 时只喂缓冲不物理写(否则新流式覆盖 viewport 历史行)
layout.clearContent();
layout.setRegion(2);
for (let i = 0; i < 30; i++) layout.contentWrite(`cw${i}\n`); // 31 行(30 提交 + 当前空)
layout.scrollBy(9); // 上滚 offset=9,viewport 锁历史
reset();
layout.contentWrite('NEW\n'); // 滚动态:只喂缓冲,不物理写
ok('滚动态 contentWrite 零物理输出(不撞穿 viewport)', out() === '');
ok('滚动态 contentWrite 仍喂缓冲(totalRows 32)', content.totalRows() === 32);
reset();
layout.scrollBy(-9); // 回尾,repaintViewport 显新尾(含 NEW)
ok('回尾后 viewport 含新内容 NEW', out().includes('NEW'));

// 22. 滚动回看时光标归 contentBottom(不入输入框)
layout.clearContent();
layout.setRegion(2);
for (let i = 0; i < 30; i++) layout.contentWrite(`g${i}\n`);
layout.scrollBy(9); // offset=9
reset();
layout.drawStatusBar();
ok('滚动态 drawStatusBar 末尾 CUP 归 contentBottom(22;1)', /\x1b\[22;1H$/.test(out()));
reset();
layout.contentMode();
ok('滚动态 contentMode CUP 归 contentBottom(22;1)', has(/\x1b\[22;1H/));

// 23. paintRunningInputEcho:定向写输入行(底栏),无 setRegion/ED
layout.clearContent();
layout.setRegion(2);
reset();
layout.paintRunningInputEcho('hi', '占位');
ok('paintRunningInputEcho 含 ❯ hi', out().includes('❯ hi'));
ok('paintRunningInputEcho 含 clearLine(\\x1B[2K)', has(/\x1b\[2K/));
ok('paintRunningInputEcho cup 输入行(row24=contentBottom+2)', has(/\x1b\[24;1H/));
ok('paintRunningInputEcho 不发 setRegion(\\x1B[1;Nr)', !has(/\x1b\[1;\d+r/));
ok('paintRunningInputEcho 不发 ED(\\x1B[J)', !has(/\x1b\[\d*J/));
reset();
layout.paintRunningInputEcho('', '占位'); // 无打字 → 显 placeholder
ok('paintRunningInputEcho 无打字显 placeholder', out().includes('占位'));

// 24. paintRunningInputEcho 同步 lastView:滚动/resize 的 repaint 不擦已打字
layout.clearContent();
layout.setRegion(2);
for (let i = 0; i < 30; i++) layout.contentWrite(`p${i}\n`); // 够多行让 scrollBy(1) 生效
layout.paintRunningInputEcho('queued', '占位');
reset();
layout.scrollBy(1);
layout.scrollBy(-1); // repaint → paintInput(lastView=queued dim),应仍显 queued
ok('echo 后滚动+回尾仍显已打字 queued', out().includes('queued'));

// 25. enterRunningMode 后可滚动;光标归 contentBottom,不入输入框
layout.clearContent();
layout.setRegion(2);
for (let i = 0; i < 30; i++) layout.contentWrite(`r${i}\n`);
layout.enterRunningMode('处理', '思考中…');
ok('enterRunningMode 后未滚动', !layout.isScrolled());
reset();
layout.scrollBy(9);
ok('enterRunningMode 后可滚动', layout.isScrolled());
ok('运行态滚动后光标归 contentBottom(22;1)', /\x1b\[22;1H$/.test(out()));

// 11. exitAltScreen 恢复
reset();
layout.exitAltScreen();
ok('exitAltScreen 退备用屏', has(/\x1b\[\?1049l/));
ok('exitAltScreen 复位 margins \\x1B[r', has(/\x1b\[r/));
ok('exitAltScreen 显光标', has(/\x1b\[\?25h/));
ok('exitAltScreen 关 alt 滚轮转发(1007l)', has(/\x1b\[\?1007l/));

log(`\n${fail === 0 ? 'OK' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
