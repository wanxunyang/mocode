import type { ChatMessage, ChatResult } from '../llm/index.js';
import type { ToolOutcome } from '../tools/registry.js';
import type { AgentRunOptions, ContentPart } from './run-contracts.js';
import type { AgentRuntimeContext } from './runtime-context.js';
import type { HistoryManager, TerminationPolicy } from './stages/contracts.js';
import { isToolResultsNoise } from './tool-helpers.js';
import type { ModelStreamState } from './model-turn.js';
import type { TurnLifecycle } from './turn-lifecycle.js';

const PLAN_NAG_THRESHOLD = 3;
const PLAN_NAG_TEXT =
  '[mocode] Reminder: you have an active plan in notes.md but have not updated it recently. ' +
  'If you finished a step, call plan_update to check it off (keep at most one in_progress); ' +
  'if the whole plan is done, let plan_update settle it to ## Done:. If the plan changed scope, update it to match reality.';

export interface ToolTurnPlanState {
  stepsSincePlanTouch: number;
}

export interface ToolTurnInput {
  opts: AgentRunOptions;
  ctx: AgentRuntimeContext;
  historyManager: HistoryManager;
  result: ChatResult;
  stream: ModelStreamState;
  step: number;
  maxSteps: number;
  planState: ToolTurnPlanState;
  turnLifecycle: TurnLifecycle;
  cancellationLifecycle: { checkpoint(): void };
  terminationPolicy: TerminationPolicy;
  rebuildHistoryIndexes(): void;
  dispatch(
    workingHistory: ChatMessage[],
    modelAttachments: NonNullable<ToolOutcome['modelAttachments']>,
  ): Promise<void>;
}

/** Owns tool-turn history publication, transaction settlement, plan nag, attachments and checkpoint ordering. */
export async function runToolTurn(input: ToolTurnInput): Promise<void> {
  const {
    opts,
    ctx,
    historyManager,
    result,
    stream,
    step,
    maxSteps,
    planState,
    turnLifecycle,
    cancellationLifecycle,
    terminationPolicy,
    rebuildHistoryIndexes,
    dispatch,
  } = input;
  const { hooks, signal } = opts;
  turnLifecycle.addToolCalls(result.toolCalls.length);

  if (result.content && isToolResultsNoise(result.content)) {
    result.content = null;
    stream.mode = 'idle';
    stream.gotText = false;
    stream.lastChar = '';
  }
  if (stream.mode !== 'idle' && stream.lastChar !== '\n') hooks.onTextEnd?.();
  historyManager.appendAssistantTurn({ content: result.content, toolCalls: result.toolCalls });
  const toolBatch = historyManager.beginToolBatch(result.toolCalls);
  const workingHistory = toolBatch.workingMessages;
  try {
    const toolResultStartIdx = workingHistory.length;
    const notesMtimeBefore = ctx.getNotesMtime();
    const narration = result.content?.trim() ?? '';
    if (narration) {
      turnLifecycle.emitTrace('narration', {
        chars: [...narration].length,
        toolCalls: result.toolCalls.length,
        step,
      });
    }

    const modelAttachments: NonNullable<ToolOutcome['modelAttachments']> = [];
    await dispatch(workingHistory, modelAttachments);

    const notesMtimeAfter = ctx.getNotesMtime();
    if (notesMtimeAfter !== notesMtimeBefore) {
      planState.stepsSincePlanTouch = 0;
    } else {
      planState.stepsSincePlanTouch += 1;
      if (planState.stepsSincePlanTouch >= PLAN_NAG_THRESHOLD) {
        const activePlan = ctx.extractActivePlanSection();
        const firstToolMsg = workingHistory[toolResultStartIdx];
        if (activePlan && firstToolMsg && firstToolMsg.role === 'tool' && typeof firstToolMsg.content === 'string') {
          firstToolMsg.content = `${PLAN_NAG_TEXT}\n\n${firstToolMsg.content}`;
        }
        planState.stepsSincePlanTouch = 0;
      }
    }

    let attachmentMessage: ChatMessage | undefined;
    if (modelAttachments.length > 0) {
      const names = modelAttachments.map((attachment) => attachment.name).join(', ');
      const content: ContentPart[] = [
        {
          type: 'text',
          text: `The view_image tool loaded the following visual input: ${names}. Analyze the attached image content directly.`,
        },
        ...modelAttachments.map(
          (attachment): ContentPart => ({
            type: 'image_url',
            image_url: {
              url: attachment.dataUrl,
              ...(attachment.detail === 'low' || attachment.detail === 'high' ? { detail: attachment.detail } : {}),
            },
          }),
        ),
      ];
      attachmentMessage = { role: 'user', content } as ChatMessage;
    }
    toolBatch.commit(attachmentMessage);
  } catch (error) {
    toolBatch.rollback();
    rebuildHistoryIndexes();
    throw error;
  }

  hooks.onToolBatchEnd?.();
  cancellationLifecycle.checkpoint();
  const batchDecision = terminationPolicy.decide({
    phase: 'tool_batch_committed',
    step,
    maxSteps,
    aborted: signal?.aborted === true,
    modelResult: result,
  });
  if (batchDecision.kind !== 'continue') {
    throw new Error(`Unexpected termination after committed tool batch: ${batchDecision.kind}.`);
  }
}
