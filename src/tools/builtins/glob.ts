import fg from 'fast-glob';
import { IGNORE } from '../constants.js';
import { getSandboxRoot, isInsideRoot } from '../../sandbox/index.js';
import type { Tool, ToolOutcome } from '../types.js';

/**
 * glob 超时墙。纯文件名枚举正常是毫秒~秒级;超时只发生在网络盘/断开的 UNC 挂载等病态
 * 场景。此时杀掉枚举报错,而不是让 spinner 无限期挂住。
 */
export const GLOB_TIMEOUT_MS = 30_000;

// ---------- glob ----------
export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. **/*.ts). Auto-excludes node_modules/.git. ' +
    'For architecture or call chains, prefer the codegraph skill.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts or src/**/*.json' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern);
    const cwd = getSandboxRoot() ?? process.cwd();

    // 组合外部 Ctrl+C 信号与超时墙:fast-glob 3.3 原生支持 AbortSignal,中止后枚举立即失败。
    const controller = new AbortController();
    const external = ctx?.signal;
    const onExternal = (): void => controller.abort();
    if (external) {
      if (external.aborted) onExternal();
      else external.addEventListener('abort', onExternal, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GLOB_TIMEOUT_MS);

    try {
      // fast-glob 3.3 的 signal 选项运行时不生效(实测),用 Promise.race 做超时/中断墙:
      // 触发后不再等待枚举——纯只读 readdir 会自行跑完,用户面即时解锁。
      const fgPromise = fg(pattern, {
        cwd,
        onlyFiles: true,
        dot: true,
        ignore: IGNORE,
        followSymbolicLinks: false, // 不跟随软链目录,防经软链列出牢外文件
        throwErrorOnBrokenSymbolicLink: false,
      });
      const cancelled = new Promise<'cancelled'>((resolve) => {
        if (controller.signal.aborted) resolve('cancelled');
        else controller.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
      });
      const files = await Promise.race([fgPromise, cancelled]);
      if (files === 'cancelled') {
        if (timedOut) {
          return {
            status: 'error',
            code: 'TIMEOUT',
            retryable: false,
            output: `错误:glob 超过 ${GLOB_TIMEOUT_MS / 1000}s 超时墙已被中止(确认无网络盘挂载,或收窄 pattern 后重试)`,
          } satisfies ToolOutcome;
        }
        // 外部 Ctrl+C:中断串由 tool-runtime 见 signal.aborted 归一为 aborted。
        return '已中断';
      }
      const safeFiles = files.filter((f) => isInsideRoot(f)); // 后置兜底:仅留牢内
      if (safeFiles.length === 0) return '无匹配文件';
      const shown = safeFiles.slice(0, 200);
      let out = shown.join('\n');
      if (safeFiles.length > 200) out += `\n... (共 ${safeFiles.length} 个,仅显示前 200)`;
      return out;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    }
  },
};
