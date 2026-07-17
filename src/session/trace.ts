import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { ChatUsage } from '../llm/index.js';
import { getCurrentSessionId } from './state.js';
import type { ValidationResult } from '../verification/types.js';

export interface AgentTurnTrace {
  ts: string;
  status: 'completed' | 'aborted' | 'max_steps' | 'error';
  durationMs: number;
  toolCalls: number;
  changedFiles: string[];
  usage?: ChatUsage;
  validation?: ValidationResult;
}

function boundedValidation(result: ValidationResult | undefined): ValidationResult | undefined {
  if (!result) return undefined;
  const max = 4000;
  return result.output.length <= max
    ? result
    : { ...result, output: `${result.output.slice(0, 2000)}\n…[trace output truncated]…\n${result.output.slice(-1900)}` };
}

/** Best-effort JSONL trace. Failure must never affect the agent turn. */
export function appendCurrentSessionTrace(trace: AgentTurnTrace): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return;
  try {
    const dir = path.join(config.sessionDir, sessionId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, 'trace.jsonl'),
      `${JSON.stringify({ ...trace, validation: boundedValidation(trace.validation) })}\n`,
      'utf8',
    );
  } catch {
    // Observability is best-effort and cannot block coding work.
  }
}
