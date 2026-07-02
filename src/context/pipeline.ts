// Context Optimization Pipeline 单一入口。
//
// 接管"工具结果进 LLM 前"的表示优化(C1 收口,agent/core.ts pushToolResult 调)。
// 流程:
//   1) 解析 argsRaw(失败返 null,encoder 据此降级)。
//   2) classify(name, output, args) → ContextKind。
//   3) getEncoder(kind) ?? passthrough → encode(保不变量压缩,纯函数)。
//   4) capToolResultForHistory(name, text) 作末尾长度裁剪兜底(保 head+标记+tail,与改造前一致)。
//
// 不抛错:encoder 报错 → catch 回落原 output + capToolResultForHistory(对齐「调度器永不抛错」)。
// 兜底零行为变化:未注册 encoder / pipeline 关闭 → passthrough identity → 末尾 cap 与改造前逐字节一致。
//
// 兼容:不改 Tool Calling JSON schema、不改 executeTool、不改 tool_call_id 配对、不改 TUI 渲染
// (hooks.onToolResult 用原始 output,本函数只管进 history 的 content)。
//
// 依赖方向:context → {tools/constants, session/compact 的 cap, config};叶子,不反向依赖 llm/agent/tools。

import type { ContextEncoder } from './types.js';
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
  if (name === 'use_skill') return MAX_SKILL_RESULT;
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
): string {
  boot();
  // 总开关关闭:完全走老路径,零行为变化(Phase 1 默认 true,但保留紧急回退开关)。
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
    });
    // 末尾长度裁剪兜底(同改造前):encoder 已更短则 no-op;use_skill/memory_search 的放宽 cap 由此保留。
    return capToolResultForHistory(name, text);
  } catch {
    // encoder 报错(不应发生,纯函数):回落原 output + cap(永不抛错契约)。
    return capToolResultForHistory(name, output);
  }
}
