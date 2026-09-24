/**
 * grep 上下文行(context)+ 缩进保真 + 体积闸门 + searchEncoder 折叠兼容。
 *
 * 背景:命中行不带邻居时,几乎每次 grep 后都要跟一次 read_file 定位上下文 —— 双倍往返。
 * 旧实现还把命中行 trim() 掉,代码层级信息一并丢失。本文件锁住这两处行为。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from '../src/tools/builtins/grep.js';
import { searchEncoder } from '../src/context/encoders/search.js';
import { summarizeToolResult } from '../src/ui/render.js';
import { t } from '../src/i18n/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mocode-grep-ctx-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // 缩进敏感样本:命中行必须能看出嵌套层级。
  writeFileSync(
    join(root, 'src', 'nested.ts'),
    [
      'export function outer() {',
      '  if (ready) {',
      '    const value = compute();',
      '    return value;',
      '  }',
      '  return null;',
      '}',
    ].join('\n'),
  );
  // 两处相距较远的命中:验证 `  --` 分块分隔。
  writeFileSync(
    join(root, 'src', 'spread.ts'),
    Array.from({ length: 30 }, (_, i) => (i === 2 || i === 20 ? 'target line here' : `filler ${i}`)).join('\n'),
  );
  writeFileSync(join(root, 'src', 'huge.txt'), 'NEEDLE\n'.repeat(1) + 'x'.repeat(4 * 1024 * 1024));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * grep 不接受 root 参数,它读全局 sandboxRoot(getSandboxRoot() ?? process.cwd())。
 * 共享进程(--experimental-test-isolation=none)下所有文件的 before() 先于任何测试执行,
 * 文件级 setSandboxRoot 会被后加载的文件覆盖 —— 表现为本文件的测试在别人的 tmp 根里搜,
 * 得到「无匹配(扫描了 0 个文件)」假失败。故每次调用都现场设根、用完即还原(save/restore,
 * 不清 null:清 null 会让其它文件的 jailResolve 兜底到 cwd)。
 */
async function run(args: Record<string, unknown>): Promise<string> {
  const prev = setSandboxRoot(root);
  try {
    const out = await grepTool.execute(args);
    return typeof out === 'string' ? out : out.output;
  } finally {
    setSandboxRoot(prev);
  }
}

