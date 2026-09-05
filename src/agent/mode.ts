/**
 * agent 模式的共享状态(零依赖纯叶子)。
 *
 * 把 `agentMode` 从 repl 的模块变量提到这里,让三方都能用、且不破坏依赖单向:
 *  - `repl/index.ts` 读写它 + 注册 onModeChange 监听器(做 applyMode 重写 history[0] +
 *    refreshStatusBase 刷状态行 modeTag),并通过 /plan / /auto / Shift+Tab(c cycleMode) 触发切换。
 *  - `agent/index.ts` 每步读取模式：PLAN 只暴露只读能力；AUTO 允许执行，但实际工具面由
 *    每个真实用户 turn 的 ToolPolicy 路由并可在后续 step 单向扩容。
 *  - 模型不再持有 switch_mode 工具(已砍):模式切换只能由用户面触发。
 *
 * 依赖方向无环:本模块不 import 任何业务模块。
 *
 * listener 同步触发:setAgentMode 在变更模式后同步调 listener(无 async)。repl 的
 * cycleMode / /plan / /auto 在 executeTool 路径之外调 setAgentMode → listener 同步
 * applyMode(重写 history[0])+ refreshStatusBase;切换后下一步 chat() 读到新模式 +
 * 新系统提示,一致。
 */

export type AgentMode = 'auto' | 'plan';

let currentMode: AgentMode = 'auto';
let listener: ((m: AgentMode) => void) | null = null;

/** 当前 agent 模式。auto=按任务路由能力并执行；plan=只读探查 + 产出计划。 */
export function getAgentMode(): AgentMode {
  return currentMode;
}

/**
 * 设置 agent 模式。同模式 no-op(不触发 listener)。变更时同步触发 onModeChange 注册的监听器
 * (repl 在 startRepl 注册:applyMode 重写 history[0] + refreshStatusBase 刷状态行)。
 * 返回之前的模式,供调用方(如 runAgent 中断恢复)还原。
 */
export function setAgentMode(m: AgentMode): AgentMode {
  const prev = currentMode;
  if (prev === m) return prev;
  currentMode = m;
  try {
    listener?.(m);
  } catch {
    // listener 不应抛(applyMode/refreshStatusBase 都不抛);兜底,不阻断工具执行。
  }
  return prev;
}

/** 注册模式变更监听器(单一,后注册覆盖先注册)。repl 在 startRepl 启动时注册一次。 */
export function onModeChange(cb: (m: AgentMode) => void): void {
  listener = cb;
}
