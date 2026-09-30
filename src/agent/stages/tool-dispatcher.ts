import { ADD_TOOL_GROUPS_TOOL_NAME } from '../../config/profiles.js';
import { config } from '../../config/index.js';
import { t } from '../../i18n/index.js';
import { checkPermission as defaultCheckPermission, type PermissionCheckOptions } from '../../permissions/index.js';
import { jailResolve as defaultJailResolve } from '../../sandbox/index.js';
import { summarizeToolArguments } from '../../session/index.js';
import { getPlanDisabledTools } from '../../tools/constants.js';
import { defaultToolRuntime, type ToolOutcome, type ToolRuntime } from '../../tools/registry.js';
import { validateToolArguments } from '../../tools/validation.js';
import {
  deniedOutcome,
  isParallelTool,
  isParallelOrchestrationCall,
  isResourceLockedCall,
  parseArgs,
  readDiffContext,
} from '../tool-helpers.js';
import type {
  OrderedToolCallResult,
  ToolDiffContext,
  ToolDispatchRequest,
  ToolDispatchResult,
  ToolDispatcher,
} from './contracts.js';

export interface ToolDispatcherDependencies {
  toolRuntime: ToolRuntime;
  checkPermission: (
    tool: NonNullable<ReturnType<ToolRuntime['findTool']>>,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: PermissionCheckOptions,
  ) => Promise<'allow' | 'deny'>;
  jailResolve: (path: string) => string;
}

const DEFAULT_DEPENDENCIES: ToolDispatcherDependencies = {
  toolRuntime: defaultToolRuntime,
  checkPermission: defaultCheckPermission,
  jailResolve: defaultJailResolve,
};

interface ResourceEntry {
  call: ToolDispatchRequest['calls'][number];
  parsed: Record<string, unknown> | null;
  diff: ToolDiffContext;
  denied?: ToolOutcome;
}

class LegacyCompatibleToolDispatcher implements ToolDispatcher {
  private readonly dependencies: ToolDispatcherDependencies;