test('grep context: 邻居行内联返回,省掉 grep→read_file 的往返', async () => {
  const out = await run({ pattern: 'const value = compute', glob: 'src/nested.ts', context: 2 });
  assert.match(out, /src\/nested\.ts: 1 处匹配,行号 \[3\]/);
  // 行格式 = 2 空格缩进 + `L<n>` + 命中`:`/邻居`-` + 1 空格分隔 + **未 trim 的原文**。
  assert.match(out, /^ {2}L3: {5}const value = compute\(\);$/m);
  assert.match(out, /^ {2}L2- {3}if \(ready\) \{$/m);
  assert.match(out, /^ {2}L1- export function outer\(\) \{$/m);
  assert.match(out, /^ {2}L4- {5}return value;$/m);
  assert.match(out, /^ {2}L5- {3}\}$/m);
});

test('grep context: 命中行保留原始缩进(旧实现 trim() 会丢层级)', async () => {
  const withoutCtx = await run({ pattern: 'return value', glob: 'src/nested.ts' });
  // 4 个空格缩进必须逐字保留:这是「不 trim」的核心断言。
  assert.match(withoutCtx, /^ {2}L4: {5}return value;$/m);
  assert.ok(!/^ {2}L4: return value;$/m.test(withoutCtx), '命中行不应被 trim');
});

test('grep context: 默认 context=0 时行为与旧版一致(只有命中行)', async () => {
  const out = await run({ pattern: 'return null', glob: 'src/nested.ts' });
  assert.match(out, /^ {2}L6: {3}return null;$/m);
  assert.ok(!/L5/.test(out), 'context=0 不应输出邻居行');
  assert.ok(!/^ {2}--$/m.test(out), 'context=0 不应输出分块分隔符');
});

test('grep context: 两处相距较远的命中用 `  --` 分块,不输出中间全部行', async () => {
  const out = await run({ pattern: 'target line here', glob: 'src/spread.ts', context: 1 });
  assert.match(out, /行号 \[3, 21\]/);
  assert.equal(out.split('\n').filter((l) => l.trim() === '--').length, 1, '两个分块之间应有且只有一个分隔符');
  // 中间的 filler 行不该出现(否则 context 就退化成整文件输出)。
  assert.ok(!/filler 10/.test(out));
});

test('grep context: 非法/越界值钳制(负数→0,超大→10,NaN→0)', async () => {
  const neg = await run({ pattern: 'return value', glob: 'src/nested.ts', context: -5 });
  assert.ok(!/L5/.test(neg), '负 context 应按 0 处理');
  const huge = await run({ pattern: 'return value', glob: 'src/nested.ts', context: 9999 });
  assert.match(huge, /^ {2}L1- export function outer\(\) \{$/m, '超大 context 应钳到文件边界内');
  const nan = await run({ pattern: 'return value', glob: 'src/nested.ts', context: 'abc' });
  assert.ok(!/L5/.test(nan), 'NaN context 应按 0 处理');
});

test('grep: 超过体积闸门的文件被跳过并显式报出(不静默吞)', async () => {
  const out = await run({ pattern: 'NEEDLE', glob: 'src/huge.txt' });
  assert.match(out, /无匹配/, '2MiB 以上文件应被跳过,不产出命中');
  assert.match(out, /跳过 1 个超过 2MiB 的文件/, '必须告知模型有文件被跳过,否则它以为真的没有匹配');
});

test('grep: 二进制文件仍然跳过(与 read_file 共用 isProbablyBinary)', async () => {
  writeFileSync(join(root, 'src', 'blob.bin'), Buffer.concat([Buffer.from('NEEDLE'), Buffer.from([0x00, 0x01, 0x02])]));
  const out = await run({ pattern: 'NEEDLE', glob: 'src/*' });
  assert.ok(!/blob\.bin:/.test(out), '二进制文件不应产出命中');
});

test('searchEncoder: Cold 折叠同时吃掉 context 行与 `  --` 分隔符,只留头部', () => {
  const grepOutput = [
    'src/nested.ts: 1 处匹配,行号 [3]',
    '  L1- export function outer() {',
    '  L2-   if (ready) {',
    '  L3:     const value = compute();',
    '  L4-     return value;',
    '  --',
    '  L9-   other();',
  ].join('\n');
  const encoded = searchEncoder.encode({
    toolName: 'grep',
    output: grepOutput,
    args: null,
    phase: 'sweep',
    isCold: true,
    age: 3,
  });
  assert.equal(encoded.text, 'src/nested.ts: 1 处匹配,行号 [3]');
  assert.match(encoded.meta?.note ?? '', /1 files/);
  // Warm 阶段必须原样透传:context 行是模型正在用的证据。
  const warm = searchEncoder.encode({
    toolName: 'grep',
    output: grepOutput,
    args: null,
    phase: 'push',
    isCold: false,
    age: 0,
  });
  assert.equal(warm.text, grepOutput);
});

test('summarizeToolResult: grep 摘要按头部命中数求和,带 context 时不再虚高', () => {
  // 断言对齐 t() 本身:默认语言是 en,写死中文串会因加载顺序而假失败(见 read-file-sniff 同款修复)。
  const withContext = [
    'src/a.ts: 2 处匹配,行号 [3, 9]',
    '  L2- b',
    '  L3: hit',
    '  L4- c',
    '  --',
    '  L8- y',
    '  L9: hit',
    '  L10- z',
    'src/b.ts: 1 处匹配,行号 [1]',
    '  L1: hit',
  ].join('\n');
  assert.equal(summarizeToolResult('grep', withContext), t('toolSummary.matches', { count: 3 }));
  assert.equal(summarizeToolResult('grep', '无匹配(扫描了 12 个文件)'), t('toolSummary.noMatches'));
});
