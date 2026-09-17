/**
 * 「回滚到第 N 条用户消息之前」的会话截断规则 —— 从 main.ts 抽出来是有意的:
 * 它是一份纯函数(get 一份会话记录 → 就地砍到指定位置),可以脱离 Electron 直接验证。
 *
 * 为什么只截断 history,别的字段也要跟着动:
 *   · queryHistory —— core 用它做标题/摘要,与 user 消息一一对应,不截会残留被回滚掉的提问;
 *   · lastToolGroups —— 属于被回滚掉的那一轮,留着会让下一次请求沿用错误的工具范围;
 *   · firstUser —— 列表展示用的元信息,得跟着剩余的第一条 user 重算(可能已经没有 user 了)。
 */
export interface RawSessionRecord {
  history: Array<Record<string, unknown>>;
  queryHistory?: string[];
  lastToolGroups?: unknown[];
  firstUser?: string;
}

function contentTextOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * 把会话砍到「第 userIndex 条用户消息」之前 —— 那条 user 本身以及它之后的一整轮都作废。
 * userIndex 是**用户消息序号**(不是 history 数组下标):中间夹着多少 tool / assistant 都不影响。
 */
export function truncateSessionAtUser(record: RawSessionRecord, userIndex: number): { ok: boolean; message?: string } {
  if (!record || !Array.isArray(record.history)) return { ok: false, message: '会话文件里没有历史记录。' };
  const userAt: number[] = [];
  record.history.forEach((message, index) => { if (message.role === 'user') userAt.push(index); });
  if (!Number.isInteger(userIndex) || userIndex < 0 || userIndex >= userAt.length) {
    // 上下文压缩会把老消息换成摘要 —— 那一刻起这条 user 已不在会话里,索引无从谈起。
    return { ok: false, message: '这一步已经被上下文压缩掉了,回滚不到它。' };
  }
  const remaining = record.history.slice(0, userAt[userIndex]!);
  record.history = remaining;
  if (Array.isArray(record.queryHistory)) record.queryHistory = record.queryHistory.slice(0, userIndex);
  record.lastToolGroups = [];
  const nextFirstUser = remaining.find((message) => message.role === 'user');
  record.firstUser = nextFirstUser ? contentTextOf(nextFirstUser).replace(/\n/g, ' ').trim().slice(0, 40) : '';
  return { ok: true };
}
