/**
 * grep 回捞 .mocode(被 .gitignore 忽略)的护栏:
 *  .mocode/ 在 .gitignore 里,rg 默认(含 --no-require-git)会整目录跳过;
 *  glob 显式限定到 .mocode 时必须自动 --no-ignore-vcs,否则零文件退出
 *  ("No files were searched" 曾被误报成非法正则)。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from '../src/tools/builtins/grep.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mocode-grep-mocode-'));
  // 非 git 目录:rg 靠 --no-require-git 仍读这份 .gitignore。
  writeFileSync(join(root, '.gitignore'), '.mocode/\n');
  const dir = join(root, '.mocode', 'sessions', 's1', 'compacted');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'seg-001.md'),
    ['# seg', '### [turn 1] tool_result call=c1 tool=run_command', 'NEEDLE-ARCHIVED-42 ok'].join('\n'),
  );
  // 对照:普通仓库文件里也放一个同名串,证明 glob 限定确实只搜 .mocode。
  writeFileSync(join(root, 'other.txt'), 'NEEDLE-ARCHIVED-42 outside');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(args: Record<string, unknown>): Promise<string> {
  const prev = setSandboxRoot(root);
  try {
    const out = await grepTool.execute(args);
    return typeof out === 'string' ? out : out.output;
  } finally {
    setSandboxRoot(prev);
  }
}

test('grep glob 限定 .mocode 时能搜到 gitignore 内的压缩归档', async () => {
  const out = await run({ pattern: 'NEEDLE-ARCHIVED-42', glob: '.mocode/sessions/**' });
  assert.match(out, /seg-001\.md/, '应命中归档段文件');
  assert.ok(!/非法正则|No files were searched/.test(out), '不应误报正则/过滤器错误');
  assert.ok(!out.includes('other.txt'), 'glob 限定在 .mocode,不应扫到外部文件');
});

test('grep 无 glob 时遵守 .gitignore,不扫 .mocode', async () => {
  const out = await run({ pattern: 'NEEDLE-ARCHIVED-42' });
  assert.ok(!out.includes('seg-001.md'), '默认搜索必须遵守 .gitignore');
  assert.match(out, /other\.txt/, '仓库内普通文件仍可搜');
});
