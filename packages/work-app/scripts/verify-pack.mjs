// 打包产物验收：把 runbook §9 的四条手查变成一条可重跑的命令。
//
// 为什么必须自动化：历史上有一次 @mocode/protocol 没进包，宿主在用户机器上起来即退，
// 而 `win-unpacked` 留在仓库里自测时 Node 会沿目录向上撞到仓库根 node_modules 侥幸通过 ——
// 手查很容易漏。这里把「必须在仓库外解析」这件事写死在脚本里：拷贝到系统临时目录再拉起。
//
// 用法：node scripts/verify-pack.mjs [--dir <解包目录>] [--skip-smoke]

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '..', '..');

const args = process.argv.slice(2);
const skipSmoke = args.includes('--skip-smoke');
const dirIndex = args.indexOf('--dir');
const explicitDir = dirIndex >= 0 ? args[dirIndex + 1] : undefined;

/** electron-builder 的解包目录名与可执行文件名都跟着平台走。 */
function platformLayout() {
  if (process.platform === 'win32') {
    return { unpacked: 'win-unpacked', exe: 'MoCode Work.exe' };
  }
  if (process.platform === 'darwin') {
    // arch 后缀只在 arm64 的产物目录上出现，两个都试。
    return { unpacked: ['mac-arm64', 'mac', 'mac-universal'], exe: 'MoCode Work.app/Contents/MacOS/MoCode Work' };
  }
  return { unpacked: 'linux-unpacked', exe: 'mocode-work' };
}

const layout = platformLayout();
const candidates = explicitDir
  ? [explicitDir]
  : (Array.isArray(layout.unpacked) ? layout.unpacked : [layout.unpacked]).map((name) => path.join(appRoot, 'release', name));
const unpackedDir = candidates.find((dir) => existsSync(dir));
if (!unpackedDir) {
  throw new Error(`找不到解包目录，试过：${candidates.join(', ')}（先跑 npm run pack:dir）`);
}

const resources = path.join(unpackedDir, 'resources');
const failures = [];
const ok = (message) => console.log(`  ok    ${message}`);
const bad = (message) => {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
};
const check = (condition, message) => (condition ? ok(message) : bad(message));

console.log(`[verify-pack] ${unpackedDir}`);

// ── 1. 目录分层：app.asar（壳）+ mocode-ai（宿主，必须在 asar 之外）──
console.log('\n目录分层');
check(existsSync(path.join(resources, 'app.asar')), 'resources/app.asar');
const hostRoot = path.join(resources, 'mocode-ai');
check(existsSync(hostRoot), 'resources/mocode-ai（宿主在 asar 之外，否则 spawn 无真实路径）');

// ── 2. 宿主入口三件套 + workspace 内部包 ──
console.log('\n宿主入口');
for (const relative of ['bin/mocode-agent-host.js', 'dist/host/stdio.js', 'package.json']) {
  check(existsSync(path.join(hostRoot, relative)), `mocode-ai/${relative}`);
}
// @mocode/protocol 不在 npm 闭包里（挂在根 devDependencies），靠 stage-host 扫产物导入补进去。
// 只查 protocol：host 的 dist 不 import @mocode/runtime（那是 work-app 主进程的依赖，走 app.asar）。
check(existsSync(path.join(hostRoot, 'node_modules', '@mocode', 'protocol', 'dist')), 'mocode-ai/node_modules/@mocode/protocol/dist');

// ── 3. 原生模块必须被解包（asar 里的 .node 无法 dlopen）──
// 这条以前由 build.asarUnpack 显式保证；现在依赖 electron-builder 默认的 smartUnpack
// （路径含 node_modules + 文件是 .node/.dll/.exe 或二进制无扩展名 → 自动解包）。
// 显式 asarUnpack 在 npm workspaces 下会让构建直接失败：过滤器对每个文件调
// getRelativePath，而软链的真实路径（packages/*/dist/*）既不在 appDir 下也不含
// node_modules 段 → 抛 "must be under ..."。所以这里用产物验收代替配置声明。
console.log('\n原生模块解包');
const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');
const nativeOf = (name, suffix) => {
  const root = path.join(unpackedModules, ...name.split('/'));
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) found.push(full);
    }
  };
  walk(root);
  return found;
};
const ptyNative = nativeOf('node-pty', '.node').concat(nativeOf('node-pty', '.dll'));
check(ptyNative.length > 0, `node-pty 原生件已解包（${ptyNative.length} 个）`);
if (process.platform === 'win32') {
  check(ptyNative.some((file) => /winpty|conpty/i.test(file)), 'node-pty 带 Windows 的 conpty/winpty 后端');
}
// 语音识别：sherpa-onnx-node 的 .node 在平台子包里（optionalDependencies）。
const voiceNative = nativeOf('sherpa-onnx-node', '.node')
  .concat(nativeOf('sherpa-onnx-win-x64', '.node'))
  .concat(nativeOf('sherpa-onnx-darwin-arm64', '.node'))
  .concat(nativeOf('sherpa-onnx-darwin-x64', '.node'))
  .concat(nativeOf('sherpa-onnx-linux-x64', '.node'));
