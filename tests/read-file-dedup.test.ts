/** read_file 工具级重复读三场景测试(#token-efficiency P2)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from '../src/tools/builtins/read-file.js';
import { createReadDedup } from '../src/tools/read-dedup.js';
import { config } from '../src/config/index.js';
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
