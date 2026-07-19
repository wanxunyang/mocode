// session/state.ts - 会话状态跟踪模块
// 提供当前活跃会话 ID 的全局访问点，供 config/buildNotepadSection 等读取会话级 notes.md。
// 避免 repl/index.ts ↔ config/index.ts 循环依赖。

let currentSessionId: string | undefined;

/** 获取当前活跃会话 ID(供 buildNotepadSection 等使用)。 */
export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}

/**
 * 设置当前活跃会话 ID。notes.md 由 agent 按需创建；这里不能预建空文件，
 * 否则 write_file(expected_hash=null) 的首次创建会必然冲突。
 * 由 repl/index.ts 在会话启动 / /resume 切换时调用。
 */
export function setCurrentSessionId(id: string | undefined, cwd: string): void {
  currentSessionId = id;
  void cwd;
}
