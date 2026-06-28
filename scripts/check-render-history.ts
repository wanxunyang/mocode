/**
 * renderHistory 离线校验(参考 check-layout 风格):
 * 伪装 stdout 为 TTY + 捕获写出,断言回滚 / 续接 / --resume 后把会话历史正确渲染进内容区——
 * user→❯ 回显、assistant→正文 + tool_calls 作 ● 行、tool→↳ 预览,system 跳过。
 * 不替代真实终端冒烟,但能抓渲染逻辑 / 消息形态错误。
 */
import process from 'node:process';

// ── 在导入任何 ui/repl 模块前伪装 TTY + 捕获写出(theme 的 isTTY 在 import 时冻结)──
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

const layout = await import('../src/ui/layout.js');
const content = await import('../src/ui/content.js');
const { renderHistory } = await import('../src/repl/index.js');

layout.setStatusBase({ model: 'glm-5.2', contextBar: '', cwd: 'F:\\x' });
layout.enterAltScreen();
layout.clearContent();

// 1. 基本:user 回显 + assistant 正文,system 跳过
reset();
renderHistory([
  { role: 'system', content: 'you are an agent' },
  { role: 'user', content: '读 sample.txt' },
  { role: 'assistant', content: '好的,内容是…' },
]);
ok('user 回显带 ❯ 前缀', out().includes('❯ 读 sample.txt'));
ok('assistant 正文写出', out().includes('好的,内容是…'));
ok('system 内容不写出', !out().includes('you are an agent'));

// 2. 多行 user:续行按 prompt 宽度缩进(对齐 echoInput)
reset();
renderHistory([{ role: 'user', content: '第一行\n第二行' }]);
ok('多行 user 首行带 ❯', out().includes('❯ 第一行'));
// PROMPT '❯ ' 显示宽度=2(❯1+空格1),续行缩进 2 空格,且只一个 ❯
ok('多行 user 续行 2 空格缩进(无第二个 ❯)', out().includes('❯ 第一行\n  第二行') && (out().match(/❯/g) || []).length === 1);

// 3. assistant 带 tool_calls:作 ● 行(name + summary);tool 消息作 ↳ 预览
reset();
renderHistory([
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"sample.txt"}' },
      },
    ],
  } as never,
  { role: 'tool', tool_call_id: 'call_1', content: '1: hello\n2: world' },
]);
ok('tool_call 画 ● 行(含工具名 read_file)', out().includes('●') && out().includes('read_file'));
ok('tool_call summary 含路径 sample.txt', out().includes('sample.txt'));
ok('tool 结果画 ↳ 预览(行数)', out().includes('↳') && out().includes('行'));
// ↳ 预览不应把整个原始输出灌进屏(只一行预览)
ok('tool 结果只一行预览(不含原始 2: world)', !out().includes('2: world'));

// 4. 多个 tool_calls + 多 tool 结果:id→name 映射正确(每个 ↳ 对到其工具)
reset();
renderHistory([
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.txt"}' } },
      { id: 'b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"runAgent"}' } },
    ],
  } as never,
  { role: 'tool', tool_call_id: 'a', content: 'a.txt\nb.txt' },
  { role: 'tool', tool_call_id: 'b', content: 'src/agent:1: runAgent' },
]);
ok('两 tool_call 各画 ● 行', (out().match(/●/g) || []).length === 2);
ok('两 tool 结果各画 ↳ 行', (out().match(/↳/g) || []).length === 2);

// 5. 渲染后缓冲进了 content(回滚后 PgUp 能看)— user+assistant 各成物理行
ok('渲染进缓冲(user 行)', content.sliceFromEnd(0, 50).some((r) => r.includes('读 sample.txt') || r.includes('第一行') || r.includes('好的')));

// 6. assistant 正文末尾自动补换行(后续写不挤同行)
reset();
layout.clearContent();
renderHistory([
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'no-newline' }, // 无尾 \n
]);
// 末尾应有换行:缓冲里 'no-newline' 占独立行(其后空行 = 当前光标空行)
const tail = content.sliceFromEnd(0, 5);
ok('assistant 无尾换行自动补(独立成行)', tail.some((r) => r.includes('no-newline')));

log(`\n${fail === 0 ? 'OK' : 'FAIL'}: ${pass} passed, ${fail} failed`);
layout.exitAltScreen();
process.exit(fail === 0 ? 0 : 1);
