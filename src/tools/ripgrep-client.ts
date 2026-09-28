// ripgrep 子进程客户端:grep 工具的快速路径。
//
// 为什么不是 Node 逐文件读:fast-glob 枚举 + readFile 全量进内存 + 逐行正则是串行的,
// .venv / node_modules 这类目录能把一次全库 grep 拖到 7 分钟以上(Windows Defender 还会
// 对每个被读文件再扫一遍)。ripgrep 是流式并行目录遍历,默认尊重 .gitignore、跳过二进制
// 与隐藏目录,速度快一到两个数量级。二进制随 @vscode/ripgrep 按平台安装,不依赖用户 PATH。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { IGNORE } from './constants.js';
import { getSandboxRoot, isInsideRoot } from '../sandbox/index.js';

const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';

/** JSON 采集上限:约可容纳数万条命中,超出即杀进程并标 truncated。 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export interface RgLineEvent {
  line: number;
  text: string;
}
export interface RgFileEvents {
  path: string;
  matches: RgLineEvent[];
  contexts: RgLineEvent[];
}

export type RgResult =
  | { status: 'ok'; files: RgFileEvents[]; scanned: number; truncated: boolean }
  | { status: 'no-match'; scanned: number; truncated: boolean }
  | { status: 'regex_error'; message: string }
  | { status: 'aborted' }
  | { status: 'unavailable' };

export interface RgParams {
  pattern: string;
  /** fast-glob 口径的 glob;**\/* 视为不限定。 */
  glob: string;
  context: number;
}

/**
 * 定位 rg 可执行文件:MOCODE_RG_PATH 显式覆盖 → @vscode/ripgrep 随包二进制 → PATH 上的 rg。
 * 返 null = 三条路都没有,调用方应退 Node 兜底。
 */
export function resolveRgPath(): string | null {
  const override = process.env.MOCODE_RG_PATH;
  if (override && existsSync(override)) return override;
  try {
    const mod = require('@vscode/ripgrep') as { rgPath?: unknown };
    if (typeof mod.rgPath === 'string' && existsSync(mod.rgPath)) return mod.rgPath;
  } catch {
    // 可选依赖没装上(如 --no-optional / 不支持的平台),落到 PATH 探测。
  }
  const probe = spawnSync(isWin ? 'rg.exe' : 'rg', ['--version'], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0 ? (isWin ? 'rg.exe' : 'rg') : null;
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (isWin && child.pid != null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // 进程已退出或终止失败,尽力而为。
  }
}

/** 去掉 rg 路径前缀 ./ 并把反斜杠归一为 /(与旧 fast-glob 输出口径一致)。 */
function normalizePath(p: string): string {
  return p.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
}

/**
 * 跑一次 ripgrep(--json NDJSON),聚合成每文件事件。永不抛错:
 * 进程起不来 → unavailable;非法正则 → regex_error;signal 中止 → aborted。
 */
export function runRipgrep(params: RgParams, signal?: AbortSignal): Promise<RgResult> {
  const rgPath = resolveRgPath();
  if (!rgPath || signal?.aborted) return Promise.resolve({ status: 'aborted' });

  const cwd = getSandboxRoot() ?? process.cwd();
  // --no-require-git:rg 默认只在 git 仓库内才读 .gitignore;加上后非 git 项目的 .gitignore
  // 同样生效(实测不加时 ignored/ 会被扫到)。
  const args = ['--json', '--hidden', '--no-require-git', '--path-separator', '/'];
  if (params.context > 0) args.push('-C', String(params.context));
  if (params.glob && params.glob !== '**/*') args.push('-g', params.glob);
  for (const entry of IGNORE) args.push('-g', `!${entry}`);
  args.push('-e', params.pattern);

  return new Promise<RgResult>((resolve) => {
    const child = spawn(rgPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let collected = 0;
    let truncated = false;
    let stderr = '';
    let buffer = '';
    const byPath = new Map<string, RgFileEvents>();
    let scanned = 0;

    const finish = (result: RgResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      killTree(child);
      finish({ status: 'aborted' });
    };

    const handleLine = (line: string): void => {
      let evt: { type?: string; data?: Record<string, unknown> };
      try {
        evt = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
      } catch {
        return; // 末行被截断,忽略
      }
      const data = evt.data;
      if (!data) return;
      if (evt.type === 'end') {
        scanned++;
        return;
      }
      if (evt.type !== 'match' && evt.type !== 'context') return;
      const pathText = (data.path as { text?: string } | undefined)?.text;
      const lineNo = data.line_number;
      const linesText = (data.lines as { text?: string } | undefined)?.text;
      if (typeof pathText !== 'string' || typeof lineNo !== 'number' || typeof linesText !== 'string') return;
      const path = normalizePath(pathText);
      if (!isInsideRoot(path)) return; // 后置兜底:仅留牢内
      let bucket = byPath.get(path);
      if (!bucket) {
        bucket = { path, matches: [], contexts: [] };
        byPath.set(path, bucket);
      }
      const event: RgLineEvent = { line: lineNo, text: linesText.replace(/\r?\n$/, '') };
      if (evt.type === 'match') bucket.matches.push(event);
      else bucket.contexts.push(event);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      collected += chunk.length;
      if (collected > MAX_JSON_BYTES && !truncated) {
        truncated = true;
        killTree(child); // 输出已超预算,没必要继续
        return;
      }
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (error) => {
      // ENOENT / EACCES / exec 格式错误 = 二进制不可用,交给 Node 兜底。
      const code = (error as { code?: string }).code;
      finish({ status: code === 'ENOENT' || code === 'EACCES' ? 'unavailable' : 'aborted' });
    });
    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer.trim());
      // exit 2 + stderr = 正则/参数错误;无命中事件时按 regex_error 上报。
      if (code === 2 && byPath.size === 0 && stderr.trim()) {
        finish({ status: 'regex_error', message: stderr.trim() });
        return;
      }
      if (byPath.size === 0) {
        finish({ status: 'no-match', scanned, truncated });
        return;
      }
      finish({ status: 'ok', files: [...byPath.values()], scanned, truncated });
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
