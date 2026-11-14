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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * 可选运行期裸导入：resolve 失败时代码有明确降级路径（reject + 用户指引），不进闭包。
 * - mocode-pet-app：dist/pet/bridge.js 的 spawnPetProcess 用 require.resolve 找桌宠，
 *   桌宠本就是可选增强（CLI 单独 npm install），桌面版不带它也不影响 host。
 */
const OPTIONAL_BARE_IMPORTS = new Set(['mocode-pet-app']);

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

// 3. workspace 内部包（@mocode/*）。npm 闭包对它们天然失明：
//    它们不在根 package.json 的 dependencies 里（@mocode/protocol 是 devDependencies），
//    但 dist 编译产物里有**裸导入**（src/host/protocol.ts → '@mocode/protocol/host'），
//    spawn 出去的 host 在用户机器上解析不到就是起来即退。
//    不维护白名单，而是扫产物实际导入反推 —— dist 将来新 import 别的内部包会自动带上。
const workspacePackages = stageWorkspacePackages();

// 4. 记账：把实际打进去的清单写下来，便于核对体积与排查缺包。
const staged = [...resolved.keys()].sort();
writeFileSync(
  path.join(stageRoot, 'STAGED-DEPENDENCIES.json'),
  `${JSON.stringify(
    {
      generatedBy: 'scripts/stage-host.mjs',
      root: '<repo>',
      packages: staged,
      workspacePackages,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

/**
 * 打进包的 workspace 内部包（@mocode/*）+ 链接期导入终检。
 *
 * npm 闭包对 workspace 内部包天然失明：它们不在根 package.json 的 dependencies 里
 * （@mocode/protocol 挂在 devDependencies），但 dist 产物里有裸导入
 * （src/host/protocol.ts → '@mocode/protocol/host'）—— spawn 出去的 host 在用户
 * 机器上解析不到就是起来即退。这里不维护白名单，而是扫产物实际导入反推：
 * dist 将来新 import 别的内部包会自动带上。
 */
function stageWorkspacePackages() {
  // 1. 收集 stage 内自己的 .js 产物（bin/ + dist/，不含 node_modules）。
  const files = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules') continue;
        collect(full);
      } else if (entry.endsWith('.js')) {
        files.push(full);
      }
    }
  };
  collect(stageRoot);

  // 2. 提取链接期裸导入的字面量：静态 import/export-from（含跨多行的大括号导入，tsc
  //    会原样换行输出）、裸 import 副作用导入、动态 import()、require()/require.resolve()
  //    的字符串字面量。参数是变量的动态 import 扫不到 —— 那属于运行期降级链（如
  //    browser-manager 的 playwright→playwright-core），不在「起来即退」的范畴。
  //    锚点放行 `;` 是为了接住同一行里的第二条 import。
  const patterns = [
    /(?:^|[\n;])\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const importers = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        if (specifier.startsWith('node:') || specifier.startsWith('file:')) continue;
        importers.push({ file, specifier });
      }
    }
  }

  // 3. 裸导入的包要么在 npm 闭包里，要么是 @mocode/* workspace 包（拷 dist+package.json
  //    进 stage），否则打包期就抛错 —— 不能等装到用户机器上才暴露。
  //    例外：可选运行期依赖（resolve 失败有降级路径）不进闭包也不报错，但必须显式
  //    声明在 OPTIONAL_BARE_IMPORTS 里 —— 未知包仍会拦，防止清单与真实降级路径脱节。
  const workspacePackages = new Set();
  for (const { file, specifier } of importers) {
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (OPTIONAL_BARE_IMPORTS.has(packageName)) continue; // 可选依赖：解析失败有降级
    if (resolved.has(packageName) || workspacePackages.has(packageName)) continue;
    if (!packageName.startsWith('@mocode/')) {
      throw new Error(
        `${path.relative(stageRoot, file)} 裸导入 ${specifier}：既不在生产依赖闭包里，也不是 @mocode/* workspace 包` +
          ' —— 若是新增第三方依赖，先把它加进根 package.json 的 dependencies。',
      );
    }
    const sourceDir = path.join(repoRoot, 'packages', packageName.split('/')[1]);
    if (!existsSync(path.join(sourceDir, 'package.json'))) {
      throw new Error(`workspace 包 ${packageName} 不存在：缺少 ${sourceDir}\\package.json`);
    }
    if (!existsSync(path.join(sourceDir, 'dist'))) {
      throw new Error(`workspace 包 ${packageName} 缺少 dist/（先跑 npm run build -w ${packageName}）`);
    }
    const destination = path.join(stageRoot, 'node_modules', ...packageName.split('/'));
    mkdirSync(destination, { recursive: true });
    cpSync(path.join(sourceDir, 'dist'), path.join(destination, 'dist'), { recursive: true });
    cpSync(path.join(sourceDir, 'package.json'), path.join(destination, 'package.json'));
    workspacePackages.add(packageName);
  }

  // 4. 终检：用 Node 真实解析规则从每个产物文件解析它的裸导入，结果必须落在 stageRoot
  //    之内 —— 否则就是靠仓库 node_modules 侥幸解析（正是 win-unpacked 放在 F:\mocode
  //    里自测能过的那个坑），这种包到用户机器上必炸。createRequire 走 CJS 条件
  //    （require/default），与当前已知依赖集一致；将来若引入 import-only exports 的
  //    依赖，这里会先报错，届时再放宽。
  for (const { file, specifier } of importers) {
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (OPTIONAL_BARE_IMPORTS.has(packageName)) continue; // 可选依赖：解析失败有降级
    let resolvedPath;
    try {
      resolvedPath = createRequire(file).resolve(specifier);
    } catch (cause) {
      throw new Error(
        `${path.relative(stageRoot, file)} 的裸导入 ${specifier} 无法解析（${cause.message}）` +
          ' —— 依赖闭包有缺口，装到用户机器上 host 起来即退。',
      );
    }
    const relative = path.relative(stageRoot, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `${path.relative(stageRoot, file)} 的裸导入 ${specifier} 解析到了 stage 之外（${resolvedPath}）` +
          ' —— 闭包有缺口，靠仓库 node_modules 侥幸通过；装到用户机器上 host 起来即退。',
      );
    }
  }

  return [...workspacePackages].sort();
}

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