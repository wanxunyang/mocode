/**
 * 「流中途被打断」的显式标记。
 *
 * 为什么需要它:能否安全重试取决于「错误是否发生在响应流**里面**」(HTTP 层已 200 建连),
 * 而这类错误的判定只能由**抛错方**知道 —— OpenAI 兼容路径是 SDK 造的 status-less `APIError`,
 * Anthropic 路径是 SSE `event: error`(一个 name 被设成供应商错误类型的普通 Error)。
 * 与其在 transport 层猜 vendor 的错误名,不如让 provider 在抛错时打标。
 *
 * 独立成 leaf 模块(零 import):`llm/index.ts` 与 `llm/providers/*.ts` 都要用它,
 * 而 providers 只对 index 做 type-only import(见 provider.ts 头注),放 index 会成环。
 *
 * 只标记「错误类别」,不代表可以无条件重试:调用方仍必须叠加「本次尝试零产出」前提
 * (见 chatWithRuntime 的 producedOutput),否则重试会在内容区重放半截文本。
 */
const interrupted = new WeakSet<object>();

/** 由 provider 在「响应流内部报错」时调用,标记该错误为可重试的流中断。 */
export function markStreamInterrupted(err: unknown): void {
  if (err && typeof err === 'object') interrupted.add(err as object);
}

/** 该错误是否被标记为流中途中断。 */
export function isMarkedStreamInterrupted(err: unknown): boolean {
  return !!err && typeof err === 'object' && interrupted.has(err as object);
}
