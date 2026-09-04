/**
 * 斜杠命令分发的契约:CommandContext(闭包依赖显式化)+ CommandOutcome(替代 if 链里的 continue/break)。
 *
 * 为什么需要 CommandContext:
 * 原先所有命令都是 startRepl 内部的 if 分支,直接捕获闭包变量(history / currentSessionId /
 * runTurn / resumeFromPick …)。搬到独立文件后这些变量必须显式传入,否则编译不过。
 *
 * 为什么用访问器而不是传值:
 * currentSessionId / turnCount / lastTurnUsage / queryHistory 是 startRepl 的 `let`,
 * 命令会**写**它们(/clear 换新 session id、/resume 换整个会话)。传值会丢失写回。
 * 这里用 get/set 访问器把闭包变量本身暴露出去,runtime 侧的 `let` 保持原位不动——
 * 拆分只搬代码,不搬状态,改动面最小、回归风险最低。
 *
 * 为什么 history 直接传数组引用:
 * history 是 `const` 数组,命令靠原地 mutate 改它(history.length = 1、history[0] = …、
 * push)。引用传递即可,不需要访问器。
 */
import type { ChatMessage, ChatUsage } from '../../llm/index.js';
import type { ContextState } from '../../session/compact.js';
import type { ImageAttachment } from '../../attachments/image.js';
import type { SessionPickerItem } from '../../ui/prompt.js';

/** startRepl 闭包中命令需要的可写标量。访问器形式,保证写回原变量。 */
export interface MutableReplState {
  currentSessionId: string | undefined;
  /** 本轮 token 累计(undefined = 后端未开 include_usage 或失败)。 */
  lastTurnUsage: ChatUsage | undefined;
  /** 反思 cadence 计数。 */
  turnCount: number;
  /** 输入历史(↑↓ 回溯用)。/resume 会整个换掉。 */
  queryHistory: string[];
}

/** 命令 handler 拿到的一切依赖。 */
export interface CommandContext {
  /** 完整输入行(trim 后),命令自己解析子参数。 */
  readonly line: string;
  /** line 的首个空白分隔词,如 '/model'。 */
  readonly cmd: string;
  /** 多行输入数组(部分命令要按行数算气泡高度)。 */
  readonly inputLines: string[];

  /** 对话历史。**原地 mutate**(length 截断 / [0] 替换 / push),不要重新赋值。 */
  readonly history: ChatMessage[];
  /** 上下文状态单例(runtime 与命令共享同一对象)。 */
  readonly contextState: ContextState;

  /** 可写闭包标量。经访问器读写,写回 startRepl 的 `let`。 */
  readonly state: MutableReplState;

  /** 待发图片附件(模块级,runtime 与命令共享)。 */
  readonly attachments: {
    list(): ImageAttachment[];
    clear(): void;
    push(att: ImageAttachment): void;
  };

  /** 现拼 system 提示(auto 用 base;plan 追加 plan suffix)。 */
  readonly buildSystemMessage: (planMode: boolean) => string;
  /** 顶部横幅信息(bannerLines 的入参)。 */
  readonly banner: () => {
    model: string;
    baseURL: string;
    cwd: string;
    tools: string;
    memoryEnabled: boolean;
  };
  /** 欢迎引导块行(/clear 后重写)。 */
  readonly welcomeLines: () => string[];

  /** 刷状态行基线(不改滚动位置)。 */
  readonly refreshStatusBase: (history: ChatMessage[], usage?: ChatUsage) => void;
  /** 切 agent 模式并重写 history[0] + 状态行 modeTag。 */
  readonly applyMode: (planMode: boolean) => void;
  /** auto ↔ plan 循环切换。 */
  readonly cycleMode: () => void;

  /** 跑一轮 agent。返回是否成功(未中断 / 未抛错)。 */
  readonly runTurn: (input: string, planMode: boolean, placeholder: string) => Promise<boolean>;
  /** 把 picker 选中的会话加载进 REPL(/resume /sessions 共用)。 */
  readonly resumeFromPick: (pick: SessionPickerItem | null) => Promise<void>;
  /** /rollback 交互流程(选轮次 → 选文件 → 回滚)。 */
  readonly rollbackFlow: () => Promise<void>;
}

/**
 * 命令执行结果。替代原 if 链里的 `continue` / `break` / fall-through。
 *
 * - `unhandled`:这条命令不归我管,registry 继续往下找。
 *   增量迁移期间必需——handler 自己判断是否匹配,能 100% 保持原语义,
 *   包括 `/pet quit` 必须排在 `/pet` 之前这类顺序依赖。
 * - `next`:回 INPUT 态(对应 `continue`,绝大多数命令)。
 * - `exit`:退出主循环(对应 `break`,只有 /exit /quit)。
 * - `forward`:改写输入后当普通消息发给 agent(对应 fall-through + forwardToAgent,如 /init)。
 */
export type CommandOutcome =
  | { readonly kind: 'unhandled' }
  | { readonly kind: 'next' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'forward'; readonly input: string };

/** 单个斜杠命令的 handler。 */
export type CommandHandler = (ctx: CommandContext) => Promise<CommandOutcome> | CommandOutcome;

export const unhandled = (): CommandOutcome => ({ kind: 'unhandled' });
export const next = (): CommandOutcome => ({ kind: 'next' });
export const exit = (): CommandOutcome => ({ kind: 'exit' });
export const forward = (input: string): CommandOutcome => ({ kind: 'forward', input });
