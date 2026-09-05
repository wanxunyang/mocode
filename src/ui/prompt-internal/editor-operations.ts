export interface TextEditResult {
  text: string;
  cursor: number;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

/** 在光标处插入文本，返回更新后的文本与光标。 */
export function insertTextAt(text: string, cursor: number, inserted: string): TextEditResult {
  const at = clampCursor(text, cursor);
  return {
    text: text.slice(0, at) + inserted + text.slice(at),
    cursor: at + inserted.length,
  };
}

/** 删除光标前一个 UTF-16 单元；与 readline 提供的字符偏移语义保持一致。 */
export function deleteBackwardAt(text: string, cursor: number): TextEditResult {
  const at = clampCursor(text, cursor);
  if (at === 0) return { text, cursor: at };
  return {
    text: text.slice(0, at - 1) + text.slice(at),
    cursor: at - 1,
  };
}

/** 删除光标后的一个 UTF-16 单元。 */
export function deleteForwardAt(text: string, cursor: number): TextEditResult {
  const at = clampCursor(text, cursor);
  if (at === text.length) return { text, cursor: at };
  return {
    text: text.slice(0, at) + text.slice(at + 1),
    cursor: at,
  };
}

/** 删除当前逻辑行从行首到光标的内容。 */
export function deleteToLineStartAt(text: string, cursor: number): TextEditResult {
  const at = clampCursor(text, cursor);
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  if (lineStart === at) return { text, cursor: at };
  return {
    text: text.slice(0, lineStart) + text.slice(at),
    cursor: lineStart,
  };
}

/** 删除当前逻辑行从光标到行尾的内容；存在换行时一并删除换行并连接下一行。 */
export function deleteToLineEndAt(text: string, cursor: number): TextEditResult {
  const at = clampCursor(text, cursor);
  const newline = text.indexOf('\n', at);
  if (newline < 0) {
    return at === text.length ? { text, cursor: at } : { text: text.slice(0, at), cursor: at };
  }
  return {
    text: text.slice(0, at) + text.slice(newline + 1),
    cursor: at,
  };
}
