// fast-glob 懒加载:它是一个冷态(开机磁盘缓存冷)首次加载可达数秒的 CJS 包。
// glob / grep / verification 三处都用,但首帧 UI 完全不需要,故集中成一个单例 getter,
// 模块顶层不 import;首帧后由 src/startup/prewarm 后台预热,真实枚举时通常已在内存。
import type fgType from 'fast-glob';

type FastGlob = typeof fgType;

let fgPromise: Promise<FastGlob> | null = null;

/** 首次调用动态加载 fast-glob;之后返回同一实例。 */
export function loadFastGlob(): Promise<FastGlob> {
  if (!fgPromise) {
    fgPromise = import('fast-glob').then((m) => m.default ?? m);
  }
  return fgPromise;
}

/** 首帧后后台预热;幂等,失败静默(真实枚举路径会自行处理)。 */
export function prewarmFastGlob(): Promise<unknown> {
  return loadFastGlob();
}
