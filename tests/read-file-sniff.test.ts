/**
 * read_file 二进制/图片嗅探 + 超限 PNG 降采样兜底。
 *
 * 背景:read_file 旧实现把任何文件都 readFile(utf8) + 行号分页,读 PNG/二进制会往
 * history 灌乱码(实测一张 42KB PNG 解出 17862 个 U+FFFD,占 45%)。现在按魔数分流:
 * 图片走视觉通道(modelAttachments),其余二进制明确拒绝并指路。
 * 4 MiB 内联上限对高 DPI 截图偏紧:超限 PNG 自动降采样后仍成功,不再直接拒绝。
 * view_image 已并入 read_file(魔数嗅探分流),本文件同时覆盖其原降采样/越界用例。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_READ_MARKER } from '../src/tools/builtins/read-file.js';
import { executeToolOutcome } from '../src/tools/registry.js';
import type { ToolOutcome } from '../src/tools/types.js';
import '../src/tools/builtins/index.js';
import {
  sniffImageMime,
  isProbablyBinary,
  loadImageAttachmentWithDownscale,
  MAX_INLINE_BYTES_DEFAULT,
} from '../src/attachments/image.js';
import { encodePng } from '../src/runtime/screen-pipeline.js';
import { IMAGE_READ_MARKER as MARKER_FROM_CONSTANTS } from '../src/tools/constants.js';
import { summarizeToolResult } from '../src/ui/render.js';
import { t } from '../src/i18n/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

let root: string;

/** 确定性伪随机(同 seed 同结果),生成可压缩但仍有熵的像素,便于造出指定体积的 PNG。 */
function makePngBuffer(w: number, h: number, levels: number): Buffer {
  const data = Buffer.alloc(w * h * 4);
  let seed = 246813579;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const q = (): number => Math.floor(rnd() * levels) * Math.floor(256 / levels);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = q();
    data[i * 4 + 1] = q();
    data[i * 4 + 2] = q();
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: w, height: h, data });
}

// read_file 在 SANDBOX_PATH_TOOLS 里:生产路径由 enforceSandbox 把相对 path 重写成牢内绝对路径。
// 直接调 execute() 会绕过这步、用 process.cwd()(= 仓库根)解析相对路径而找不到文件,
// 所以走 executeToolOutcome 以真实链路(含沙箱重写)验证。
//
// 沙箱根在**每次调用点**现场设置而不是文件级 before():共享进程
// (--experimental-test-isolation=none)下所有文件的 before() 先于任何测试执行,
// 后加载的文件(如 sandbox.test.ts)会覆盖全局根,本文件的测试就会在别人的 tmp 根里找文件。
// save/restore 而非清 null:清 null 会让其它文件的 jailResolve 兜底到 cwd。
function inRoot<T>(run: () => Promise<T>): Promise<T> {
  const prev = setSandboxRoot(root);
  return run().finally(() => setSandboxRoot(prev));
}

async function runRead(args: Record<string, unknown>): Promise<ToolOutcome> {
  return inRoot(() => executeToolOutcome('read_file', JSON.stringify(args)));
}

/** view_image 的四个原用例已并入 read_file:魔数嗅探分流后行为等价(降采样/越界拒绝)。 */
async function runView(args: Record<string, unknown>): Promise<ToolOutcome> {
  return runRead(args);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mocode-read-sniff-'));
  mkdirSync(join(root, 'assets'), { recursive: true });

  // 正常文本
  writeFileSync(join(root, 'hello.txt'), 'line one\nline two\nline three\n');
  // 空文件
  writeFileSync(join(root, 'empty.txt'), '');
  // 小 PNG(1x1 纯色,远低于内联上限)
  writeFileSync(join(root, 'assets', 'small.png'), makePngBuffer(8, 8, 2));
  // 无扩展名的 PNG(魔数嗅探的主场景:截图缓存 / 构建产物)
  writeFileSync(join(root, 'assets', 'no-ext-blob'), makePngBuffer(8, 8, 2));
  // 错扩展名:文本文件挂 .png(必须按内容判成文本,不能只看扩展名)
  writeFileSync(join(root, 'assets', 'lie.png'), 'this is actually plain text\nsecond line\n');
  // 错扩展名:PNG 挂 .bin
  writeFileSync(join(root, 'assets', 'misnamed.bin'), makePngBuffer(8, 8, 2));
  // 纯二进制(非图片):ELF 头 + 控制字符
  writeFileSync(
    join(root, 'assets', 'program.bin'),
    Buffer.concat([Buffer.from('\x7fELF\x02\x01\x01\x00'), Buffer.alloc(64, 0x00)]),
  );
  // 超限 PNG:3000x950、8 级量化 ≈ 4.5 MiB(> 4 MiB 内联上限;降采样到长边 1568 后 ≈ 1.3 MiB)
  writeFileSync(join(root, 'assets', 'oversized.png'), makePngBuffer(3000, 950, 8));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── 纯函数层 ──────────────────────────────────────────────────────────────

test('sniffImageMime: 按魔数识别 PNG/JPEG/GIF/WebP,文本与未知二进制返回 null', () => {
  assert.equal(sniffImageMime(readFileSync(join(root, 'assets', 'small.png'))), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('GIF89a....', 'latin1')), 'image/gif');
  assert.equal(
    sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    'image/webp',
  );
  assert.equal(sniffImageMime(Buffer.from('plain text file content', 'utf8')), null);
  assert.equal(sniffImageMime(readFileSync(join(root, 'assets', 'program.bin'))), null);
});

