// 路径牢笼原语:把任意输入路径解析到沙箱根之内,拒绝越界(../、绝对路径外圈、符号链接出圈)。
// 核心:resolve(root, input) → realpath(解软链)→ 前缀校验。
// 新文件(目标不存在)走「最近存在祖先 realpath 再拼回剩余分量」,同样挡住「祖先是出圈软链」。
import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join, posix, win32 } from 'node:path';
import { getSandboxRoot } from './root.js';

const isWin = process.platform === 'win32';

/** 当前沙箱根(绝对),未初始化回退 process.cwd()。 */
function root(): string {
  return resolve(getSandboxRoot() ?? process.cwd());
}

/**
 * abs 是否在沙箱根内(含 == 根)。win32 下两边 toLowerCase 再比(node 的 path.relative 不做
 * 大小写无关比较,盘符大小写差异会误判出圈)。**不做 realpath**——用于 glob/grep 结果后置过滤;
 * 越界软链的拦挡靠 jailResolve 的 realpath。
 */
export function isInsideRoot(abs: string): boolean {
  const r = root();
  // resolve 相对 r(sandbox root):glob/grep 结果相对 sandbox root,需对齐;
  // 传绝对路径时 resolve(r, abs) 返 abs 不变,兼容 jailResolve 的 realpath 结果。
  const a = isWin ? resolve(r, abs).toLowerCase() : resolve(r, abs);
  const rr = isWin ? r.toLowerCase() : r;
  const rel = relative(rr, a);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把输入路径解析为沙箱根内的绝对路径;越界(../、绝对外圈、符号链接出圈)抛错。
 * 供 enforceSandbox 重写 args.path(读/写/改)、readDiffContext 预读旧内容用。
 * 同步:realpathSync 仅做 fs 元数据查询(微秒级),与既有 readFileSync/existsSync 用法一致。
 */
export function jailResolve(input: string): string {
  const r = root();
  let abs = resolve(r, input);
  try {
    abs = realpathSync(abs);
  } catch {
    // 目标或中间段不存在(写新文件 / 路径中间段未建):realpath 最近存在祖先,拼回剩余分量。
    let dir = dirname(abs);
    const rest = [basename(abs)];
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break; // 已到 FS 根(C:\ 或 /),无法再上
      rest.unshift(basename(dir));
      dir = parent;
    }
    try {
      abs = join(realpathSync(dir), ...rest);
    } catch {
      // 连祖先都 realpath 失败(不该发生,除非 root 本身不可达):用 resolve 值,交由包含校验兜底
      abs = resolve(r, input);
    }
  }
  if (!isInsideRoot(abs)) {
    throw new Error(`路径越界,已被沙箱拒绝: ${input}`);
  }
  return abs;
}

/**
 * glob pattern 校验:同时拒绝 POSIX/Windows 绝对路径与含 `..` 段的 pattern。
 * 返 null = 通过;返 string = 拒绝原因。形如 *.ts 的正常 pattern 放行。
 */
export function jailGlobPattern(pattern: string): string | null {
  const p = String(pattern ?? '').trim();
  if (!p) return '空 pattern';
  if (posix.isAbsolute(p) || win32.isAbsolute(p)) return `不得为绝对路径: ${pattern}`;
  const segs = p.split(/[\\/]/);
  if (segs.includes('..')) return `不得含 .. 段: ${pattern}`;
  return null;
}
