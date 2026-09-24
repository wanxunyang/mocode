/**
 * shell 选择器(runtime/shell.ts)单测。
 *
 * 背景:run_command / dev_server 旧实现把 shell 硬编码成「win32 → cmd.exe,其余 → bash」。
 * Windows 上模型被迫写 cmd 语法(LLM 训练分布压倒性偏 POSIX/pwsh),且非交互 cmd 有
 * `timeout /t` 直接失败这类暗坑。现给模型显式 shell 参数,并把 Windows 默认改成 Git Bash 优先。
 *
 * 纯函数测试:parseShellKind / shellSpawnSpec / defaultShellKind 的映射,不真起子进程。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseShellKind,
  shellSpawnSpec,
  defaultShellKind,
  windowsGitBash,
  SHELL_PARAM_DESCRIPTION,
  SHELL_KINDS,
} from '../src/runtime/shell.js';
import { runCommandRaw } from '../src/tools/builtins/run-command.js';

// ── parseShellKind ────────────────────────────────────────────────────────

test('parseShellKind: 合法值 + 别名 + 大小写归一', () => {
  assert.equal(parseShellKind('cmd'), 'cmd');
  assert.equal(parseShellKind('CMD.EXE'), 'cmd');
  assert.equal(parseShellKind('bash'), 'bash');
  assert.equal(parseShellKind('sh'), 'bash', 'sh 是 bash 的别名');
  assert.equal(parseShellKind('  Bash  '), 'bash', '应 trim + 小写');
  assert.equal(parseShellKind('powershell'), 'powershell');
  assert.equal(parseShellKind('pwsh'), 'powershell');
  assert.equal(parseShellKind('PowerShell.exe'), 'powershell');
});

test('parseShellKind: 非法/非字符串值返回 null(调用方据此显式报错,不静默回落)', () => {
  assert.equal(parseShellKind('fish'), null);
  assert.equal(parseShellKind('zsh'), null);
  assert.equal(parseShellKind(''), null);
  assert.equal(parseShellKind('   '), null);
  assert.equal(parseShellKind(undefined), null);
  assert.equal(parseShellKind(123), null);
  assert.equal(parseShellKind(null), null);
});

test('SHELL_KINDS: 三个受支持的值,与 schema enum 同源', () => {
  assert.deepEqual([...SHELL_KINDS], ['cmd', 'powershell', 'bash']);
  for (const kind of SHELL_KINDS) assert.equal(parseShellKind(kind), kind);
});

// ── shellSpawnSpec ────────────────────────────────────────────────────────

test('shellSpawnSpec(cmd): /d /s /c + windowsVerbatimArguments(node -e 引号化保护)', () => {
  const spec = shellSpawnSpec('cmd', 'node -e "process.exit(0)"');
  assert.equal(spec.file, 'cmd.exe');
  assert.deepEqual(spec.args, ['/d', '/s', '/c', 'node -e "process.exit(0)"']);
  assert.equal(spec.windowsVerbatimArguments, true, 'cmd 必须 verbatim,否则参数被 Node 重新引号化');
});

test('shellSpawnSpec(powershell): -NoProfile -NonInteractive -Command,不 verbatim', () => {
  const spec = shellSpawnSpec('powershell', 'Get-ChildItem');
  // Windows 用 powershell.exe(系统自带,路径无关);其余平台约定 pwsh。
  assert.equal(spec.file, process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
  assert.deepEqual(spec.args, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem']);
  assert.equal(spec.windowsVerbatimArguments, false);
});

test('shellSpawnSpec(bash): -c 单行命令,不 verbatim', () => {
  const spec = shellSpawnSpec('bash', 'echo $HOME && ls');
  assert.equal(spec.args[0], '-c');
  assert.equal(spec.args[1], 'echo $HOME && ls');
  assert.equal(spec.windowsVerbatimArguments, false);
});

// ── defaultShellKind / 探测 ────────────────────────────────────────────────

test('defaultShellKind: 保守默认 —— Windows 恒为 cmd(不静默翻解释器),非 Windows 恒为 bash', () => {
  // 关键设计:即使本机 PATH 上有 Git Bash / WSL bash,默认也不翻转 —— 翻默认是产品级破坏性变更,
  // 现有 prompt/skill/codegraph 的 .cmd 调用都假设 cmd。切换只经显式 shell 参数或 MOCODE_SHELL。
  // 注意:测试进程会经 config 链路回填 ~/.mocode/config 里的 MOCODE_SHELL(用户可能已设),
  // 断言「出厂默认」前必须先摘掉该变量,否则测试依赖外部环境是否干净。
  const saved = process.env.MOCODE_SHELL;
  try {
    delete process.env.MOCODE_SHELL;
    const kind = defaultShellKind();
    assert.equal(kind, process.platform === 'win32' ? 'cmd' : 'bash');
  } finally {
    if (saved === undefined) delete process.env.MOCODE_SHELL;
    else process.env.MOCODE_SHELL = saved;
  }
});

test('defaultShellKind: MOCODE_SHELL 显式翻转(Unix 上 cmd 无意义,忽略)', () => {
  const saved = process.env.MOCODE_SHELL;
  try {
    process.env.MOCODE_SHELL = 'powershell';
    assert.equal(defaultShellKind(), 'powershell');
    process.env.MOCODE_SHELL = 'sh';
    assert.equal(defaultShellKind(), 'bash', '别名应归一');
    process.env.MOCODE_SHELL = 'fish';
    assert.equal(defaultShellKind(), process.platform === 'win32' ? 'cmd' : 'bash', '非法值应回落保守默认');
    process.env.MOCODE_SHELL = 'cmd';
    if (process.platform === 'win32') assert.equal(defaultShellKind(), 'cmd');
    else assert.equal(defaultShellKind(), 'bash', 'Unix 上 cmd 无意义,忽略');
  } finally {
    if (saved === undefined) delete process.env.MOCODE_SHELL;
    else process.env.MOCODE_SHELL = saved;
  }
});

test('windowsGitBash: 返回值要么是存在的 bash 路径,要么 null;绝不返回 WSL(System32)的 bash', () => {
  const bash = windowsGitBash();
  if (bash === null) return; // 本机没装 Git Bash 也算合法结果
  assert.ok(!/system32|sysnative|windowsapps/i.test(bash), `绝不能把 WSL bash 当默认: ${bash}`);
  assert.match(bash.toLowerCase(), /bash\.exe$/, '应指向 bash.exe 而非 wsl.exe');
});

test('windowsGitBash: PATH 上 git.exe(自定义安装位)→ 反推 <root>\\bin\\bash.exe(本机 D:\\Git 形态)', () => {
  const bash = windowsGitBash();
  if (process.platform !== 'win32' || bash === null) return;
  // 探测到结果时,来源必须可解释:候选表标准位,或 PATH 上某 git.exe 的根下 bin/bash.exe。
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  const gitRoots = pathVar
    .split(';')
    .filter((dir) => dir && !/system32|sysnative|windowsapps/i.test(dir))
    .map((dir) => resolve(dir, '..'))
    .filter((root) => existsSync(join(root, 'cmd', 'git.exe')) || existsSync(join(root, 'bin', 'git.exe')));
  const derivable = gitRoots.some((root) => existsSync(join(root, 'bin', 'bash.exe')));
  if (derivable) {
    const fromGitRoot = gitRoots.find((root) => existsSync(join(root, 'bin', 'bash.exe')));
    assert.equal(bash, join(fromGitRoot!, 'bin', 'bash.exe'), 'PATH git.exe 存在时优先由 git 根推导');
  }
});

test('SHELL_PARAM_DESCRIPTION: 文案含三个可选值(供 run_command/dev_server schema 复用)', () => {
  for (const kind of SHELL_KINDS) assert.ok(SHELL_PARAM_DESCRIPTION.includes(kind), `缺 ${kind}`);
  assert.ok(SHELL_PARAM_DESCRIPTION.length > 40, '应是可用的完整说明而非占位');
});

// ── run_command shell 参数端到端(真起子进程,平台无关命令)──────────────────

test('runCommandRaw: 显式 shell=bash 跑 POSIX 命令成功(Windows 无 Git Bash 时跳过)', async (t) => {
  if (process.platform === 'win32' && !windowsGitBash()) {
    t.skip('本机未探测到 Git Bash,无法验证 bash 分支');
    return;
  }
  // $((1+1)) 是 POSIX 专有算术展开,cmd 解析不出来 → 能跑通即证明真的走了 bash。
  const result = await runCommandRaw('echo $((1+1))', 5000, undefined, undefined, 'bash');
  assert.equal(result.status, 'passed', `bash 分支应成功: ${result.output}`);
  assert.match(result.output, /2/);
});

test('runCommandRaw: Windows 上显式 shell=cmd 跑 cmd 专有语法(非 Windows 跳过)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('cmd.exe 专有语法测试仅在 Windows 有意义');
    return;
  }
  // %COMSPEC% 是 cmd 专有环境变量展开;bash 里 % 不是展开符 → 能展开即证明走了 cmd。
  const result = await runCommandRaw('echo %COMSPEC%', 5000, undefined, undefined, 'cmd');
  assert.equal(result.status, 'passed');
  assert.match(result.output.toLowerCase(), /cmd\.exe/, 'cmd 应展开 %COMSPEC% 到 cmd.exe 路径');
});

after(() => {
  // runCommandRaw 用例真起了子进程,但都是 echo,无残留句柄;此处无需清理。
});
