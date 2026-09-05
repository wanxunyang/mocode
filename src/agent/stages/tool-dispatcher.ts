import { ADD_TOOL_GROUPS_TOOL_NAME } from '../../config/profiles.js';
import { t } from '../../i18n/index.js';
import { checkPermission } from '../../permissions/index.js';
import { summarizeToolArguments } from '../../session/index.js';
import { getPlanDisabledTools } from '../../tools/constants.js';
import { executeToolOutcome, findTool, isFileMutationTool, type ToolOutcome } from '../../tools/registry.js';
import { validateToolArguments } from '../../tools/validation.js';
import { deniedOutcome, isParallelTool, isResourceLockedCall, parseArgs, readDiffContext } from '../tool-helpers.js';
import type {
  OrderedToolCallResult,
  ToolDiffContext,
  ToolDispatchRequest,
  ToolDispatchResult,
  ToolDispatcher,
} from './contracts.js';

interface ResourceEntry {
  call: ToolDispatchRequest['calls'][number];
  parsed: Record<string, unknown> | null;
  diff: ToolDiffContext;
  denied?: ToolOutcome;
}

class LegacyCompatibleToolDispatcher implements ToolDispatcher {
  constructor(readonly implementation: 'legacy' | 'staged') {}

  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
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
      executeToolOutcome(call.name, call.arguments, request.signal, {
        callId: call.id,
        allowedToolNames: request.currentAllowedToolNames(),
        delegation: request.delegation(),
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

    const hasRouteBarrier = calls.some((call) => call.name === ADD_TOOL_GROUPS_TOOL_NAME);
    if (hasRouteBarrier) {
      const mixedCall = calls.length !== 1;
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        request.onEvent({ type: 'header', call });
        const parsed = parseArgs(call.arguments);
        let outcome: ToolOutcome;

        if (mixedCall) {
          const isControl = call.name === ADD_TOOL_GROUPS_TOOL_NAME;
          outcome = {
            status: 'denied',
            code: isControl ? 'INVALID_ARGUMENTS' : 'TOOL_DISABLED',
            retryable: false,
            output: isControl
              ? '错误:add_tool_groups 必须在一个独立的 model step 中单独调用；本次没有扩容。'
              : `错误:同一响应包含 add_tool_groups，工具 ${call.name} 未执行。请等待扩容结果后在下一 step 重试。`,
            changedFiles: [],
            durationMs: 0,
          };
        } else if (request.isDenied(call.name)) {
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

      if (isParallelTool(current.name)) {
        let end = index;
        while (end < calls.length && isParallelTool(calls[end].name) && !request.isDenied(calls[end].name)) end++;
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
        isResourceLockedCall(current) &&
        !(request.policy.mode === 'plan' && getPlanDisabledTools().has(current.name))
      ) {
        let end = index;
        while (
          end < calls.length &&
          isResourceLockedCall(calls[end]) &&
          !request.isDenied(calls[end].name) &&
          !(request.policy.mode === 'plan' && getPlanDisabledTools().has(calls[end].name))
        )
          end++;
        const batch = calls.slice(index, end);
        const entries: ResourceEntry[] = [];

        for (let offset = 0; offset < batch.length; offset++) {
          const call = batch[offset];
          const parsed = parseArgs(call.arguments);
          const tool = findTool(call.name);
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
            entry.diff = readDiffContext(entry.call, lockedArgs);
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
      const tool = findTool(call.name);
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
      const mutationParsed = isFileMutationTool(call.name) ? parsed : null;
      let diff = readDiffContext(call, mutationParsed);
      request.onEvent({ type: 'start', tool: call.name });
      const outcome = await execute(call, request.argumentErrorHint(call.name), (lockedArgs) => {
        if (mutationParsed) diff = readDiffContext(call, lockedArgs);
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
  constructor() {
    super('legacy');
  }
}

class StagedToolDispatcher extends LegacyCompatibleToolDispatcher {
  constructor() {
    super('staged');
  }
}

export function createLegacyToolDispatcher(): ToolDispatcher {
  return new LegacyToolDispatcher();
}

export function createStagedToolDispatcher(): ToolDispatcher {
  return new StagedToolDispatcher();
}