  constructor(
    readonly implementation: 'legacy' | 'staged',
    dependencies: Partial<ToolDispatcherDependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    const { toolRuntime, checkPermission, jailResolve } = this.dependencies;
    const calls = request.calls;
    const argumentSummaries = calls.map((call) => summarizeToolArguments(call.arguments));
    const orderedResults: Array<OrderedToolCallResult | undefined> = new Array(calls.length);
    const modelAttachments: ToolDispatchResult['modelAttachments'][number][] = [];
    const changedFiles = new Set<string>();

    const record = (index: number, outcome: ToolOutcome): void => {
      orderedResults[index] = { call: calls[index], outcome };
      if (outcome.status === 'success' && outcome.modelAttachments?.length) {
        modelAttachments.push(...outcome.modelAttachments);
      }
      for (const file of outcome.changedFiles ?? []) changedFiles.add(file);
    };
    const traceEnd = (index: number, outcome: ToolOutcome): void =>
      request.onEvent({
        type: 'trace_end',
        call: calls[index],
        callIndex: index,
        argumentSummary: argumentSummaries[index],
        outcome,
      });
    const execute = (
      call: ToolDispatchRequest['calls'][number],
      hint?: string,
      onLockAcquired?: (args: Record<string, unknown>) => void,
    ) =>
      toolRuntime.executeToolOutcome(call.name, call.arguments, request.signal, {
        callId: call.id,
        allowedToolNames: request.currentAllowedToolNames(),
        delegation: request.delegation(),
        readDedup: request.readDedup,
        ...(hint ? { argumentErrorHint: hint } : {}),
        ...(onLockAcquired ? { onLockAcquired } : {}),
      });
    const executionEvents = (index: number, parsed: Record<string, unknown> | null, outcome: ToolOutcome): void => {
      request.onEvent({ type: 'usage', usage: outcome.usage });
      request.onEvent({ type: 'host_outcome', call: calls[index], parsed: parsed ?? {}, outcome });
      traceEnd(index, outcome);
    };
    const resultEvent = (
      index: number,
      outcome: ToolOutcome,
      parsed: Record<string, unknown> | null,
      diff: ToolDiffContext = { preWriteOld: null, editStartLine: 1 },
      includeContextState = true,
    ): void =>
      request.onEvent({
        type: 'result',
        call: calls[index],
        outcome,
        parsed,
        diff,
        succeeded: outcome.status === 'success',
        includeContextState,
      });
    const invalidate = (outcome: ToolOutcome): void => {
      const files = [...new Set([...(outcome.changedFiles ?? []), ...(outcome.staleFiles ?? [])])];
      if (files.length > 0) request.onEvent({ type: 'invalidate', files });
    };

    for (let index = 0; index < calls.length; index++) {
      request.onEvent({
        type: 'call_start',
        call: calls[index],
        callIndex: index,
        argumentSummary: argumentSummaries[index],
      });
    }

    const controlIndexes: number[] = [];
    const otherIndexes: number[] = [];
    calls.forEach((call, index) =>
      (call.name === ADD_TOOL_GROUPS_TOOL_NAME ? controlIndexes : otherIndexes).push(index),
    );
    const hasRouteBarrier = controlIndexes.length > 0;
    if (hasRouteBarrier) {
      // add_tool_groups 混批语义 = 部分执行:同批所有「未被禁用的并行安全(只读)」调用
      // 本 step 照常并发执行,控制调用照常应用扩容(只改下一 step 的 schema);仅写/执行
      // 等非并行调用被配对拒绝并提示下一 step 重试——单个违规调用不再让整批陪葬。
      // 所有 header 按调用原序先发(渲染侧据此建组容器),只读批的 header 必须先于 execute。
      for (let index = 0; index < calls.length; index++) {
        request.onEvent({ type: 'header', call: calls[index] });
      }
      // 只读调用先并发启动(执行序不变);但发布(history 回灌/事件)一律按 provider 声明序
      // 交错进行:history 批校验按 assistant tool_calls 逐位配对 id,若按执行序发布(只读先、
      // 扩容后),add_tool_groups 排在只读之前时必然 id 错位,整批 rollback 中断本轮。
      // 非并行(写/执行/串行)调用不启动:它们与扩容同批时被拒绝,下一 step 重试。
      const startedReadonly: Array<Promise<ToolOutcome> | undefined> = new Array(calls.length);
      const eligibleReadonly = otherIndexes.filter(
        (index) => isParallelTool(calls[index].name, toolRuntime) && !request.isDenied(calls[index].name),
      );
      if (eligibleReadonly.length > 0) {
        request.onEvent({ type: 'start', tool: calls[eligibleReadonly[0]].name });
        for (const index of eligibleReadonly) startedReadonly[index] = execute(calls[index]);
      }
      const lastReadonlyIndex = eligibleReadonly.length > 0 ? eligibleReadonly[eligibleReadonly.length - 1] : -1;

      for (let index = 0; index < calls.length; index++) {
        const readonlyPromise = startedReadonly[index];
        if (readonlyPromise) {
          const outcome = await readonlyPromise;
          record(index, outcome);
          executionEvents(index, parseArgs(calls[index].arguments), outcome);
          resultEvent(index, outcome, null);
          // done 紧跟最后一个只读结果(控制调用在尾部时与旧事件序完全一致)。
          if (index === lastReadonlyIndex) request.onEvent({ type: 'done' });
          continue;
        }

        if (calls[index].name !== ADD_TOOL_GROUPS_TOOL_NAME) {
          // 非并行(写/执行/串行)或被禁用的普通调用:与扩容同批时不执行,配对拒绝并提示
          // 下一 step 重试;控制调用与只读不受其影响照常处理。
          const call = calls[index];
          const outcome: ToolOutcome = {
            status: 'denied',
            code: 'TOOL_DISABLED',
            retryable: false,
            output: request.isDenied(call.name)
              ? `错误:当前 tool policy snapshot 不允许调用 ${call.name}。`
              : `错误:add_tool_groups 不能与写/执行工具 ${call.name} 同批执行，本 step 已跳过该调用（其余只读调用与扩容已正常处理）；请在下一 step 重试 ${call.name}。`,
            changedFiles: [],
            durationMs: 0,
          };
          record(index, outcome);
          request.onEvent({ type: 'host_outcome', call, parsed: parseArgs(call.arguments) ?? {}, outcome });
          resultEvent(index, outcome, null);
          traceEnd(index, outcome);
          continue;
        }

        // 控制调用(header 已发):逐个校验并应用扩容;solo 与同批语义一致。
        // 扩容只改下一 step 的 schema;本批只读执行都走 step 快照,先后无行为差。
        const call = calls[index];
        const parsed = parseArgs(call.arguments);
        let outcome: ToolOutcome;

        if (request.isDenied(call.name)) {
          outcome = {
            status: 'denied',
            code: 'TOOL_DISABLED',
            retryable: false,
            output: `错误:当前 tool policy snapshot 不允许调用 ${call.name}。`,
            changedFiles: [],
            durationMs: 0,
          };
        } else if (!request.expandToolGroups) {
          outcome = {
            status: 'denied',
            code: 'TOOL_DISABLED',
            retryable: false,
            output: '错误:当前 Agent 未启用动态工具策略，无法调用 add_tool_groups。',
            changedFiles: [],
            durationMs: 0,
          };
        } else if (
          !parsed ||
          !Array.isArray(parsed.groups) ||
          parsed.groups.length === 0 ||
          typeof parsed.reason !== 'string' ||
          !parsed.reason.trim()
        ) {
          outcome = {
            status: 'error',
            code: 'INVALID_ARGUMENTS',
            retryable: false,
            output: '错误:add_tool_groups 需要非空 groups 数组和非空 reason。',
            changedFiles: [],
            durationMs: 0,
          };
        } else {
          const expansion = request.expandToolGroups(parsed.groups, parsed.reason);
          const succeeded = expansion.added.length > 0;
          const details = [
            succeeded
              ? `Tool policy expanded to v${expansion.snapshot.version}; added groups: ${expansion.added.join(', ')}.`
              : `Tool policy was not expanded (still v${expansion.snapshot.version}).`,
            expansion.implied.length > 0 ? `Implied groups also activated: ${expansion.implied.join(', ')}.` : '',
            expansion.rejected.length > 0 ? `Rejected: ${expansion.rejected.join('; ')}.` : '',
            succeeded ? 'The added tool schemas become available on the next model step.' : '',
          ]
            .filter(Boolean)
            .join('\n');
          outcome = {
            status: succeeded ? 'success' : 'error',
            code: succeeded ? 'OK' : 'INVALID_ARGUMENTS',
            retryable: false,
            output: details,
            changedFiles: [],
            durationMs: 0,
          };
          request.onEvent({
            type: 'route_expand',
            fromVersion: request.policy.toolPolicy?.version,
            expansion,
            requestedGroups: parsed.groups,
            reason: parsed.reason,
            status: outcome.status,
          });
        }

        record(index, outcome);
        request.onEvent({ type: 'host_outcome', call, parsed: parsed ?? {}, outcome });
        resultEvent(index, outcome, null);
        traceEnd(index, outcome);
      }
    }

    let index = hasRouteBarrier ? calls.length : 0;
    while (index < calls.length) {
      const current = calls[index];
      if (request.isDenied(current.name)) {
        request.onEvent({ type: 'header', call: current });
        const output = t('task.disabled');
        const outcome: ToolOutcome = {
          status: 'denied',
          code: 'TOOL_DISABLED',
          retryable: false,
          output,
          changedFiles: [],
          durationMs: 0,
        };
        record(index, outcome);
        resultEvent(index, outcome, null);
        traceEnd(index, outcome);
        index++;
        continue;
      }

      if (isParallelTool(current.name, toolRuntime)) {
        let end = index;
        while (end < calls.length && isParallelTool(calls[end].name, toolRuntime) && !request.isDenied(calls[end].name))
          end++;
        const batch = calls.slice(index, end);
        for (const call of batch) request.onEvent({ type: 'header', call });
        request.onEvent({ type: 'start', tool: batch[0].name });
        const started = batch.map((call) => execute(call));
        // 完成即发:usage/host_outcome/trace_end 在各 outcome 落地瞬间发出(1s 的 grep 不再
        // 被 60s 的 run_command 卡住可见性);result(history 回灌)严格保持原序。
        await Promise.all(
          started.map(async (pending, offset) => {
            const outcome = await pending;
            executionEvents(index + offset, parseArgs(batch[offset].arguments), outcome);
          }),
        );
        for (let offset = 0; offset < batch.length; offset++) {
          const callIndex = index + offset;
          const outcome = await started[offset];
          record(callIndex, outcome);
          resultEvent(callIndex, outcome, null);
        }
        request.onEvent({ type: 'done' });
        index = end;
        continue;
      }

      if (
        isParallelOrchestrationCall(current.name, toolRuntime) &&
        !(request.policy.mode === 'plan' && getPlanDisabledTools().has(current.name))
      ) {
        // 连续编排调用(sub-agent)：按并发上限分块,块内并发。权限确认按原序;全部 header
        // 必须先于首个 execute——渲染侧靠 header 建组容器批,先收口会让后续 header 另起新组。
        const concurrency = Math.max(1, request.orchestrationConcurrency ?? config.subAgentConcurrency);
        let end = index;
        while (
          end < calls.length &&
          isParallelOrchestrationCall(calls[end].name, toolRuntime) &&
          !request.isDenied(calls[end].name) &&
          !(request.policy.mode === 'plan' && getPlanDisabledTools().has(calls[end].name))
        )
          end++;
        const batch = calls.slice(index, end);
        const entries: ResourceEntry[] = [];

        for (let offset = 0; offset < batch.length; offset++) {
          const call = batch[offset];
          const parsed = parseArgs(call.arguments);
          const tool = toolRuntime.findTool(call.name);
          const argumentsValid = tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
          let denied: ToolOutcome | undefined;
          if (tool && argumentsValid) {
            const decision = await checkPermission(tool, parsed ?? {}, request.signal, {
              prompt: request.permissionPrompt,
            });
            request.onEvent({ type: 'permission', call, callIndex: index + offset, decision });
            if (decision === 'deny') denied = deniedOutcome(call.name);
          }
          entries.push({
            call,
            parsed,
            diff: { preWriteOld: null, editStartLine: 1 },
            ...(denied ? { denied } : {}),
          });
        }

        for (const entry of entries) request.onEvent({ type: 'header', call: entry.call });
        const firstAllowed = entries.find((entry) => !entry.denied);
        if (firstAllowed) request.onEvent({ type: 'start', tool: firstAllowed.call.name });

        // 动态补位池:启动上限 concurrency,任意一个完成立即补位下一个——静态分块时
        // 「7 个任务、1 个跑 10 分钟」会让第 5 分钟起 4 个槽位空转而 6/7 号干等,总耗时
        // ≈最慢链;补位后 ≈最满调度。
        // 完成即发:usage/host_outcome/trace_end 在各 outcome 落地瞬间发出(快完成的
        // 子 agent 不再被批内前面的慢调用卡住可见性)。history 回灌(result 事件)严格
        // 保持 provider 原调用序——批校验按 assistant tool_calls 逐位配对 id。
        // 实现用 worker 循环而非「补位回调 + outcomes.map」:outcomes 是稀疏数组,
        // Array.prototype.map 会跳过未启动槽位的洞,补位链条会在第 N+1 个断掉。
        const outcomes: Array<Promise<ToolOutcome>> = new Array(entries.length);
        let cursor = 0;
        const runWorker = async (): Promise<void> => {
          while (cursor < entries.length) {
            const position = cursor++;
            const entry = entries[position];
            const outcome = entry.denied
              ? entry.denied
              : await execute(entry.call, request.argumentErrorHint(entry.call.name), (lockedArgs) => {
                  entry.diff = readDiffContext(entry.call, lockedArgs, jailResolve);
                });
            outcomes[position] = Promise.resolve(outcome);
            executionEvents(index + position, entry.parsed, outcome);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => runWorker()));

        for (let offset = 0; offset < entries.length; offset++) {
          const outcome = await outcomes[offset];
          const callIndex = index + offset;
          record(callIndex, outcome);
          resultEvent(callIndex, outcome, entries[offset].denied ? null : entries[offset].parsed, entries[offset].diff);
          invalidate(outcome);
        }
        if (firstAllowed) request.onEvent({ type: 'done' });
        index = end;
        continue;
      }

      if (
        isResourceLockedCall(current, toolRuntime) &&
        !(request.policy.mode === 'plan' && getPlanDisabledTools().has(current.name))
      ) {
        let end = index;
        while (
          end < calls.length &&
          isResourceLockedCall(calls[end], toolRuntime) &&
          !request.isDenied(calls[end].name) &&
          !(request.policy.mode === 'plan' && getPlanDisabledTools().has(calls[end].name))
        )
          end++;
        const batch = calls.slice(index, end);
        const entries: ResourceEntry[] = [];

        for (let offset = 0; offset < batch.length; offset++) {
          const call = batch[offset];
          const parsed = parseArgs(call.arguments);
          const tool = toolRuntime.findTool(call.name);
          const argumentsValid = tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
          let denied: ToolOutcome | undefined;
          if (tool && argumentsValid) {
            const decision = await checkPermission(tool, parsed ?? {}, request.signal, {
              prompt: request.permissionPrompt,
            });
            request.onEvent({ type: 'permission', call, callIndex: index + offset, decision });
            if (decision === 'deny') denied = deniedOutcome(call.name);
          }
          entries.push({
            call,
            parsed,
            diff: { preWriteOld: null, editStartLine: 1 },
            ...(denied ? { denied } : {}),
          });
        }

        for (const entry of entries) request.onEvent({ type: 'header', call: entry.call });
        const firstAllowed = entries.find((entry) => !entry.denied);
        if (firstAllowed) request.onEvent({ type: 'start', tool: firstAllowed.call.name });
        const started = entries.map((entry) => {
          if (entry.denied) return Promise.resolve(entry.denied);
          return execute(entry.call, request.argumentErrorHint(entry.call.name), (lockedArgs) => {
            entry.diff = readDiffContext(entry.call, lockedArgs, jailResolve);
          });
        });

        // 完成即发:usage/host_outcome/trace_end 落地瞬间发出;result(history 回灌)严格原序
        // ——批校验按 assistant tool_calls 逐位配对 id,同文件排队由 canonical file 锁保证。
        await Promise.all(
          started.map(async (pending, offset) => {
            const outcome = await pending;
            executionEvents(index + offset, entries[offset].parsed, outcome);
          }),
        );
        for (let offset = 0; offset < entries.length; offset++) {
          const callIndex = index + offset;
          const entry = entries[offset];
          const outcome = await started[offset];
          record(callIndex, outcome);
          resultEvent(callIndex, outcome, entry.denied ? null : entry.parsed, entry.diff);
          invalidate(outcome);
        }
        if (firstAllowed) request.onEvent({ type: 'done' });
        index = end;
        continue;
      }

      const call = calls[index];
      if (request.policy.mode === 'plan' && getPlanDisabledTools().has(call.name)) {
        request.onEvent({ type: 'header', call });
        const output = `错误:计划模式下禁用工具 ${call.name}(仅读探查,不改动文件 / 不跑命令)`;
        const outcome: ToolOutcome = {
          status: 'denied',
          code: 'MODE_DENIED',
          retryable: false,
          output,
          changedFiles: [],
          durationMs: 0,
        };
        record(index, outcome);
        resultEvent(index, outcome, null, undefined, false);
        traceEnd(index, outcome);
        index++;
        continue;
      }

      const parsed = parseArgs(call.arguments);
      const tool = toolRuntime.findTool(call.name);
      const argumentsValid = tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
      if (tool && argumentsValid) {
        const decision = await checkPermission(tool, parsed ?? {}, request.signal, {
          prompt: request.permissionPrompt,
        });
        request.onEvent({ type: 'permission', call, callIndex: index, decision });
        if (decision === 'deny') {
          request.onEvent({ type: 'header', call });
          const outcome = deniedOutcome(call.name);
          record(index, outcome);
          resultEvent(index, outcome, null);
          traceEnd(index, outcome);
          index++;
          continue;
        }
      }

      request.onEvent({ type: 'header', call });
      const mutationParsed = toolRuntime.isFileMutationTool(call.name) ? parsed : null;
      let diff = readDiffContext(call, mutationParsed, jailResolve);
      request.onEvent({ type: 'start', tool: call.name });
      const outcome = await execute(call, request.argumentErrorHint(call.name), (lockedArgs) => {
        if (mutationParsed) diff = readDiffContext(call, lockedArgs, jailResolve);
      });
      record(index, outcome);
      executionEvents(index, parsed, outcome);
      request.onEvent({ type: 'done' });
      resultEvent(index, outcome, mutationParsed, diff);
      invalidate(outcome);
      index++;
    }

    if (orderedResults.some((result) => !result)) {
      throw new Error('Tool dispatcher did not settle every provider tool call.');
    }
    return {
      orderedResults: orderedResults as OrderedToolCallResult[],
      changedFiles: [...changedFiles],
      modelAttachments,
    };
  }
}

class LegacyToolDispatcher extends LegacyCompatibleToolDispatcher {
  constructor(dependencies: Partial<ToolDispatcherDependencies> = {}) {
    super('legacy', dependencies);
  }
}

class StagedToolDispatcher extends LegacyCompatibleToolDispatcher {
  constructor(dependencies: Partial<ToolDispatcherDependencies> = {}) {
    super('staged', dependencies);
  }
}

export function createLegacyToolDispatcher(dependencies: Partial<ToolDispatcherDependencies> = {}): ToolDispatcher {
  return new LegacyToolDispatcher(dependencies);
}

export function createStagedToolDispatcher(dependencies: Partial<ToolDispatcherDependencies> = {}): ToolDispatcher {
  return new StagedToolDispatcher(dependencies);
}
