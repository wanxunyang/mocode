// 在打包前把 agent host 摆到 resources/mocode-ai/ 该有的形状。
//
// 为什么不能交给 electron-builder 的 file 拷贝：
//   host 是**子进程**，会被以真实文件路径 spawn。asar 里的文件在 Windows 上没有真实路径，
//   spawn 必然失败 —— 所以它必须走 extraResources（asar 之外）。
//   又因为它有 67 个传递依赖，逐个列进 extraResources 不可维护，这里直接算闭包再拷。
//
// 产出目录形状（与 host-client.ts 的 hostFromElectronResources 约定一致）：
//   build/mocode-ai/
//     ├─ bin/mocode-agent-host.js      ← host 入口（resolveHostPath 定位的就是它）
//     ├─ dist/                         ← mocode-ai 编译产物（host/stdio.js 等）
//     ├─ package.json                  ← 需 name/bin 字段，供 require.resolve 与 manifest 回退读
//     └─ node_modules/                 ← 生产依赖闭包（跳过 playwright/misans，见下）

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const stageRoot = path.join(appRoot, 'build', 'mocode-ai');

/**
 * 不进包的生产依赖：
 *  - playwright：**已在 work-app 侧换成 playwright-core**。全量 playwright 会额外带浏览器下载器，
 *    桌面版靠 playwright-core + 系统 Edge/Chrome，省 ~5MB。playwright-core 本身要留（见下）。
 *  - misans：43MB 字体包。copy-static.mjs 已把用到的 woff2 拷进 renderer/fonts，无需再带一份。
 *  - typescript / @types/*：构建期依赖，运行时不需要。
 */
const EXCLUDED_DEPENDENCIES = new Set(['playwright', 'misans', 'electron', 'typescript', 'tsx']);

const EXCLUDED_SCOPES = new Set(['@types']);

/** Node 的解析规则：从 from 起逐级向上找 node_modules/<name>。 */
function resolvePackageDir(name, from) {
  let current = from;
  for (;;) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function shouldSkip(name) {
  if (EXCLUDED_DEPENDENCIES.has(name)) return true;
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  return scope !== null && EXCLUDED_SCOPES.has(scope);
}

/**
 * 从若干入口包出发算生产依赖闭包。
 * 依赖可能被提升到仓库根 node_modules，也可能嵌在包自己的 node_modules 下（如
 * openai/node_modules），所以每个包都要带来源目录参与解析。
 */
function collectClosure(entries) {
  const resolved = new Map();
  const missing = [];
  const queue = [...entries];

  const enqueue = (name, from) => {
    if (shouldSkip(name) || resolved.has(name)) return;
    const dir = resolvePackageDir(name, from);
    if (!dir) {
      missing.push(name);
      return;
    }
    resolved.set(name, dir);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return;
    }
    for (const dep of Object.keys(manifest.dependencies ?? {})) enqueue(dep, dir);
  };

  while (queue.length) {
    const item = queue.shift();
    if (typeof item === 'string') enqueue(item, repoRoot);
    else enqueue(item.name, item.from);
  }
  return { resolved, missing };
}

function copyPackage(name, sourceDir) {
  const destination = path.join(stageRoot, 'node_modules', ...name.split('/'));
  mkdirSync(path.dirname(destination), { recursive: true });
  // 嵌套 node_modules 的依赖会各自独立入 stage，这里不拷进去 —— 避免同一份包出现两遍，
  // 也避免把 excluded 的包从嵌套位置漏回来。
  cpSync(sourceDir, destination, {
    recursive: true,
    filter: (source) => {
      if (!statSync(source).isDirectory()) return true;
      const relative = path.relative(sourceDir, source);
      if (!relative) return true;
      return !relative.split(path.sep).includes('node_modules');
    },
  });
}

function copyRepositoryEntry(relative, required = true) {
  const source = path.join(repoRoot, relative);
  if (!existsSync(source)) {
    if (required) throw new Error(`缺少打包必需的文件：${relative}（先跑 npm run build）`);
    return;
  }
  cpSync(source, path.join(stageRoot, relative), { recursive: true });
}

// ---------- 主流程 ----------

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

// 1. host 入口 + mocode-ai 产物 + manifest（三样缺一 host 都起不来）
copyRepositoryEntry('bin');
copyRepositoryEntry('dist');
copyRepositoryEntry('package.json');

// 2. 生产依赖闭包。入口 = mocode-ai 自身的 dependencies + playwright-core（browser 工具用）。
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
if (manifest.name !== 'mocode-ai') {
  throw new Error(`仓库根 package.json 的 name 应为 mocode-ai，实际为 ${manifest.name}`);
}
const entries = Object.keys(manifest.dependencies ?? {}).filter((name) => !shouldSkip(name));
entries.push('playwright-core');

const { resolved, missing } = collectClosure(entries);
if (missing.length) {
  // 缺依赖时 pack 出来的安装包会在用户机器上才暴露，必须在这里拦下。
  throw new Error(`依赖闭包解析失败，以下包未安装：${missing.join(', ')}`);
}
for (const [name, dir] of resolved) copyPackage(name, dir);

// 3. 记账：把实际打进去的清单写下来，便于核对体积与排查缺包。
const staged = [...resolved.keys()].sort();
writeFileSync(
  path.join(stageRoot, 'STAGED-DEPENDENCIES.json'),
  `${JSON.stringify({ generatedBy: 'scripts/stage-host.mjs', root: '<repo>', packages: staged }, null, 2)}\n`,
  'utf8',
);

const decisive = ['bin/mocode-agent-host.js', 'dist/host/stdio.js', 'package.json'];
for (const relative of decisive) {
  if (!existsSync(path.join(stageRoot, relative))) throw new Error(`staging 结果缺少 ${relative}`);
}

console.log(`[stage-host] ${stageRoot}`);
console.log(`[stage-host] 入口依赖 ${entries.length} 个 → 闭包 ${staged.length} 个包`);
console.log(`[stage-host] 排除 ${[...EXCLUDED_DEPENDENCIES].join(', ')}`);
if (!require('node:fs').existsSync(path.join(stageRoot, 'node_modules', 'playwright-core'))) {
  throw new Error('playwright-core 未入包，browser 工具会在打包版失效');
}