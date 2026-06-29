import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 启动时自动检测并后台自更新(仿 update-notifier,但**真更新**而非仅提示)。
 *
 * 设计要点:
 *  - **零启动延迟**:`checkAndMaybeUpdate()` 同步返回提示串或 null;联网刷新与 `npm i -g` 都是
 *    fire-and-forget 后台操作(不 await),不卡 REPL 启动。
 *  - **下次启动生效**:当前进程已把 dist/*.js 读入内存,运行中不持有文件句柄;后台 `npm i -g`
 *    覆写磁盘包(含 mocode.cmd shim),当前进程不受影响,**下次** `mocode` 即新版本。
 *  - **节流**:检查 24h、spawn 6h(防每跑必联网 / 重复 spawn)。更新成功后下次重读 package.json
 *    得 current=latest → 不再 spawn、不再提示。
 *  - **不依赖 config**:只用 stdlib + 全局 fetch,缺 LLM 配置也能跑(在 config 校验前调)。
 *  - **dev 跳过**:tsx 运行 `.ts`(`npm start`)不自更新;编译态 `.js`(`mocode` 全局命令)才更新。
 *  - **失败静默**:断网 / 无 npm / 权限不足都不阻断启动。
 */

const PKG_NAME = 'mocode-ai';
/** 包根 package.json:从 dist/updater/ 或 src/updater/ 均 `../../package.json`(npm 必带 package.json)。 */
const PKG_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const CACHE_PATH = path.join(os.homedir(), '.mocode', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h:多久重新拉一次 registry
const SPAWN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h:同一待更新版本多久内不重复 spawn
const FETCH_TIMEOUT_MS = 2500;

/** 缓存路径:MOCODE_UPDATE_CACHE 可重定向(测试用临时文件,避免污染真实 ~/.mocode 缓存)。 */
function cachePath(): string {
  return process.env.MOCODE_UPDATE_CACHE || CACHE_PATH;
}

export interface UpdateCache {
  lastCheck?: number; // ms 时间戳,上次(尝试)拉 registry
  latest?: string; // registry 返回的最新版本
  lastSpawn?: number; // ms,上次 spawn `npm i -g`
}

/** tsx 开发态(import.meta.url 以 .ts 结尾)跳过自更新;编译态 .js 才更新。 */
function isDevRun(): boolean {
  try {
    return fileURLToPath(import.meta.url).endsWith('.ts');
  } catch {
    return false;
  }
}

/** 读当前安装版本(package.json 的 version)。读不到返 ''。 */
function readCurrentVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

function readCache(): UpdateCache {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as UpdateCache;
  } catch {
    return {};
  }
}

/** 读-合并-写(各写者独立 merge,降低后台 fetch 与同步 spawn 写的竞态丢字段风险)。 */
function writeCache(patch: UpdateCache): void {
  try {
    const merged: UpdateCache = { ...readCache(), ...patch };
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(merged), 'utf8');
  } catch {
    // 写缓存失败不阻断
  }
}

/** registry 取自 ~/.npmrc(国内镜像用户与 `npm i -g` 装的源一致);无则用官方端点。保证尾 `/`。 */
function readRegistry(): string {
  let reg = 'https://registry.npmjs.org/';
  try {
    const npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = /^registry\s*=\s*["']?([^"'\s]+)["']?\s*$/m.exec(npmrc);
    if (m && m[1]) reg = m[1];
  } catch {
    // 无 ~/.npmrc:用默认
  }
  return reg.endsWith('/') ? reg : reg + '/';
}

/** 后台拉 registry 最新版(不 await):成功写 latest+lastCheck,失败只写 lastCheck(防离线每跑必联网)。 */
async function fetchLatestInBackground(): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${readRegistry()}${PKG_NAME}/latest`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { version?: string };
    writeCache(data.version ? { latest: data.version, lastCheck: Date.now() } : { lastCheck: Date.now() });
  } catch {
    writeCache({ lastCheck: Date.now() });
  }
}

/** 后台 spawn `npm i -g <pkg>@latest`(Win:shell 解析 npm.cmd + windowsHide 防控制台闪;detached+unref 跨进程存活)。 */
function spawnUpdate(): void {
  if (process.env.MOCODE_NO_SPAWN) return; // 测试门控:禁真跑 npm
  try {
    const child = spawn('npm', ['install', '-g', `${PKG_NAME}@latest`], {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    child.on('error', () => {});
  } catch {
    // 忽略
  }
}

/** 简易 semver 比较(只管 X.Y.Z 数字,无 pre-release):a>b 返正,a<b 返负,等返 0。 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export interface UpdateDecision {
  notice: string | null;
  spawn: boolean; // 是否应后台 spawn `npm i -g`
  refresh: boolean; // 是否应后台刷新缓存
}

/** 纯决策:据当前版本 / 缓存 / 时间,算是否提示 / spawn / 后台刷新。无副作用,可离线测。 */
export function evaluateUpdate(current: string, cache: UpdateCache, now: number): UpdateDecision {
  const refresh = !cache.latest || now - (cache.lastCheck ?? 0) > CHECK_INTERVAL_MS;
  let notice: string | null = null;
  let spawn = false;
  if (cache.latest && compareSemver(cache.latest, current) > 0) {
    notice = `检测到新版本 ${cache.latest},后台更新中,下次启动生效。`;
    spawn = now - (cache.lastSpawn ?? 0) > SPAWN_INTERVAL_MS;
  }
  return { notice, spawn, refresh };
}

/**
 * 启动时调(同步,零延迟):返一行纯文本更新提示或 null。
 * 流程:dev 跳过 → 读当前版本 → 读缓存 → evaluateUpdate 决策 → 按需后台刷新 / spawn → 返提示。
 * 提示由 repl 上色写入内容区开场段(进 INPUT 态前)。
 */
export function checkAndMaybeUpdate(): string | null {
  if (isDevRun()) return null;
  const current = readCurrentVersion();
  if (!current) return null;
  const cache = readCache();
  const now = Date.now();
  const d = evaluateUpdate(current, cache, now);
  if (d.refresh) void fetchLatestInBackground(); // fire-and-forget:刷新缓存供下次启动用
  if (d.spawn) {
    spawnUpdate();
    writeCache({ lastSpawn: now });
  }
  return d.notice;
}
