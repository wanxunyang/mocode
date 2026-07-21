/**
 * agent 模式的共享状态(零依赖纯叶子)。
 *
 * 把 `agentMode` 从 repl 的模块变量提到这里,让三方都能用、且不破坏依赖单向:
 *  - `repl/index.ts` 读写它 + 注册 onModeChange 监听器(做 applyMode 重写 history[0] +
 *    refreshStatusBase 刷状态行 modeTag),并通过 /plan / /auto / Shift+Tab(c cycleMode) 触发切换。
 *  - `agent/index.ts` 每步读它(getAgentMode)——决定 chat() 用全量 chatTools 还是 planChatTools 只读子集,
 *    以及串行分支的 plan 防御 backstop。这样切换模式后,下一次 chat() 立即看到新工具集。
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

/** 当前 agent 模式。auto=全工具执行;plan=只读探查 + 产出计划(写盘/命令/记忆写入工具被 schema 剔除)。 */
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
