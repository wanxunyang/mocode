// 首帧后重依赖预热调度。
//
// 启动时序目标:UI 首帧绝不等任何重依赖(openai 冷加载实测 3.8–6s、fast-glob ~3.5s),
// 但首 token 也不能等——所以在首帧渲染完成后立刻后台预热,占满用户阅读 banner / 思考 /
// 打字的时间窗:
//
//   阶段 A(Worker 冷编译):独立线程串行冷加载 openai/fast-glob/cli-highlight/ajv/undici/ws,
//     把磁盘冷读 + V8 冷编译的主线程冻结移出 TUI,并热好共享编译缓存。
//   阶段 B(主线程分块热加载):Worker 完成后,在主线程把真正要用的模块逐个 await 进
//     模块缓存。经过阶段 A 后每块仅数十毫秒,且用 setTimeout 切到宏任务,不阻塞输入响应。
//
// 若 Worker 不可用(旧 Node / 资源限制),退化为直接阶段 B(首次热加载稍慢但功能不变)。
// 所有失败静默:真实使用路径的懒加载/重试不受影响。
import { Worker } from 'node:worker_threads';
import { prewarmLlm, prewarmDefaultClient } from '../llm/index.js';
import { loadFastGlob } from '../tools/fast-glob-lazy.js';
import { prewarmCliHighlight } from '../ui/cli-highlight-lazy.js';
import { prewarmAjv } from '../tools/validation.js';

let started = false;

/** 阶段 B:主线程逐个热加载,块间让出事件循环。 */
async function warmMainThread(): Promise<void> {
  // openai 包 + 默认客户端实例(含代理安装),最先热——它决定首 token。
  await prewarmLlm();
  prewarmDefaultClient();
  const steps: Array<() => Promise<unknown>> = [
    () => loadFastGlob(),
    () => prewarmCliHighlight(),
    () => prewarmAjv(),
    () => import('undici'),
    () => import('ws'),
  ];
  for (const step of steps) {
    // 每块之间让出一次事件循环,避免连续热加载累积成可感知的输入卡顿。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      await step();
    } catch {
      // 单个依赖预热失败不影响其余;真实路径会自行加载/报错。
    }
  }
}

/**
 * 首帧渲染后调用一次(幂等)。fire-and-forget:绝不阻塞返回,绝不向调用方抛错。
 * @param workerUrl 预热 worker 的文件 URL;由调用方按 dist 布局传入。
 */
export function startPrewarm(workerUrl: URL): void {
  if (started) return;
  started = true;

  const beginWarmMain = (): void => {
    void warmMainThread().catch(() => undefined);
  };

  let worker: Worker | null = null;
  try {
    worker = new Worker(workerUrl, { stderr: false, stdout: false, execArgv: [] });
  } catch {
    // Worker 构造失败:直接在主线程预热(稍慢,但功能等价)。
    beginWarmMain();
    return;
  }

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    try {
      worker?.terminate();
    } catch {
      // 尽力清理
    }
    beginWarmMain();
  };

  worker.on('message', (msg: { type?: string }) => {
    if (msg?.type === 'done') finish();
  });
  worker.on('error', finish);
  worker.on('exit', finish);
}

/** 供 dist 布局解析 worker 入口:与本文件同目录的 prewarm-worker.js。 */
export function defaultWorkerUrl(): URL {
  return new URL('./prewarm-worker.js', import.meta.url);
}
