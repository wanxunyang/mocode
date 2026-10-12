/** read_file 工具级重复读三场景测试(#token-efficiency P2)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from '../src/tools/builtins/read-file.js';
import { createReadDedup } from '../src/tools/read-dedup.js';
import { config } from '../src/config/index.js';
import { MAX_HISTORY_RESULT } from '../src/tools/constants.js';
import type { ToolContext, ToolOutcome } from '../src/tools/types.js';

async function executeRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const r = await readFileTool.execute(args, ctx);
  return typeof r === 'string' ? ({ status: 'success', code: 'OK', retryable: false, output: r } as ToolOutcome) : r;
}

test('read_file: 连读返指针 → 编辑后返全文 → compact 后返全文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mocode-read-'));
  const file = join(dir, 'a.ts');
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  writeFileSync(file, content);

  const savedDedup = config.readDedup;
  config.readDedup = true;
  const dedup = createReadDedup();
  const toolCtx: ToolContext = { readDedup: dedup };
  try {
    dedup.beginStep(0);
    const first = await executeRead({ path: file, offset: 1, limit: 50 }, toolCtx);
    assert.match(first.output, /line 1/);
    assert.doesNotMatch(first.output, /unchanged since/);

    // 场景 1:同区间连读 → 短指针。
    dedup.beginStep(1);
    const again = await executeRead({ path: file, offset: 1, limit: 50 }, toolCtx);
    assert.match(again.output, /unchanged since step 0/);
    assert.doesNotMatch(again.output, /line 1\nline 2/);

    // 场景 2:编辑后 hash 变化 → 全文。
    writeFileSync(file, `${content}\nline 51`);
    const edited = await executeRead({ path: file, offset: 1, limit: 51 }, toolCtx);
    assert.match(edited.output, /line 51/);
    assert.doesNotMatch(edited.output, /unchanged since/);

    // 场景 3:trim 变更内容后 hot 失活 → 全文。
    dedup.markContextChanged();
    const afterCompact = await executeRead({ path: file, offset: 1, limit: 51 }, toolCtx);
    assert.match(afterCompact.output, /line 1/);
    assert.doesNotMatch(afterCompact.output, /unchanged since/);
  } finally {
    config.readDedup = savedDedup;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: 无 ToolContext(直接调用)时不短路, 正常返全文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mocode-read2-'));
  const file = join(dir, 'b.ts');
  writeFileSync(file, 'hello world');

  const savedDedup = config.readDedup;
  config.readDedup = true;
  try {
    const r1 = await executeRead({ path: file }, {});
    assert.match(r1.output, /hello world/);
    const r2 = await executeRead({ path: file }, {});
    assert.match(r2.output, /hello world/);
    assert.doesNotMatch(r2.output, /unchanged since/);
  } finally {
    config.readDedup = savedDedup;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: config.readDedup=false 时即使有 scope 也不短路', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mocode-read3-'));
  const file = join(dir, 'c.ts');
  writeFileSync(file, 'foo bar baz');

  const savedDedup = config.readDedup;
  config.readDedup = false;
  const dedup = createReadDedup();
  const toolCtx: ToolContext = { readDedup: dedup };
  try {
    dedup.beginStep(0);
    const r1 = await executeRead({ path: file }, toolCtx);
    assert.match(r1.output, /foo bar baz/);
    dedup.beginStep(1);
    const r2 = await executeRead({ path: file }, toolCtx);
    assert.match(r2.output, /foo bar baz/);
    assert.doesNotMatch(r2.output, /unchanged since/);
  } finally {
    config.readDedup = savedDedup;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: 输出超 MAX_HISTORY_RESULT 将被中截时, dedup 只登记头/尾保留段, 中段重读不再被幽灵命中', async () => {
  // 复现事故会话 20261012-033757:大文档一次读大段(输出远超 cap),
  // pushToolResult 中截丢中段后,模型重读中段区间被 findUnchanged 命中拿不到内容。
  // 内容体量按 MAX_HISTORY_RESULT 常量等比放大,避免 cap 调整后测试失效。
  const dir = mkdtempSync(join(tmpdir(), 'mocode-read-ghost-'));
  const file = join(dir, 'big.md');
  // 行数取「2.5 倍 cap 所需行数」,确保输出显著超 cap(中截后中段不进 context)。
  const linesNeeded = Math.ceil((MAX_HISTORY_RESULT * 2.5) / 80);
  const content = Array.from({ length: linesNeeded }, (_, i) => `line ${i + 1}: ${'x'.repeat(72)}`).join('\n');
  writeFileSync(file, content);

  const savedDedup = config.readDedup;
  config.readDedup = true;
  const dedup = createReadDedup();
  const toolCtx: ToolContext = { readDedup: dedup };
  try {
    // step 0: 全量读,输出远超 cap。
    dedup.beginStep(0);
    const first = await executeRead({ path: file, offset: 1, limit: linesNeeded }, toolCtx);
    assert.ok(first.output.length > MAX_HISTORY_RESULT, `预期超 cap,实际 ${first.output.length}`);

    // step 1: 重读「中段」——修复前这里会被幽灵命中返回 unchanged,修复后应全量返回。
    // 中段起点取 50% 处,必在 truncateMid 丢弃区(头 60% 保留按字符而非行,中点行必在其中段之后)。
    const midStart = Math.floor(linesNeeded / 2);
    dedup.beginStep(1);
    const mid = await executeRead({ path: file, offset: midStart, limit: 80 }, toolCtx);
    assert.doesNotMatch(mid.output, /unchanged since/);
    assert.match(mid.output, new RegExp(`line ${midStart}:`));
    assert.ok(mid.output.length < MAX_HISTORY_RESULT, `step1 区间应在 cap 内,实际 ${mid.output.length}`);

    // step 2: 重读 step1 已真实登记的区间 → 允许命中。
    dedup.beginStep(2);
    const head = await executeRead({ path: file, offset: midStart, limit: 80 }, toolCtx);
    assert.match(head.output, /unchanged since step 1/);
  } finally {
    config.readDedup = savedDedup;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: 超长输出后,头尾保留段之内的重读仍正常短路', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mocode-read-ghost2-'));
  const file = join(dir, 'big2.md');
  // 体量按 MAX_HISTORY_RESULT 等比放大(80 字符/行),避免 cap 调整后测试失效。
  const linesNeeded = Math.ceil((MAX_HISTORY_RESULT * 2.5) / 80);
  const content = Array.from({ length: linesNeeded }, (_, i) => `line ${i + 1}: ${'y'.repeat(72)}`).join('\n');
  writeFileSync(file, content);

  const savedDedup = config.readDedup;
  config.readDedup = true;
  const dedup = createReadDedup();
  const toolCtx: ToolContext = { readDedup: dedup };
  try {
    dedup.beginStep(0);
    await executeRead({ path: file, offset: 1, limit: linesNeeded }, toolCtx);

    // 头段(保留区约前 60% × cap 字符 ÷ 80 字符/行,取保守小区间)。
    const headKeepLines = Math.floor((MAX_HISTORY_RESULT * 0.6) / 80) - 5;
    dedup.beginStep(1);
    const headReread = await executeRead({ path: file, offset: 2, limit: 3 }, toolCtx);
    assert.ok(headKeepLines > 3, `cap 变得过小导致头段保留区不足: ${headKeepLines}`);
    assert.match(headReread.output, /unchanged since step 0/);

    // 尾段(保留区约后 40% × cap 字符 ÷ 80 字符/行,取保守小区间)。
    const tailKeepLines = Math.floor((MAX_HISTORY_RESULT * 0.4) / 80) - 5;
    assert.ok(tailKeepLines > 3, `cap 变得过小导致尾段保留区不足: ${tailKeepLines}`);
    const tailReread = await executeRead({ path: file, offset: linesNeeded - 2, limit: 3 }, toolCtx);
    assert.match(tailReread.output, /unchanged since step 0/);
  } finally {
    config.readDedup = savedDedup;
    rmSync(dir, { recursive: true, force: true });
  }
});
