/**
 * 记忆写入总闸(R8.3 暂停 / R8.5 关闭即无文件)。
 *
 * 为什么单独成叶子模块:写入出口横跨 `store.ts`(条目)、`graph.ts`(图谱)、
 * `pending.ts`(压缩候选)三处,而 `graph.ts` 已经 `import type` 自 `store.ts`。
 * 把闸门放在 store 里会让 graph 反向依赖 store 的运行时值,形成环;抽成只依赖
 * node 内置的叶子,三处都能 import 而互不牵连。
 *
 * 判据与 `config/index.ts` 的 `isMemoryEnabled()` **刻意保持一致**:只有显式
 * `MEMORY_ENABLED=false` 才算关闭。这里不 import config(config → tools → memory 会成环),
 * 因而重复了一行判断——这是刻意的重复,不是遗漏。
 */

/**
 * 本会话是否暂停写入(`/memory pause`)。读取、检索、注入、画像全部照常,只停写入。
 *
 * 为什么是进程内变量而不是 env:`pause` 的语义是「本会话」——用户退出重开时不该还关着。
 * 而 env 会随配置文件持久化,反而把「临时封口」变成「永久静默」。两者刻意分开:
 * 关闭走 env(那是配置),暂停走这个变量。
 */
let writesPaused = false;

export function setMemoryWritesPaused(paused: boolean): void {
  writesPaused = paused;
}

export function isMemoryWritesPaused(): boolean {
  return writesPaused;
}

/** 仅供测试:重置暂停状态,避免用例间串味。 */
export function __resetMemoryPauseForTests(): void {
  writesPaused = false;
}

/** 写入被拦的原因;null = 允许写。 */
export function memoryWriteBlockReason(): 'paused' | 'disabled' | null {
  if (writesPaused) return 'paused';
  if (process.env.MEMORY_ENABLED === 'false') return 'disabled';
  return null;
}

/**
 * 写入被总闸拦下时,各写操作统一的失败形状。
 *
 * 为什么不让它们静默成功:调用方(`memory_save` 工具、反思、情节收尾)会据此告诉用户
 * 「已保存」——而实际什么都没写。R8.3 的价值就在于用户能明确知道「这轮没记下来」。
 */
export interface MemoryWriteBlocked {
  ok: false;
  blocked: 'paused' | 'disabled';
}

/** 给调用方用的一句话解释(工具输出 / 命令提示共用同一措辞)。 */
export function memoryWriteBlockedMessage(blocked: 'paused' | 'disabled'): string {
  return blocked === 'paused'
    ? '记忆写入已暂停(/memory pause),本次未保存。用 /memory pause off 恢复。'
    : '记忆子系统已关闭(MEMORY_ENABLED=false),本次未保存。用 /memory_switch 打开。';
}
