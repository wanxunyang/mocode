// P2 #8/#9 验证:worktree patch 导出(git 集成)+ unifiedFileDiff 纯函数。
// exportWorktreePatch 用真实临时 git 仓(Windows 有 git 即可);diff 纯函数无 I/O。
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unifiedFileDiff } from '../src/repl/commands/diff.js';
import { createWorktree, exportWorktreePatch, removeWorktree } from '../src/jobs/worktree.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
import '../src/tools/builtins/index.js';

function gitInit(repo: string): void {
  execFileSync('git', ['init'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@mocode.local'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, windowsHide: true });
}

test('unifiedFileDiff: 中段修改 → 单 hunk 先删后加 + 上下文 3 行', () => {
  const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n');
  const after = ['l1', 'l2', 'l3', 'l4x', 'l5', 'l6', 'l7', 'l8'].join('\n');
  const diff = unifiedFileDiff('a.txt', before, after);
  const lines = diff.split('\n');
  assert.ok(lines[0] === '--- a/a.txt');
  assert.ok(lines[1] === '+++ b/a.txt');
  assert.ok(lines[2].startsWith('@@ -1,'));
  // 上下文 3 行 + -l4 +l4x
  assert.ok(lines.includes(' l1'));
  assert.ok(lines.includes(' l3'));
  assert.ok(lines.includes('-l4'));
  assert.ok(lines.includes('+l4x'));
  assert.ok(!lines.includes('-l5') && !lines.includes('+l5'));
});

test('unifiedFileDiff: 新建文件(before=null)全部为 + 行', () => {
  const diff = unifiedFileDiff('new.txt', null, 'a\nb');
  const lines = diff.split('\n');
  assert.ok(lines.some((l) => l === '+a'));
  assert.ok(lines.some((l) => l === '+b'));
  assert.ok(!lines.some((l) => l.startsWith('-') && !l.startsWith('---')));
});

test('unifiedFileDiff: 删除文件(after=null)全部为 - 行', () => {
  const diff = unifiedFileDiff('gone.txt', 'x\ny', null);
  assert.ok(diff.split('\n').some((l) => l === '-x'));
  assert.ok(diff.split('\n').some((l) => l === '-y'));
});

test('unifiedFileDiff: 文本相同(指纹差异假阳性)返回空串', () => {
  assert.equal(unifiedFileDiff('same.txt', 'a\nb', 'a\nb'), '');
  assert.equal(unifiedFileDiff('same.txt', null, null), '');
});

test('unifiedFileDiff: 追加行只在尾部出现 + 区', () => {
  const diff = unifiedFileDiff('app.txt', 'a\nb\nc', 'a\nb\nc\nd\ne');
  const lines = diff.split('\n');
  assert.ok(lines.includes('+d'));
  assert.ok(lines.includes('+e'));
  assert.ok(!lines.some((l) => l === '-a' || l === '-b' || l === '-c'));
});

test('exportWorktreePatch: 未跟踪/已修改/二进制全部进 patch,无改动返回 null', () => {
  const repo = mkdtempSync(join(tmpdir(), 'mocode-wt-patch-'));
  const prevRoot = process.cwd();
  const prevSandbox = setSandboxRoot(repo); // 全局单例:测试结束必须 restore(共享进程)
  try {
    gitInit(repo);
    writeFileSync(join(repo, 'base.txt'), 'committed\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true });

    // 无改动 → null
    process.chdir(repo);
    setSandboxRoot(repo);
    const wt = createWorktree();
    try {
      assert.equal(exportWorktreePatch(wt), null);

      // worktree 内:改已跟踪 + 新建未跟踪 + 新建二进制
      writeFileSync(join(wt.path, 'base.txt'), 'committed\nmodified\n', 'utf8');
      writeFileSync(join(wt.path, 'new-file.txt'), 'brand new\n', 'utf8');
      writeFileSync(join(wt.path, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]), 'binary');

      const patch = exportWorktreePatch(wt);
      assert.ok(patch !== null, '有改动必须导出 patch');
      // 已跟踪修改:unified diff 文本
      assert.match(patch, /modified/);
      // 未跟踪新文件经 add -N 进 diff
      assert.match(patch, /new-file\.txt/);
      assert.match(patch, /brand new/);
      // 二进制走 --binary(GIT binary patch 标记)
      assert.match(patch, /GIT binary patch/);

      // git apply 可干净套用(核心可用性判据):在主仓重置改动后 apply
      // —— 直接在主仓 apply 到干净状态验证格式合法性。
      const patchFile = join(repo, 'test.patch');
      writeFileSync(patchFile, patch, 'utf8');
      execFileSync('git', ['apply', '--check', patchFile], { cwd: repo, windowsHide: true });
    } finally {
      removeWorktree(wt);
    }
  } finally {
    process.chdir(prevRoot);
    setSandboxRoot(prevSandbox);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('headless worktree 收尾导出:removeWorktree 后 patch 落 .mocode/jobs/ 且内容可套用', () => {
  // 直接验证 headless finally 段的行为要素(不起 LLM):create → 改 → export → remove,
  // patch 文件写盘 + updateJob patchPath 字段由 runHeadless 集成路径覆盖(需真实 LLM,
  // 此处只验证导出/落盘/可 apply 的核心链路,与上一用例组合即完整覆盖)。
  const repo = mkdtempSync(join(tmpdir(), 'mocode-wt-export-'));
  const prevRoot = process.cwd();
  const prevSandbox = setSandboxRoot(repo);
  try {
    gitInit(repo);
    writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true });

    process.chdir(repo);
    setSandboxRoot(repo);
    const wt = createWorktree();
    try {
      writeFileSync(join(wt.path, 'README.md'), 'hello world\n', 'utf8');
      const patch = exportWorktreePatch(wt);
      assert.ok(patch !== null);
      // 模拟 headless 落盘路径:.mocode/jobs/<id>.patch
      const patchFile = join(repo, '.mocode', 'jobs', '20260930-000000-ab.patch');
      mkdirSync(join(repo, '.mocode', 'jobs'), { recursive: true });
      writeFileSync(patchFile, patch, 'utf8');
      const written = readFileSync(patchFile, 'utf8');
      assert.match(written, /hello world/);
      execFileSync('git', ['apply', '--check', patchFile], { cwd: repo, windowsHide: true });
    } finally {
      removeWorktree(wt);
    }
  } finally {
    process.chdir(prevRoot);
    setSandboxRoot(prevSandbox);
    rmSync(repo, { recursive: true, force: true });
  }
});
