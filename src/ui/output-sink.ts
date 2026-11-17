/**
 * 非 TTY 输出闸门。
 *
 * `layout.contentWrite` / `Spinner` 在「布局没激活」时的兜底是直接 `stdout.write`——
 * 这是 REPL 在管道 / 重定向下仍能看到正文的保证。但 stdio host(work-app 的 agent 子进程)
 * 的 stdout 是 NDJSON 协议通道,裸文本进去就是**协议污染**:客户端 JSON.parse 失败 →
 * 当成 diagnostic → 用户什么都看不到(压缩行、图片卡片行、压缩 spinner 全在这里丢掉)。
 *
 * 所以 host 启动时把闸门关掉:兜底写被丢弃,真正的用户可见反馈改由 NDJSON 事件承载
 * (`context_compacted` / `image_relief` …)。REPL / headless 从不调 mute,行为零变化。
 */
let muted = false;

/** 关闭「非 TTY 直接写 stdout」的兜底。仅 stdio host 调用。 */
export function muteStdoutOutput(): void {
  muted = true;
}

/** 兜底写是否已被关闭(宿主需要自己承担输出时返回 true)。 */
export function isStdoutMuted(): boolean {
  return muted;
}

/** 测试用:复位闸门。 */
export function resetStdoutOutput(): void {
  muted = false;
}
