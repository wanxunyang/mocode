// Typed Context Optimization Pipeline.
//
// Normal tool insertion does not call this module: agent/core stores the raw
// result after only capToolResultForHistory(). The pressure scheduler invokes
// this encoder for Cold logs and retrievable searches when the opt-in switch is
// enabled. Encoder failures always fall back to the raw hard-capped result.
//
// This does not alter tool schemas, execution, tool_call_id pairing, or TUI
// rendering; it only provides a pressure-stage representation transform.

import type { ContextEncoder, EncoderRuntimeContext } from './types.js';
import { classify } from './classifier.js';
import { getEncoder, registerAll } from './registry.js';
import { builtinEncoders } from './encoders/index.js';
import { passthroughEncoder } from './encoders/passthrough.js';
import { capToolResultForHistory } from '../session/compact.js';
import { config } from '../config/index.js';
import {
  MAX_HISTORY_RESULT,
  MAX_SKILL_RESULT,
  MAX_MEMORY_RESULT,
} from '../tools/constants.js';

let booted = false;
/** 懒注册内置 encoder(首次调用 optimizeToolResult 时触发,避免模块加载期循环 import)。 */
function boot(): void {
  if (booted) return;
  registerAll(builtinEncoders);
  booted = true;
}

/** 解析工具 arguments JSON;非法或空返 null(同 agent/core.ts parseArgs 语义,独立实现避免循环依赖)。 */
function tryParseArgs(raw: string): Record<string, unknown> | null {
  try {
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/**
 * 按工具名取软目标 budget(字符)。对齐 capToolResultForHistory 的放宽规则:
 * use_skill / memory_search 走放宽上限(指令 / 记忆正文须完整);其余走 MAX_HISTORY_RESULT。
 * 仅作 encoder 软目标;最终裁剪仍由末尾 capToolResultForHistory 兜底,故两处常量偶有漂移不致命。
 */
function budgetFor(name: string): number {
  if (name === 'use_skill' || name === 'run_skill') return MAX_SKILL_RESULT;
  if (name === 'memory_search') return MAX_MEMORY_RESULT;
  return MAX_HISTORY_RESULT;
}

/**
 * 优化工具结果为进 LLM 的 tool 消息 content。
 *
 * @param name 工具名
 * @param output executeTool 的原始返回字符串
 * @param argsRaw 工具 arguments 原始 JSON 字符串(tc.arguments,可空;未传则 args=null)
 * @returns 进 history 的 content 字符串(永不抛错)
 */
export function optimizeToolResult(
  name: string,
  output: string,
  argsRaw?: string,
  context: EncoderRuntimeContext = {},
): string {
  boot();
  // Disabled by default: normal history is raw apart from the hard cap.
  if (!config.contextOptimize) {
    return capToolResultForHistory(name, output);
  }
  try {
    const args = argsRaw != null ? tryParseArgs(argsRaw) : null;
    const kind = classify(name, output, args);
    const enc: ContextEncoder = getEncoder(kind) ?? passthroughEncoder;
    const { text } = enc.encode({
      toolName: name,
      output,
      args,
      budget: budgetFor(name),
      age: context.age ?? 0,
      isCold: context.isCold ?? false,
      isFirstRead: context.isFirstRead,
      phase: context.phase ?? 'push',
    });
    // 末尾长度裁剪兜底(同改造前):encoder 已更短则 no-op;use_skill/memory_search 的放宽 cap 由此保留。
    return capToolResultForHistory(name, text);
  } catch {
    // encoder 报错(不应发生,纯函数):回落原 output + cap(永不抛错契约)。
    return capToolResultForHistory(name, output);
  }
}
