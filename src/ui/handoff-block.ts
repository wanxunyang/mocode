// 把 `<mocode_handoff>…</mocode_handoff>` 从**显示**路径上摘掉。
//
// 为什么需要：supervise 派活时，任务提示词要求 worker 以一个机器可读的交接块收尾
// （见 `orchestrator/task-prompt.ts`），控制面靠它解析 summary / validation / risks。
// 但 lane 窗口里跑的是**一个真的 mocode REPL**，模型的最后一条正文原样流式写屏，
// 于是那一大坨 JSON 就摊在用户眼前——它对人没有信息量，还把结论挤没了。
//
// 三条约束：
//   1. **只影响显示**。`finalText` 必须完整保留，否则 `parseHandoff` 拿不到块，任务判不出结论。
//   2. **必须跨 chunk**。流式是一小块一小块来的，标签本身会被切开（`<mocode_han` + `doff>`），
//      所以不能对每个 chunk 单独做正则替换。
//   3. **未闭合也要收场**。模型可能被中断、或忘了写闭合标签；flush() 时把残留吞掉，
//      不能因为「没等到闭合」就把半截 JSON 吐到屏幕上。

const OPEN = '<mocode_handoff>';
const CLOSE = '</mocode_handoff>';

/** 从 `text` 尾部找出「可能是 OPEN / CLOSE 前缀」的最长后缀长度，用于跨 chunk 保持。 */
function trailingPartial(text: string, tag: string): number {
  const max = Math.min(tag.length - 1, text.length);
  for (let size = max; size > 0; size--) {
    if (text.endsWith(tag.slice(0, size))) return size;
  }
  return 0;
}

export interface HandoffStripper {
  /** 喂一段流式正文，返回**可以显示**的部分（可能为空串）。 */
  push(chunk: string): string;
  /** 流末收尾：把仍被扣住的内容吐出来（未闭合的块直接丢弃）。 */
  flush(): string;
}

export function createHandoffStripper(): HandoffStripper {
  /** 已收到、但还没决定能不能显示的尾巴。 */
  let pending = '';
  /** true = 正处在一个 handoff 块内部（内容一律丢弃，直到遇到 CLOSE）。 */
  let inside = false;

  return {
    push(chunk: string): string {
      pending += chunk;
      let out = '';
      for (;;) {
        if (inside) {
          const end = pending.indexOf(CLOSE);
          if (end < 0) {
            // 还没闭合：只保留可能是 CLOSE 前缀的尾巴，其余全部丢弃。
            const keep = trailingPartial(pending, CLOSE);
            pending = keep > 0 ? pending.slice(-keep) : '';
            return out;
          }
          pending = pending.slice(end + CLOSE.length);
          inside = false;
          // 块后面紧跟的空行/换行一并吃掉，避免正文区留一片空白。
          pending = pending.replace(/^[ \t]*\r?\n/, '');
          continue;
        }
        const start = pending.indexOf(OPEN);
        if (start >= 0) {
          out += pending.slice(0, start);
          pending = pending.slice(start + OPEN.length);
          inside = true;
          continue;
        }
        // 没有完整标签：保留可能是 OPEN 前缀的尾巴，其余可以安全显示。
        const keep = trailingPartial(pending, OPEN);
        out += keep > 0 ? pending.slice(0, pending.length - keep) : pending;
        pending = keep > 0 ? pending.slice(-keep) : '';
        return out;
      }
    },
    flush(): string {
      // 块内未闭合：整段丢弃（那是协议残渣，不是给人看的内容）。
      if (inside) {
        pending = '';
        inside = false;
        return '';
      }
      // 块外但只剩一个标签前缀（`<mocode_han`）：这一轮永远等不到它的后半截了，
      // 吐出去只会让人看见半截标签，同样丢弃。
      const rest = trailingPartial(pending, OPEN) === pending.length ? '' : pending;
      pending = '';
      return rest;
    },
  };
}

/**
 * 进程级开关：只有「派出去的那个 mocode 窗口」需要摘块。
 *
 * 用进程级而不是每轮参数，是因为过滤发生在 `agent/index.ts` 的 TUI hooks 里，那条路径
 * 拿不到调用方上下文；而 lane 窗口本身是独立进程，一个开关就够且不会串味。
 * 手动敲 `mocode` 的窗口永远不打开它（默认 false）。
 */
let suppressed = false;

export function setHandoffDisplaySuppressed(value: boolean): void {
  suppressed = value;
}

export function handoffDisplaySuppressed(): boolean {
  return suppressed;
}
