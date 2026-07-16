/**
 * 增量过滤部分 OpenAI 兼容后端直接混在 content 中的 <think>...</think>。
 *
 * 关键点：流式 chunk 可以在标签任意字符间切开，因此不能仅在当前 chunk 内查找，
 * 也不能把“短于标签”的缓冲直接输出。普通态还要吞掉孤立 </think>：部分后端把
 * reasoning 放在独立字段，却仍在 content 的开头附带闭标签。
 */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** 返回 text 末尾与任一 tag 前缀重合的最长长度。 */
function trailingTagPrefixLength(text: string, tags: readonly string[]): number {
  const max = Math.min(text.length, Math.max(...tags.map((tag) => tag.length - 1)));
  for (let length = max; length > 0; length--) {
    const suffix = text.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return length;
  }
  return 0;
}

/**
 * 每次 push 返回当前已经能够确认是正文的文本；标签和思考内容永不返回。
 * finish 必须在流结束时调用，以释放普通正文末尾暂存的 `<` 等潜在标签前缀。
 */
export class ThinkTagFilter {
  private buffer = '';
  private inThink = false;

  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let visible = '';

    while (this.buffer) {
      if (this.inThink) {
        const closeIdx = this.buffer.indexOf(THINK_CLOSE);
        if (closeIdx >= 0) {
          this.buffer = this.buffer.slice(closeIdx + THINK_CLOSE.length);
          this.inThink = false;
          continue;
        }

        if (final) {
          // 未闭合思考段一直丢弃，不能在流结束时误当正文释放。
          this.buffer = '';
          break;
        }

        // 思考正文可立即丢弃，只保留可能跨 chunk 组成 </think> 的后缀。
        const keep = trailingTagPrefixLength(this.buffer, [THINK_CLOSE]);
        this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
        break;
      }

      const openIdx = this.buffer.indexOf(THINK_OPEN);
      const closeIdx = this.buffer.indexOf(THINK_CLOSE);
      let tagIdx = -1;
      let tag = '';

      if (openIdx >= 0 && (closeIdx < 0 || openIdx < closeIdx)) {
        tagIdx = openIdx;
        tag = THINK_OPEN;
      } else if (closeIdx >= 0) {
        // 独立 reasoning_content 后偶发残留的孤立闭标签也属于协议噪声。
        tagIdx = closeIdx;
        tag = THINK_CLOSE;
      }

      if (tagIdx >= 0) {
        visible += this.buffer.slice(0, tagIdx);
        this.buffer = this.buffer.slice(tagIdx + tag.length);
        if (tag === THINK_OPEN) this.inThink = true;
        continue;
      }

      if (final) {
        visible += this.buffer;
        this.buffer = '';
        break;
      }

      // 只暂存“确实可能成为标签”的后缀；普通文本立即输出，不引入固定 6/7 字符延迟。
      const keep = trailingTagPrefixLength(this.buffer, [THINK_OPEN, THINK_CLOSE]);
      const emitLength = this.buffer.length - keep;
      visible += this.buffer.slice(0, emitLength);
      this.buffer = this.buffer.slice(emitLength);
      break;
    }

    return visible;
  }
}
