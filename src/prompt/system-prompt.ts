/**
 * 一份系统提示的唯一组装点。
 *
 * 存在理由：这套段组合原先在两处各写一遍——REPL（src/repl/runtime.ts 的 buildSystemMessage）
 * 与 stdio host（src/host/stdio.ts 的 systemMessage）。host 那份只拼了 buildBasePrompt +
 * effectiveSystemPrompt，漏掉 About you / Memory Index / Episode / Project graph hint / plan 段，
 * 结果是「记忆开关打开、记忆库装满，工作台里的模型却从没见过它」。
 *
 * 段顺序是契约，不是风格：
 *   1. buildBasePrompt 的静态主体在前 → 支持 prompt caching 的后端能命中前缀；
 *   2. 会话级/主题级段落按 REPL 的原顺序追加；
 *   3. plan 段插在 About you 与 Memory Index 之间（与 REPL 一致，改动会让两端口径分叉）。
 *
 * 本模块刻意不 import 任何 UI 模块：host、REPL、以及将来的 GUI 都能安全调用。
 */
import { buildBasePrompt, getPlanModeSuffix, isMemoryEnabled } from '../config/index.js';
import { effectiveSystemPrompt } from '../skills/index.js';
import {
  buildAboutYouSection,
  buildEpisodeSection,
  buildMemoryIndexSection,
  buildProjectGraphHint,
} from '../memory/index.js';

export interface SystemPromptOptions {
  /** 会话 id；缺省走 config 的当前会话（REPL 之外通常显式传）。 */
  sessionId?: string;
  /** 是否处于 plan 模式：true 时追加只读行为约束段。 */
  planMode?: boolean;
  /**
   * 记忆总开关覆盖。缺省现读 isMemoryEnabled()——REPL 在 /memory_switch 之后重建 history[0]
   * 时依赖「现读」才能立即生效，所以不要把它缓存成模块常量。
   */
  memoryEnabled?: boolean;
}

/** base + About you + (plan) + Memory Index + Episode + Project graph hint + Skills 段。 */
export function buildSystemMessage(options: SystemPromptOptions = {}): string {
  const memoryOn = options.memoryEnabled ?? isMemoryEnabled();
  const base = options.sessionId ? buildBasePrompt(options.sessionId) : buildBasePrompt();
  return (
    effectiveSystemPrompt(base) +
    buildAboutYouSection(memoryOn) +
    (options.planMode ? getPlanModeSuffix() : '') +
    buildMemoryIndexSection(memoryOn) +
    // R6.3:情节走独立小节（不进 Memory Index / 不进 About you，理由见 memory/episodic.ts）。
    buildEpisodeSection(memoryOn) +
    buildProjectGraphHint(memoryOn)
  );
}
