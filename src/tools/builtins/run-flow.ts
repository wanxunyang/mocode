/**
 * run_flow 工具:回放 `.mocode/flows/<name>.json` 里录制好的桌面流程(design-notes/computer-use-rpa.md §5.3)。
 *
 * 与逐步调用 computer 的区别:整条流程不经过模型,按录制的 selector 现场定位元素,失败按步骤的
 * onError 策略重试 / 跳过 / 中止 / 交还模型。权限在整条 flow 层面一次做完(permissions/flow-review.ts):
 * 指纹绑定 flow 文件 hash,敏感 flow 强制逐次确认——回放内部的单步不再弹窗。
 */
import {
  runFlow,
  formatFlowRunResult,
  type FlowRunResult,
  type RunnerDeps,
  type StepOutcome,
} from '../../flows/runner.js';
import { loadFlow, type Flow } from '../../flows/flow.js';
import { withTraceSuspended } from '../../flows/trace.js';
import type { Tool, ToolOutcome } from '../types.js';
import { computerTool, resolveSelectorToRef, resolveWindowForReplay } from './computer.js';

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 生产环境的 RunnerDeps:把 runner 接到 computer 工具与 UIA 定位上。 */
export function createComputerRunnerDeps(signal?: AbortSignal): RunnerDeps {
  return {
    async execute(args, sig): Promise<StepOutcome> {
      const r = await computerTool.execute(args, { signal: sig });
      if (typeof r === 'string') return { status: 'success', output: r };
      return { status: r.status, code: r.code, output: r.output, modelAttachments: r.modelAttachments };
    },
    resolveRef: resolveSelectorToRef,
    resolveWindow: resolveWindowForReplay,
    sleep: abortableSleep,
    signal,
  };
}

/** run_flow 工具与 `/flow run` 共用的回放入口;回放期间暂停 trace 录制。 */
export function runFlowWithComputer(
  flow: Flow,
  params: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<FlowRunResult> {
  return withTraceSuspended(() => runFlow(flow, params, createComputerRunnerDeps(signal)));
}

export const runFlowTool: Tool = {
  name: 'run_flow',
  description:
    'Replay a recorded desktop flow (.mocode/flows/<name>.json) without step-by-step model calls. ' +
    'Elements are re-located by their recorded UI Automation selector, so the flow survives moved windows; ' +
    'steps without a selector use recorded coordinates and are only as reliable as the window layout. ' +
    'A failing step is retried, then skipped, aborted, or handed back to you (default: retry once, then hand back with the current screenshot). ' +
    'Pass values for the flow\'s declared parameters in "params". Browse available flows with glob/read_file on .mocode/flows/. ' +
    'The user is asked to approve each run; flows that type sensitive text always need per-run approval.',
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Flow name (file name without .json).' },
      params: {
        type: 'object',
        description:
          'Values for the flow parameters, e.g. {"text_3": "hello"}. Unknown or missing required parameters are rejected.',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolOutcome> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const loaded = loadFlow(name);
    if (!loaded.ok) {
      return { status: 'error', code: 'INVALID_ARGUMENTS', retryable: false, output: loaded.error };
    }
    const params =
      args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? (args.params as Record<string, unknown>)
        : undefined;

    const result = await runFlowWithComputer(loaded.flow, params, ctx?.signal);
    const output = formatFlowRunResult(loaded.flow, result);
    const modelAttachments = result.attachments;

    switch (result.status) {
      case 'completed':
        return { status: 'success', code: 'OK', retryable: false, output, modelAttachments };
      case 'aborted':
        return { status: 'aborted', code: 'ABORTED', retryable: false, output };
      case 'rejected':
        return { status: 'error', code: 'INVALID_ARGUMENTS', retryable: false, output };
      default:
        // handoff / failed:不自动重试(步骤级重试已在 runner 内做过),由模型接手或报告。
        return { status: 'error', code: 'POSTCONDITION_FAILED', retryable: false, output, modelAttachments };
    }
  },
};
