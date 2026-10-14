/**
 * 「回滚到第 N 条用户消息之前」的会话截断规则 —— 从 main.ts 抽出来是有意的:
 * 它是一份纯函数(get 一份会话记录 → 就地砍到指定位置),可以脱离 Electron 直接验证。
 *
 * 为什么只截断 history,别的字段也要跟着动:
 *   · queryHistory —— core 用它做标题/摘要,与 user 消息一一对应,不截会残留被回滚掉的提问;
 *   · lastToolGroups —— 属于被回滚掉的那一轮,留着会让下一次请求沿用错误的工具范围;
 *   · firstUser —— 列表展示用的元信息,得跟着剩余的第一条 user 重算(可能已经没有 user 了)。
 *
 * 失败文案由调用方注入(`messages`),纯函数本身不依赖 i18n —— 这样它能脱离主进程单测,
 * 又能让主进程按当前语言把提示本地化。
 */
export interface RawSessionRecord {
  history: Array<Record<string, unknown>>;
  queryHistory?: string[];
  lastToolGroups?: unknown[];
  firstUser?: string;
}

/** 截断失败时的提示文案;缺省时回退到 key 名（仅用于无 i18n 的测试场景）。 */
export interface TruncateMessages {
  noHistory: string;
  compacted: string;
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
 * 工具经 modelAttachments 注入的合成 user 消息前言(与 core 的
 * agent/tool-turn.ts ATTACHMENT_PREAMBLE、rollback/store.ts 中的副本保持一致)。
 * 这类消息 role 也是 'user' 但不是一个真实用户轮,把它算进 user 序号会让
 * 「回滚到这条消息之前」切错位置、连带删掉后面好几轮真实对话。
 */
const TOOL_ATTACHMENT_PREAMBLE = 'The read_file tool loaded the following visual input: ';
/** 视觉滑动窗口剪枝占位前缀(与 core 的 context/vision-window.ts PRUNED_FRAME_PREFIX 保持一致)。 */
const PRUNED_FRAME_PREFIX = '[screenshot omitted: ';

/** role==='user' 且不是工具附件注入/剪枝占位的合成消息,才算一个真实用户轮。 */
function isRealUserMessage(message: Record<string, unknown>): boolean {
  if (message.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') return !content.startsWith(PRUNED_FRAME_PREFIX);
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      if (text.startsWith(TOOL_ATTACHMENT_PREAMBLE) || text.startsWith(PRUNED_FRAME_PREFIX)) return false;
    }
  }
  return true;
}

/**
 * 把会话砍到「第 userIndex 条用户消息」之前 —— 那条 user 本身以及它之后的一整轮都作废。
 * userIndex 是**用户消息序号**(不是 history 数组下标):中间夹着多少 tool / assistant 都不影响。
 */
export function truncateSessionAtUser(record: RawSessionRecord, userIndex: number, messages: TruncateMessages): { ok: boolean; message?: string } {
  if (!record || !Array.isArray(record.history)) return { ok: false, message: messages.noHistory };
  const userAt: number[] = [];
  record.history.forEach((message, index) => { if (isRealUserMessage(message)) userAt.push(index); });
  if (!Number.isInteger(userIndex) || userIndex < 0 || userIndex >= userAt.length) {
    // 上下文压缩会把老消息换成摘要 —— 那一刻起这条 user 已不在会话里,索引无从谈起。
    return { ok: false, message: messages.compacted };
  }
  const remaining = record.history.slice(0, userAt[userIndex]!);
  record.history = remaining;
  if (Array.isArray(record.queryHistory)) record.queryHistory = record.queryHistory.slice(0, userIndex);
  record.lastToolGroups = [];
  const nextFirstUser = remaining.find((message) => isRealUserMessage(message));
  record.firstUser = nextFirstUser ? contentTextOf(nextFirstUser).replace(/\n/g, ' ').trim().slice(0, 40) : '';
  return { ok: true };
}
