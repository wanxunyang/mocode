// 预热 Worker:在独立线程里串行冷加载所有重依赖,目的是:
//   1) 把磁盘冷读 + V8 冷编译的主线程冻结成本移出 TUI(Worker 不阻塞 UI 事件循环);
//   2) 热好编译缓存目录(主线程与 Worker 共享同一缓存)。
// Worker 加载完发 'done' 即退出;它加载的模块不进入主线程模块缓存,主线程随后再热加载一次。
import { parentPort } from 'node:worker_threads';

const SPECS = ['openai', 'fast-glob', 'cli-highlight', 'ajv', 'ajv/dist/2020.js', 'undici', 'ws'];

async function main(): Promise<void> {
  for (const spec of SPECS) {
    try {
      await import(spec);
      parentPort?.postMessage({ type: 'loaded', spec });
    } catch (error) {
      parentPort?.postMessage({
        type: 'failed',
        spec,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  parentPort?.postMessage({ type: 'done' });
}

void main();
