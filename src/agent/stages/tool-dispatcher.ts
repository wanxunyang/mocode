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
      // 同批的非控制调用全部是「未被禁用的并行安全(只读)工具」时(纯 solo 时空集也满足),
      // 允许它们与扩容同批:先并发执行只读调用,再应用扩容。只读结果本 step 即得,新增 schema
      // 下一 step 生效——不必为扩容空耗一轮。只要混有写/执行等非并行工具(或某只读调用已被
      // 当前 snapshot 拒绝),即退回整批保守拒绝。
      const safeReadonlyBatch = otherIndexes.every(
        (index) => isParallelTool(calls[index].name, toolRuntime) && !request.isDenied(calls[index].name),
      );

      if (safeReadonlyBatch) {
        // 所有 header 按调用原序先发(渲染侧据此建组容器),只读批的 header 必须先于 execute。
        for (let index = 0; index < calls.length; index++) {
          request.onEvent({ type: 'header', call: calls[index] });
        }
        if (otherIndexes.length > 0) {
          request.onEvent({ type: 'start', tool: calls[otherIndexes[0]].name });
          const startedReadonly = otherIndexes.map((index) => execute(calls[index]));
          for (let offset = 0; offset < otherIndexes.length; offset++) {
            const index = otherIndexes[offset];
            const outcome = await startedReadonly[offset];
            record(index, outcome);
            executionEvents(index, parseArgs(calls[index].arguments), outcome);
            resultEvent(index, outcome, null);
          }
          request.onEvent({ type: 'done' });
        }

        // 控制调用(header 已发):逐个校验并应用扩容;solo 与同批语义一致。
        for (const index of controlIndexes) {
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
      } else {
        // 不安全批(混有写/执行等非并行工具):不扩容、不执行任何普通工具,逐 call 按原序配对拒绝结果。
        for (let index = 0; index < calls.length; index++) {
          const call = calls[index];
          request.onEvent({ type: 'header', call });
          const isControl = call.name === ADD_TOOL_GROUPS_TOOL_NAME;
          const isReadonly = isParallelTool(call.name, toolRuntime);
          const outcome: ToolOutcome = {
            status: 'denied',
            code: isControl ? 'INVALID_ARGUMENTS' : 'TOOL_DISABLED',
            retryable: false,
            output: isControl
              ? '错误:add_tool_groups 只能单独调用，或与只读工具(read_file/glob/grep/web 等)同批；本次没有扩容。'
              : isReadonly
                ? `错误:同一响应包含 add_tool_groups，工具 ${call.name} 未执行。请在下一 step 重试。`
                : `错误:add_tool_groups 不能与写/执行工具 ${call.name} 同批；请先完成扩容，再在下一 step 调用 ${call.name}。`,
            changedFiles: [],
            durationMs: 0,
          };
          record(index, outcome);
          request.onEvent({ type: 'host_outcome', call, parsed: parseArgs(call.arguments) ?? {}, outcome });
          resultEvent(index, outcome, null);
          traceEnd(index, outcome);
        }
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
        for (let offset = 0; offset < batch.length; offset++) {
          const callIndex = index + offset;
          const outcome = await started[offset];
          record(callIndex, outcome);
          executionEvents(callIndex, parseArgs(batch[offset].arguments), outcome);
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

        for (let chunkStart = 0; chunkStart < entries.length; chunkStart += concurrency) {
          const chunk = entries.slice(chunkStart, chunkStart + concurrency);
          // 块内同时启动,再按原序 await + 回灌：完成顺序任意,history/trace 始终是原调用序。
          const started = chunk.map((entry) => {
            if (entry.denied) return Promise.resolve(entry.denied);
            return execute(entry.call, request.argumentErrorHint(entry.call.name), (lockedArgs) => {
              entry.diff = readDiffContext(entry.call, lockedArgs, jailResolve);
            });
          });

          for (let k = 0; k < chunk.length; k++) {
            const callIndex = index + chunkStart + k;
            const entry = chunk[k];
            const outcome = await started[k];
            record(callIndex, outcome);
            executionEvents(callIndex, entry.parsed, outcome);
            resultEvent(callIndex, outcome, entry.denied ? null : entry.parsed, entry.diff);
            invalidate(outcome);
          }
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

        for (let offset = 0; offset < entries.length; offset++) {
          const callIndex = index + offset;
          const entry = entries[offset];
          const outcome = await started[offset];
          record(callIndex, outcome);
          executionEvents(callIndex, entry.parsed, outcome);
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