test('isProbablyBinary: 控制字符命中,普通文本/制表符/换行不误伤', () => {
  assert.equal(isProbablyBinary(Buffer.from('const a = 1;\n\treturn a;\r\n')), false);
  assert.equal(isProbablyBinary(Buffer.from('\x00\x01\x02')), true);
  assert.equal(isProbablyBinary(readFileSync(join(root, 'assets', 'program.bin'))), true);
  // 与 grep 同款口径:C0 控制字符(放行 \t\n\r)
  assert.equal(isProbablyBinary(Buffer.from([0x09, 0x0a, 0x0d])), false);
});

test('IMAGE_READ_MARKER: read-file.ts 再导出与 constants.ts 单一事实源一致', () => {
  assert.equal(IMAGE_READ_MARKER, MARKER_FROM_CONSTANTS);
});

// ── read_file 分流 ────────────────────────────────────────────────────────

test('read_file: 文本文件仍走行号分页 + artifact header(hash 口径不变)', async () => {
  const outcome = await runRead({ path: 'hello.txt' });
  assert.equal(outcome.status, 'success');
  // executeToolOutcome 会把相对 path 重写成牢内绝对路径,header 里以绝对路径为准。
  assert.match(outcome.output, /^\[artifact source=read_file path=.*hello\.txt hash=sha256:[a-f0-9]{64}\]/);
  assert.match(outcome.output, /^\s{5}1\tline one$/m);
  assert.equal(outcome.modelAttachments, undefined, '文本读取不应产生视觉附件');
});

test('read_file: 空文件报「(空文件)」而不是失败', async () => {
  const outcome = await runRead({ path: 'empty.txt' });
  assert.equal(outcome.status, 'success');
  assert.match(outcome.output, /\(空文件\)/);
});

test('read_file: PNG 走视觉通道(带 modelAttachments),output 只有可读摘要', async () => {
  const outcome = await runRead({ path: 'assets/small.png' });
  assert.equal(outcome.status, 'success');
  assert.ok(outcome.output.startsWith(IMAGE_READ_MARKER));
  assert.match(outcome.output, /image\/png/);
  assert.equal(outcome.modelAttachments?.length, 1);
  assert.equal(outcome.modelAttachments?.[0].type, 'image');
  assert.equal(outcome.modelAttachments?.[0].mime, 'image/png');
  assert.match(outcome.modelAttachments?.[0].dataUrl ?? '', /^data:image\/png;base64,/);
  // 视觉内容不得泄漏进文本 output(否则 base64 会灌爆 history)。
  assert.ok(outcome.output.length < 500, 'output 只能是摘要,不能含 base64');
});

test('read_file: 无扩展名 PNG 靠魔数嗅探照样走视觉通道', async () => {
  const outcome = await runRead({ path: 'assets/no-ext-blob' });
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.modelAttachments?.length, 1, '魔数嗅探是主场景:扩展名会说谎');
});

test('read_file: 错扩展名(文本挂 .png)按内容判成文本,不硬塞视觉通道', async () => {
  const outcome = await runRead({ path: 'assets/lie.png' });
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.modelAttachments, undefined);
  assert.match(outcome.output, /^\s{5}1\tthis is actually plain text$/m);
});

test('read_file: 错扩展名(PNG 挂 .bin)按魔数判成图片', async () => {
  const outcome = await runRead({ path: 'assets/misnamed.bin' });
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.modelAttachments?.length, 1);
});

test('read_file: 非图片二进制被拒绝并指路,不往 history 灌乱码', async () => {
  const outcome = await runRead({ path: 'assets/program.bin' });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'INVALID_ARGUMENTS');
  assert.match(outcome.output, /^错误:/);
  assert.match(outcome.output, /二进制/);
  assert.match(outcome.output, /run_command/, '必须给出可行的替代路径');
  assert.equal(outcome.modelAttachments, undefined);
  // 关键回归:输出里不得含 U+FFFD 乱码。
  assert.ok(!outcome.output.includes('\uFFFD'));
});

