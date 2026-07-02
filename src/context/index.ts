// context/ barrel:Context Optimization Pipeline。
//
// 单一入口 optimizeToolResult(agent/core.ts pushToolResult 调)接管"工具结果进 LLM 前"的表示。
// 不调 LLM、不碰 Tool Calling schema / executeTool / tool_call_id 配对 / TUI 渲染
// (叶子级:仅 stdlib + tools/constants + session/compact 的 capToolResultForHistory 兜底 + config 开关)。
//
// 见 CLAUDE.md「Context Optimization Pipeline」节。

export { optimizeToolResult } from './pipeline.js';
export type {
  ContextKind,
  ContextEncoder,
  EncoderInput,
  EncoderOutput,
} from './types.js';
export { classify, knownToolKinds } from './classifier.js';
export {
  registerEncoder,
  registerAll,
  getEncoder,
  registeredKinds,
} from './registry.js';