check(voiceNative.length > 0, `sherpa-onnx 语音原生件已解包（${voiceNative.length} 个）`);

// ── 4. 宿主冒烟：必须在仓库外拉起，否则缺包会被上层 node_modules 掩盖 ──
if (skipSmoke) {
  console.log('\n宿主冒烟：已跳过（--skip-smoke）');
} else {
  console.log('\n宿主冒烟（仓库外）');
  const exe = path.join(unpackedDir, layout.exe);
  if (!existsSync(exe)) {
    bad(`找不到可执行文件 ${layout.exe}`);
  } else {
    const smokeRoot = mkdtempSync(path.join(os.tmpdir(), 'mocode-pack-smoke-'));
    const staged = path.join(smokeRoot, 'mocode-ai');
    try {
      cpSync(hostRoot, staged, { recursive: true });
      // 这一条是脚本的价值所在：仓库内自测会被上层 node_modules 掩盖缺包。
      // 注意跨盘符时 path.relative 返回的是绝对路径，所以不能只看它是不是以 .. 开头。
      const outside = path.relative(repoRoot, staged);
      if (!outside.startsWith('..') && !path.isAbsolute(outside)) {
        throw new Error(`冒烟目录不该在仓库内：${staged}`);
      }
      const result = await runHostSmoke(exe, path.join(staged, 'bin', 'mocode-agent-host.js'), smokeRoot);
      check(result.ok, `宿主输出 runtime_ready${result.detail ? `（${result.detail}）` : ''}`);
      if (!result.ok && result.stderr.trim()) console.log(`        stderr: ${result.stderr.trim().slice(0, 800)}`);
    } finally {
      // 清理失败不算验收失败：Windows 上新解压的 exe 常被安全软件短暂持句柄，
      // 冒烟本身已经给出结论，不能因为删临时目录而让整个打包流程报错。
      try {
        rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        console.log(`  note  临时目录稍后可手动删：${smokeRoot}`);
      }
    }
  }
}

/** 把打包的 Electron 当 node 用（ELECTRON_RUN_AS_NODE）拉起宿主，等它自报 runtime_ready。 */
function runHostSmoke(exe, hostEntry, cwd) {
  return new Promise((resolve) => {
    const child = spawn(exe, [hostEntry], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOCODE_HEADLESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // 一定要等子进程真的退出再返回：宿主占着 exe 与 node_modules，
    // 早于退出就删临时目录会 EPERM（实测踩过，force+retries 也压不住）。
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const done = () => resolve(value);
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.once('exit', done);
      try { child.kill(); } catch { done(); return; }
      // kill 之后仍不退出（被外部句柄卡住）就放行，但不再无限等。
      setTimeout(done, 3_000).unref?.();
    };
    const timer = setTimeout(() => finish({ ok: false, detail: '超时 60s 未见 runtime_ready', stderr }), 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes('runtime_ready')) return;
      // 找到那一行就够：宿主起来后会一直等 stdin，不主动退出。
      const line = stdout.split('\n').find((item) => item.includes('runtime_ready')) ?? '';
      finish({ ok: true, detail: line.trim().slice(0, 120), stderr });
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => finish({ ok: false, detail: error.message, stderr }));
    child.on('exit', (code) => {
      // 起来即退 = 缺依赖/入口错，正是这条冒烟要抓的。
      finish({ ok: false, detail: `宿主退出 code=${code}`, stderr });
    });
  });
}

// ── 5. 安装包体积（顺便当产物是否更新的证据）──
console.log('\n产物');
const installers = readdirSync(path.join(appRoot, 'release')).filter((name) => /\.(exe|dmg|AppImage|deb)$/.test(name));
if (installers.length) {
  for (const name of installers) {
    const size = statSync(path.join(appRoot, 'release', name)).size;
    ok(`${name}  ${(size / 1024 / 1024).toFixed(0)}MB`);
  }
} else {
  console.log('  （只跑了 --dir，没有安装包）');
}

if (failures.length) {
  console.error(`\n[verify-pack] ${failures.length} 项未通过`);
  process.exit(1);
}
console.log('\n[verify-pack] 全部通过');