test('read_file: 目录给出 glob/grep 指路;不存在的文件报 ENOENT 语义', async () => {
  const dir = await runRead({ path: 'assets' });
  assert.equal(dir.status, 'error');
  assert.equal(dir.code, 'INVALID_ARGUMENTS');
  assert.match(dir.output, /glob/, '目录应指路 glob');

  const missing = await runRead({ path: 'no-such-file.ts' });
  assert.equal(missing.status, 'error');
  assert.match(missing.output, /文件不存在/);
});

test('read_file: 图片分支说明 offset/limit 不适用 + detail 透传', async () => {
  const outcome = await runRead({ path: 'assets/small.png', offset: 5, limit: 10, detail: 'low' });
  assert.equal(outcome.status, 'success');
  assert.match(outcome.output, /offset\/limit do not apply/);
  assert.equal(outcome.modelAttachments?.[0].detail, 'low');
});

// ── view_image 降采样兜底 ─────────────────────────────────────────────────

test('loadImageAttachmentWithDownscale: 超限 PNG 自动降采样成功(原图 >4MiB → 长边 1568)', async () => {
  const original = readFileSync(join(root, 'assets', 'oversized.png'));
  assert.ok(original.length > MAX_INLINE_BYTES_DEFAULT, `样本必须超过内联上限,实际 ${original.length}`);

  const loaded = await inRoot(() =>
    loadImageAttachmentWithDownscale('assets/oversized.png', {
      maxBytes: MAX_INLINE_BYTES_DEFAULT,
    }),
  );
  assert.equal(loaded.ok, true, `降采样兜底应成功: ${loaded.ok ? '' : loaded.reason}`);
  if (!loaded.ok) return;
  assert.ok(loaded.att.bytes <= MAX_INLINE_BYTES_DEFAULT);
  assert.ok(loaded.downscaledFrom, '必须报告原图尺寸(用户/模型需要知道发生了降采样)');
  assert.equal(loaded.downscaledFrom?.width, 3000);
  assert.equal(loaded.downscaledFrom?.height, 950);
  assert.equal(loaded.att.mime, 'image/png');
  // 磁盘原图不被改写:降采样只发生在回灌的副本上。
  assert.equal(readFileSync(join(root, 'assets', 'oversized.png')).length, original.length);
});

test('view_image: 超限 PNG 不再拒绝,返回成功 + downscaled 说明', async () => {
  const outcome = await runView({ path: 'assets/oversized.png' });
  assert.equal(outcome.status, 'success');
  assert.match(outcome.output, /downscaled/i);
  assert.equal(outcome.modelAttachments?.length, 1);
  assert.ok(outcome.output.length < 500, 'output 只能是摘要');
});

test('view_image: 正常小图直接成功,不带 downscaled 说明', async () => {
  const outcome = await runView({ path: 'assets/small.png' });
  assert.equal(outcome.status, 'success');
  assert.ok(!/downscaled/i.test(outcome.output));
  assert.equal(outcome.modelAttachments?.length, 1);
});

test('view_image: 超限的非 PNG 仍拒绝,并说明降采样只支持 PNG(诚实声明能力边界)', async () => {
  // 造一个 >4MiB 的"JPEG"(仅扩展名;魔数不是真 JPEG 也无妨,loadImageAttachment 走扩展名)
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024, 0x41)]);
  writeFileSync(join(root, 'assets', 'huge.jpg'), big);
  const outcome = await runView({ path: 'assets/huge.jpg' });
  assert.equal(outcome.status, 'error');
  assert.match(outcome.output, /too large/);
  assert.match(outcome.output, /PNG/, '必须说明自动降采样只覆盖 PNG');
});

test('view_image(并入 read_file): 越界路径按 SANDBOX_DENIED 拒绝', async () => {
  // 直调 execute 时是 error;走 executeToolOutcome(真实链路)时沙箱前置拦截为 denied。
  // 语义相同:都被拒绝且 code=SANDBOX_DENIED。
  const outcome = await runView({ path: '../outside-never-exists.png' });
  assert.ok(outcome.status === 'error' || outcome.status === 'denied');
  assert.equal(outcome.code, 'SANDBOX_DENIED');
});

// ── TUI 摘要 ─────────────────────────────────────────────────────────────

test('summarizeToolResult: read_file 图片分支显示「图片已附加」而非「N 行」', async () => {
  // 断言对齐 t() 本身:i18n 默认 en、且共享进程下 i18n-language.test.ts 会重置语言,
  // 写死中文串只在「config 恰好是 zh-CN 且加载顺序凑巧」时通过 —— 那正是 409/410 假失败的根因。
  const outcome = await runRead({ path: 'assets/small.png' });
  const summary = summarizeToolResult('read_file', outcome.output);
  assert.equal(summary, t('toolSummary.imageAttached'));
  // 文本分支仍显示行数:hello.txt = 3 行 + 尾换行 → 渲染 header + L1..L4(空行 4 也计入非空)= 5。
  const text = await runRead({ path: 'hello.txt' });
  assert.equal(summarizeToolResult('read_file', text.output), t('toolSummary.lines', { count: 5 }));
});
