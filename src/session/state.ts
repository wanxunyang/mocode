// session/state.ts - 会话状态跟踪模块
// 提供当前活跃会话 ID 的全局访问点，供 config/buildNotepadSection 等读取会话级 notes.md。
// 避免 repl/index.ts ↔ config/index.ts 循环依赖。

let currentSessionId: string | undefined;

/** 获取当前活跃会话 ID(供 buildNotepadSection 等使用)。 */
export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}

/**
 * 设置当前活跃会话 ID，并确保该会话的 notes.md 文件存在（不存在则创建空文件）。
 * 由 repl/index.ts 在会话启动 / /resume 切换时调用。
 */
export function setCurrentSessionId(id: string | undefined, cwd: string): void {
  currentSessionId = id;
  void cwd;
}
