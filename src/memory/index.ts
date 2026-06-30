// memory barrel:Tier-1 MOCODE.md 懒加载(buildMemorySection,叶子)+ Tier-2 工具库 re-export。
// Tier-2:store.ts(叶子,node:fs)做 JSONL CRUD/GC/索引段;reflect.ts(→llm,同 session/)做后台反思 pass。
// 被 repl 依赖(注入 systemPrompt + 轮末触发反思 + 退出 drain)。Tier-1 仅依赖 discover.ts。

import { loadMemoryFiles } from './discover.js';

export {
  buildMemoryIndexSection,
  loadAll,
  gcMemories,
  type MemoryEntry,
  type MemoryIndexItem,
  type MemoryType,
  type MemoryStatus,
  type MemoryScope,
} from './store.js';

export {
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
  runReflection,
  type ReflectResult,
} from './reflect.js';

/** system 消息中 memory 段的字符上限(防过大占窗口——system 在 history[0],compactHistory 不压缩)。 */
const MAX_MEMORY_CHARS = 20000;

let cache: string | null = null;

/**
 * 合并全局 + 项目各级 MOCODE.md(远→近拼接,各段空行分隔),超 MAX_MEMORY_CHARS 截断 + 提示。
 * 懒加载(首次调用触发扫描;启动期 repl 调一次)。无 MOCODE.md 返空串。
 */
export function loadMemory(): string {
  if (cache !== null) return cache;
  const files = loadMemoryFiles();
  if (files.length === 0) {
    cache = '';
    return cache;
  }
  const body = files.map((f) => f.content).join('\n\n');
  if (body.length <= MAX_MEMORY_CHARS) {
    cache = body;
  } else {
    cache =
      body.slice(0, MAX_MEMORY_CHARS) +
      `\n\n…(项目记忆已截断 ${body.length - MAX_MEMORY_CHARS} 字符,完整见各级 MOCODE.md)`;
  }
  return cache;
}

/** 拼进系统提示的 memory 段;无 memory 返空串(零行为变化)。 */
export function buildMemorySection(): string {
  const mem = loadMemory();
  if (!mem) return '';
  return [
    '',
    '',
    '## 项目记忆(MOCODE.md)',
    '以下是项目记忆(架构 / 约定 / 命令等跨会话长期事实),据此行动:',
    mem,
  ].join('\n');
}
