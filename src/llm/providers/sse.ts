/**
 * 最小 SSE 解析器：供各原生协议 provider（Anthropic / Gemini …）共享。
 *
 * 只处理 `event:` / `data:` 行与空行分隔；多个 data 行按规范用 \n 拼接。
 * 不认识的行（id:/retry:/注释）忽略。
 */
export interface SseRecord {
  event: string;
  data: string;
}

export function decodeSseRecord(record: string): SseRecord | null {
  let event = '';
  const data: string[] = [];
  for (const line of record.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** 按 SSE 事件边界（空行）切分流式响应体；响应结束时冲刷尾段。 */
export async function* readSse(response: Response): AsyncIterable<SseRecord> {
  if (!response.body) throw new Error('流式响应缺少 body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const record = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = decodeSseRecord(record);
      if (parsed) yield parsed;
    }
    if (done) break;
  }
  const parsed = decodeSseRecord(buffer);
  if (parsed) yield parsed;
}
