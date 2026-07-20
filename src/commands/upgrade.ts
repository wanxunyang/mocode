import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * /upgrade 命令实现:按需检查/升级 mocode,不阻塞启动。
 *
 * 设计要点:
 *  - 启动时不检查、不联网、不 spawn:把旧自动升级完全删除后,REPL 首屏即进输入态。
 *  - 用户主动输入 /upgrade 时才拉 registry / 执行 npm i -g。
 *  - 当前进程正在运行 dist/*.js,后台 npm install 只改磁盘,**下次启动**才用上新版本。
 *  - dev 运行(tsx src/index.ts)时禁真 spawn,防止误改全局包;编译产物运行(mocode 全局命令)才执行。
 *  - 失败时返回可读错误,不抛异常,避免 REPL 崩掉。
 */

const PKG_NAME = 'mocode-ai';
const PKG_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const FETCH_TIMEOUT_MS = 5000;

export interface VersionInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
}

/** 是否 tsx 开发运行(import.meta.url 以 .ts 结尾)。 */
export function isDevRun(): boolean {
  try {
    return fileURLToPath(import.meta.url).endsWith('.ts');
  } catch {
    return false;
  }
}

/** 读当前安装版本(package.json 的 version)。读不到返 '0.0.0'。 */
export function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** registry 取自 ~/.npmrc(与 `npm i -g` 同源);无则用官方端点。保证尾 `/`。 */
export function readRegistry(): string {
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

/** 拉 registry 最新版。超时/失败返 null,不抛异常。 */
export async function fetchLatestVersion(timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${readRegistry()}${PKG_NAME}/latest`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** 检查当前版本与 registry 最新版本。 */
export async function checkVersion(): Promise<VersionInfo> {
  const current = getCurrentVersion();
  const latest = await fetchLatestVersion();
  const hasUpdate = latest ? compareSemver(latest, current) > 0 : false;
  return { current, latest, hasUpdate };
}

/** 生成一个升级脚本,等当前 mocode 进程退出后再执行 `npm i -g`,避免 npm 无法覆盖正在运行的包文件。 */
function writeUpgradeScript(logPath: string, parentPid: number): { scriptPath: string; shell: string; args: string[] } {
  const scriptDir = path.join(os.homedir(), '.mocode');
  fs.mkdirSync(scriptDir, { recursive: true });

  if (process.platform === 'win32') {
    const scriptPath = path.join(scriptDir, 'upgrade.cmd');
    const script =
      `@echo off\r\n` +
      `echo [upgrade] waiting for mocode pid ${parentPid} to exit... >> "${logPath}"\r\n` +
      `:wait\r\n` +
      `tasklist /FI "PID eq ${parentPid}" 2>NUL | findstr "${parentPid}" >NUL\r\n` +
      `if %ERRORLEVEL% == 0 (\r\n` +
      `  timeout /T 1 /NOBREAK >NUL\r\n` +
      `  goto wait\r\n` +
      `)\r\n` +
      `echo [upgrade] mocode exited, running npm install... >> "${logPath}"\r\n` +
      `npm install -g ${PKG_NAME}@latest >> "${logPath}" 2>&1\r\n` +
      `echo [upgrade] done at %DATE% %TIME% >> "${logPath}"\r\n`;
    fs.writeFileSync(scriptPath, script);
    return { scriptPath, shell: 'cmd', args: ['/c', scriptPath] };
  }

  const scriptPath = path.join(scriptDir, 'upgrade.sh');
  const script =
    `#!/usr/bin/env sh\n` +
    `set -e\n` +
    `echo "[upgrade] waiting for mocode pid ${parentPid} to exit..." >> "${logPath}"\n` +
    `while kill -0 ${parentPid} 2>/dev/null; do sleep 1; done\n` +
    `echo "[upgrade] mocode exited, running npm install..." >> "${logPath}"\n` +
    `npm install -g ${PKG_NAME}@latest >> "${logPath}" 2>&1\n` +
    `echo "[upgrade] done at $(date -Iseconds)" >> "${logPath}"\n`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return { scriptPath, shell: 'sh', args: [scriptPath] };
}

/** 后台 spawn 升级脚本(当前进程退出后才真正跑 npm install)。 */
export function spawnUpgrade(): void {
  if (isDevRun() || process.env.MOCODE_NO_SPAWN) return;
  try {
    const logDir = path.join(os.homedir(), '.mocode');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'upgrade.log');
    const { shell, args } = writeUpgradeScript(logPath, process.pid);
    const child = spawn(shell, args, {
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
