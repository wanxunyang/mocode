import type { Tool } from '../types.js';
import { setAgentMode, getAgentMode, type AgentMode } from '../../agent/mode.js';

// ---------- switch_mode ----------
export const switchModeTool: Tool = {
  name: 'switch_mode',
  description: [
    'Switch the agent mode between "plan" (read-only investigation + planning) and "auto" (full tool execution).',
    'In plan mode, write_file / edit_file / run_command / memory_save / memory_update / memory_forget are disabled; in auto mode, all tools are available.',
    'Use this to autonomously transition from planning to execution WITHIN THE SAME TURN: investigate in plan mode, produce a plan, then call switch_mode("auto") and continue implementing it in the same turn — ONLY when the user has explicitly asked you to "plan first then execute" / "先 plan 再 auto" / autonomous execution.',
    'Do NOT switch to auto if the user entered plan mode manually (via /plan or Shift+Tab) for a safety review — in that case present the plan and STOP; the user will approve via a prompt and execution happens in a follow-up turn.',
    'Switching to plan from auto is rarely needed; do it only if you realize you should investigate before changing anything.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['auto', 'plan'],
        description: 'Target mode: "plan" (read-only) or "auto" (full tools)',
      },
    },
    required: ['mode'],
  },
  async execute(args) {
    const target = String(args.mode) as AgentMode;
    if (target !== 'auto' && target !== 'plan') {
      return `错误:mode 必须是 "auto" 或 "plan",收到 "${target}"`;
    }
    const prev = getAgentMode();
    if (prev === target) {
      return `已在 ${target} 模式,无需切换。`;
    }
    setAgentMode(target); // 触发 listener:repl 重写 history[0] 系统提示 + 刷状态行 modeTag
    if (target === 'auto') {
      return [
        `已从 plan 切换到 auto 模式。`,
        `写盘 / 命令 / 记忆写入工具(write_file / edit_file / run_command / memory_save / memory_update / memory_forget)现已恢复可用。`,
        `请按你刚才产出的计划继续执行(同一轮内,无需重述计划)。`,
      ].join('\n');
    }
    return [
      `已从 auto 切换到 plan 模式(只读探查)。`,
      `写盘 / 命令 / 记忆写入工具已禁用;只用 read_file / glob / grep / codegraph / web_search / web_fetch / use_skill / ask_human / memory_search / memory_list 探查。`,
      `产出计划后 STOP 等用户审批,或(若用户要求自主执行)再调 switch_mode("auto") 续跑。`,
    ].join('\n');
  },
};
