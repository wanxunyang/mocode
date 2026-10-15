// cli-highlight(highlight.js)懒加载:它含近四百个语言文件,冷态首次加载是百毫秒级,
// 而首帧 banner 不含代码块、不需要高亮。渲染函数是同步的,故用 createRequire 同步懒取,
// 配合 src/startup/prewarm 在首帧后后台预热:用户输入含代码的首个响应到达前,包通常已在内存。
// 预热未及时完成时,首次代码块渲染会承担一次(热缓存下很短的)加载成本,功能不变。
import { createRequire } from 'node:module';
import type * as CliHighlight from 'cli-highlight';

const require = createRequire(import.meta.url);

let mod: typeof CliHighlight | null = null;
let requirePromise: Promise<unknown> | null = null;

/** 同步取 cli-highlight(渲染路径用);首次调用才真正加载。 */
export function getCliHighlight(): typeof CliHighlight {
  if (!mod) {
    mod = require('cli-highlight') as typeof CliHighlight;
  }
  return mod;
}

/** 后台预热:动态 import 与同步 require 共享模块缓存,预热后 getCliHighlight 零成本。 */
export function prewarmCliHighlight(): Promise<unknown> {
  if (!requirePromise) {
    requirePromise = import('cli-highlight')
      .then((m): unknown => {
        mod = m;
        return m;
      })
      .catch(() => undefined);
  }
  return requirePromise;
}
