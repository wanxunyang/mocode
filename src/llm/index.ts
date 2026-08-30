import OpenAI from 'openai';
import { config, getActiveModel, isSubAgentEnabled, isFrontendToolsEnabled } from '../config/index.js';
import { tools } from '../tools/registry.js';
import { getPlanDisabledTools, FRONTEND_TOOLS } from '../tools/constants.js';
import { ThinkTagFilter } from './think-filter.js';
import { anthropicChatOnce } from './providers/anthropic.js';

// 强制关闭第三方调试日志泄漏:openai SDK 在 process.env.DEBUG === 'true' 时用裸
// console.log 把请求/响应直写 stdout,会污染 TUI 输入框(并泄露 headers/URL)。
// 仅拦截 'true' 这一开关值——保留 namespace 形式的 DEBUG(如 DEBUG=express:*) 调试能力。
// 必须在 OpenAI 客户端实例化之前执行,确保任何实例都不再触发 debug 输出。
if (process.env.DEBUG === 'true') {
  process.env.DEBUG = 'false';
}

/**
 * LLM 调用重试策略:
 *   可重试  →  429 (rate limit) / 5xx (server) / APIConnectionError / Node 网络错 (ETIMEDOUT 等)
 *   不重试  →  400 (bad request) / 401 (auth) / 其他 4xx / 用户中断 (AbortError / APIUserAbortError)
 *
 * 退避:指数 + ±20% jitter,首等 1s,翻倍,封顶 30s;若后端返回 Retry-After 头则优先按其值。
 * 默认 4 次尝试(1 初始 + 3 重试),要调改 RETRY_MAX_ATTEMPTS。
 *
 * SDK 内置 maxRetries 默认 2(对所有 5xx+网络错重试),与本策略叠加会双重重试 5xx —— 显式置 0 让
 * 全部重试由 chat() 外层重试循环统一控,行为可预期。
 */
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const RETRY_JITTER = 0.2;

/**
 * 流式响应里出现的推理模型自创 `think` 标签(DeepSeek R1 / Qwen3 / 部分自训模型):
 * 与 OpenAI 兼容协议的独立 `reasoning_content` 字段不同,这些模型把 thinking 直接嵌进 content
 * 字符串,期间不调 onText(spinner 持续转 ⠹ 思考中…),也不写入可见 content(history 不被思考段污染)。
 */
let client = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
  maxRetries: 0,
});

/**
 * 运行时重建 OpenAI 客户端(/model 切换 baseURL/apiKey 后调)。
 * config.model 已在 chat() 每次读取(热切),但 client 的 baseURL/apiKey 是构造时固化的实例字段,
 * 改 config 后必须重建 client 才能让新 baseURL/apiKey 对后续请求生效。
 * 子 agent 复用本模块 chat(),故只此一处重建即全链路生效。
 */
export function reconfigureClient(): void {
  client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxRetries: 0,
  });
}

// ── 重试 helper(纯函数 + sleep,被 chat() 调用;亦可单测导入验证)──────

/** 可被 AbortSignal 取消的 sleep;signal 已 abort 时立即抛 AbortError。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const t = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('This operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 判定一个 chat 失败是否值得重试。
 * 用户中断(signal.aborted / AbortError / APIUserAbortError)始终返回 false,避免退避中把中断吞了。
 * 4xx(除 429)全不重试 —— 这是客户端请求错,重试只会再错一次。
 */
export function isRetryableError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    status?: number;
    code?: string;
    message?: string;
  };
  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return false;
  // OpenAI SDK APIError 走 status 分支(覆盖 4xx/5xx/429)
  const status = e.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Node 网络错 code(APIConnectionError 内部也会带一个)
  const code = e.code;
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  // OpenAI SDK 的网络错类(无 status)
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
  // 兜底:错误信息里出现 timeout 字样(部分代理把错误折叠成普通 Error)
  if (typeof e.message === 'string' && /\btime(d|ed)?\s*out\b|ETIMEDOUT/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * 判定一次失败是否是「请求上下文超长」(后端实测拒绝了我们的 prompt)。
 *
 * 与压力线(本地启发式估算)的区别:这是**实测**信号。估算对某些 provider 会系统性偏低
 * (CJK 分词、多模态、特殊 schema),压力线压不住时,后端这声 400 是唯一可信的兜底触发。
 * agent/core 捕获后强压一轮再重试一次(限一次,防循环)。
 *
 * 判定刻意保守:只在 status 明确(400/413/422)或 status 缺失(代理把错误折叠成普通
 * Error)时才认语义;5xx / 429 一律不算——那种重试压缩也救不回来。
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; type?: string; message?: string };
  if (e.code === 'context_length_exceeded' || e.type === 'context_length_exceeded') return true;
  if (e.code === 'string_above_max_length') return true;
  if (typeof e.status === 'number' && e.status >= 500) return false;
  if (typeof e.status === 'number' && e.status !== 400 && e.status !== 413 && e.status !== 422) {
    return false;
  }
  // 413 是网关/代理对「请求体过大」的直白判决,不带 message 也认。
  if (e.status === 413) return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (!msg) return false;
  return (
    /context[_ ]length|context window|maximum context|too many tokens|string_above_max_length/.test(msg) ||
    /(input|prompt|context|request).{0,20}too (long|large)|exceeds? the (model|maximum|context)/.test(msg) ||
    /reduce the length|上下文(长度)?(超|过)|超出.*上下文|请求过长|长度超过|token 数?超过/.test(msg)
  );
}

/**
 * 把一次 chat 失败的原始错误消息归类为新手可引导的错误类别(纯展示层判定,不改控制流)。
 * 返回 null = 认不出的错误,展示层保留原始 provider 诊断(方便准确修复,不瞎猜)。
 * 供 repl 的错误出口翻译成中文引导(配 key / 切模型 / 压缩会话等)。
 */
export type ChatErrorKind = 'auth' | 'quota' | 'timeout' | 'network' | 'context';

export function classifyChatError(msg: string): ChatErrorKind | null {
  const m = (msg || '').toLowerCase();
  if (!m) return null;
  // 上下文超长(复用 transport 层判定,提示 /compact)
  if (isContextLengthError({ message: msg })) return 'context';
  // 认证:401 / key 无效缺失
  if (
    /\b401\b|unauthorized|forbidden[^\n]*(?:api[ _-]?key|token)/.test(m) ||
    /(?:invalid|incorrect|missing|no|not[ _-]?(?:provided|configured|valid))[^\n]{0,24}api[ _-]?key/.test(m) ||
    /api[ _-]?key[^\n]{0,24}(?:invalid|incorrect|missing|not[ _-]?(?:provided|configured|valid))/.test(m) ||
    /无效的|未配置.{0,8}(?:key|密钥)|(?:密钥|令牌).{0,8}(?:无效|错误)/.test(msg)
  ) return 'auth';
  // 限流 / 配额:429 / rate limit / quota / 余额不足
  if (
    /\b429\b|rate[ _-]?limit|insufficient[ _-]?(?:quota|balance|funds)|quota[ _-]?(?:exceeded|exhausted)/.test(m) ||
    /频率限制|使用量已超出|余额不足|配额(?:不足|已用完|超)/.test(msg)
  ) return 'quota';
  // 超时 / 连接中断
  if (/\btime(?:d|ed)?[ _-]?out\b|etimedout|econnreset|socket hang up|econnaborted|请求超时/.test(m)) return 'timeout';
  // 网络 / DNS / baseURL 不通
  if (
    /\benotfound\b|\beconnrefused\b|\beai_again\b|getaddrinfo|fetch failed|network error|certificate/.test(m) ||
    /无法连接|网络(?:错误|异常|不可用)|域名解析/.test(msg)
  ) return 'network';
  return null;
}

/** 从 OpenAI APIError.headers 解析 Retry-After(秒);不支持或缺失返回 undefined。封顶 RETRY_MAX_MS。 */
export function getRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown } | undefined)?.headers;
  if (!headers) return undefined;
  let raw: string | null = null;
  if (typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
    raw = (headers as { get: (k: string) => string | null }).get('retry-after');
  } else if (typeof headers === 'object') {
    raw = (headers as Record<string, string>)['retry-after'] ?? null;
  }
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(n * 1000, RETRY_MAX_MS);
}

/** 第 N 次失败后等多久(retryAfterMs 有就用它,否则指数;再加 ±RETRY_JITTER 抖动)。 */
export function computeBackoff(attempt: number, retryAfterMs?: number): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  const base = retryAfterMs ?? exp;
  const lo = base * (1 - RETRY_JITTER);
  const hi = base * (1 + RETRY_JITTER);
  return Math.max(0, Math.round(lo + Math.random() * (hi - lo)));
}

function logRetry(attempt: number, err: unknown, waitMs: number): void {
  const e = err as { status?: number; name?: string; message?: string };
  const tag = e.status ? `HTTP ${e.status}` : e.name || 'Error';
  const msg = e.message ?? '未知错误';
  // 走 console.error 而非 process.stderr.write:TUI active 时 layout.installConsoleGuard
  // 已把 console.* 劫持到 contentWrite(内容区),错误会落在 agent 输出区,不污染输入框;
  // 非 TTY(管道 / CI / 启动早期 TUI 未启)降级走原生 console.error → stderr,行为与改造前一致。
  // 不写前导 \n —— contentWrite 由续写位管位置,前置换行会留空行;结尾 \n 由劫持逻辑补。
  console.error(
    `[llm] 第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次失败(${tag}: ${msg}),${(waitMs / 1000).toFixed(1)}s 后重试…`
  );
}

type CreateImpl = (
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } | undefined
) => Promise<AsyncIterable<unknown>>;

let createImplOverride: CreateImpl | null = null;

/** 仅供单测用:覆盖 chat() 内部实际调用的 create 桩。生产代码不要碰。 */
export function __setChatCreateImpl(impl: CreateImpl | null): void {
  createImplOverride = impl;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * 工具 schema 保持稳定数组引用，再在 MCP 发现或扩展变动后原地刷新；
 * 这样 chat()/预算模块的默认参数不会继续指向陈旧的顶层快照。
 */
export const chatTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
export const planChatTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

export function refreshChatTools(): void {
  // sub-agent 与前端工具簇常驻内部 registry，运行时开关只控制模型可见 schema，因而 on/off 可即时生效。
  const visibleTools = tools.filter((tool) => {
    if (tool.name === 'sub-agent') return isSubAgentEnabled();
    if (FRONTEND_TOOLS.has(tool.name)) return isFrontendToolsEnabled();
    return true;
  });
  const next = visibleTools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      // 不同版本 SDK 的 FunctionParameters 宽严不一,用 any 兜底
      parameters: t.parameters as any,
    },
  }));
  chatTools.splice(0, chatTools.length, ...next);
  // MCP 协议没有可靠的副作用注解；plan 模式绝不暴露外部工具，保留只读探查保证。
  planChatTools.splice(0, planChatTools.length, ...next.filter(
    (t) => !t.function.name.startsWith('mcp__') && !getPlanDisabledTools().has(t.function.name),
  ));
}

// 不在模块顶层调用 refreshChatTools():llm → registry 的 import 在部分加载顺序下会
// 形成循环(registry → builtins → … → llm),顶层执行时 tools 尚未初始化(TDZ ReferenceError)。
// chatTools 初始为空数组;两个真实入口(repl 启动、stdio host 启动)都会显式刷新,
// 所有消费方(budget/compact/scheduler 默认参数、agent 装配)均在运行时求值,不受影响。


export interface ToolCallRef {
  id: string;
  name: string;
  arguments: string; // 原始 JSON 字符串
}

/** 一次 chat 调用返回的真实 token 用量(include_usage 时由后端给出)。 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** prompt 中命中 cache 的 token 数(后端未报则为 0)。
   *  计费时这部分按折扣价(DeepSeek 命中 $0.014/M vs 未命中 $0.14/M,差 10×)或免费
   *  ——成本监控要从 promptTokens 中剔除,否则高估一个数量级。
   *  多 provider 字段名不一致,见 extractUsageExtras。 */
  cachedTokens: number;
  /** Anthropic 本次写入 prompt cache 的 token；其它 provider 缺省为 0/undefined。 */
  cacheCreationTokens?: number;
  /** completion 中"思考"消耗的 token(CoT 模型:OpenAI o1 / DeepSeek R1 / GLM-Z1)。
   *  仍按 completion 全价计费,但对调试 thinking 长度有用。 */
  reasoningTokens: number;
}

/**
 * 多 provider 兼容的 cache / reasoning 字段提取。
 * 不同后端报 cached 字段名差异巨大,这里按"最常见的几种"顺序 probe,
 * 首个合法非负数字即用(0 也算合法 —— cache miss 是合法状态,不是"无数据")。
 * 字段全缺 → 0,UI 不会显示任何额外标注(零行为变化)。
 *
 * 已实测 / 字段名已知:
 *   - OpenAI / Azure / 多数 OpenAI 兼容中转:
 *       prompt_tokens_details.cached_tokens
 *   - DeepSeek(含 R1):
 *       prompt_cache_hit_tokens(扁平,顶层)
 *   - Anthropic Claude:
 *       cache_read_input_tokens
 *   - Moonshot Kimi / GLM-4.6 / Qwen:同 OpenAI 标准
 *   - Ollama / 本地 vLLM / 其它:无 usage details → 0(零行为变化)
 *
 * reasoning 字段(CoT 模型):
 *   - OpenAI o1 / DeepSeek R1 / GLM-Z1:
 *       completion_tokens_details.reasoning_tokens
 *   - 其它(个别):reasoning_tokens(顶层)
 */
export function extractUsageExtras(usage: unknown): {
  cachedTokens: number;
  reasoningTokens: number;
} {
  if (!usage || typeof usage !== 'object') return { cachedTokens: 0, reasoningTokens: 0 };
  const u = usage as Record<string, unknown>;
  // cached probe 顺序:OpenAI 标准 → DeepSeek 扁平 → Anthropic → 杂项兜底
  const cachedCandidates: unknown[] = [
    readPath(u, ['prompt_tokens_details', 'cached_tokens']),
    u.prompt_cache_hit_tokens,
    u.cache_read_input_tokens,
    u.cached_tokens,
    u.prompt_tokens_cached,
  ];
  // reasoning probe 顺序:OpenAI 标准 → 扁平兜底
  const reasoningCandidates: unknown[] = [
    readPath(u, ['completion_tokens_details', 'reasoning_tokens']),
    u.reasoning_tokens,
  ];
  return {
    cachedTokens: firstNumber(cachedCandidates) ?? 0,
    reasoningTokens: firstNumber(reasoningCandidates) ?? 0,
  };
}

/** 从对象按路径读嵌套字段(每段都做 null/undefined 检查,任一断即返 undefined)。 */
function readPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** 从候选数组里取第一个合法非负有限数字(0 算合法 —— cache miss 不是"无数据")。
 * 顺序敏感:数组里前面的 provider 优先(如 OpenAI 标准报 0 时,不会 fallback 到 DeepSeek 字段)。 */
function firstNumber(arr: readonly unknown[]): number | undefined {
  for (const v of arr) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCallRef[];
  usage?: ChatUsage;
}

export interface ChatRetryInfo {
  attempt: number;
  nextAttempt: number;
  waitMs: number;
  code: string;
}

/** 流式回调:文本增量 / 首个 tool_call 工具名 / 内部请求重试。 */
export interface StreamHandlers {
  onText?: (delta: string) => void;
  /** 首次得知某个 tool_call 的工具名时回调——模型开始生成工具调用参数(可能很长,如 write_file 大段内容),调用方可据此启「生成中」spinner,避免内容区干等。 */
  onToolCall?: (name: string) => void;
  /** Retry telemetry contains only a status/code, never provider error text or request data. */
  onRetry?: (info: ChatRetryInfo) => void;
  /** 流式实时用量(本请求累计),供调用方驱动底栏实时用量 chip;不提供则不做任何统计。
   *  每个带 delta 的 chunk 后回调一次:completionTokens 为估算值(含 think 段与 tool_call 参数)。
   *  末尾 usage chunk 到达时再回调一次:三个字段均为后端实测值(流式期间 prompt / cached 不可知)。 */
  onProgress?: (progress: {
    completionTokens: number;
    promptTokens?: number;
    cachedTokens?: number;
    /** Anthropic 本次创建缓存的输入 token；其它 provider 不上报。 */
    cacheCreationTokens?: number;
  }) => void;
}

function retryErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'RETRYABLE_ERROR';
  const value = error as { status?: number; code?: string; name?: string };
  if (typeof value.status === 'number') return `HTTP_${value.status}`;
  return value.code ?? value.name ?? 'RETRYABLE_ERROR';
}

/**
 * 流式调一次 LLM:增量回调文本,内部累加 tool_calls 片段。
 * tool_calls 跨 chunk 按 index 累加(id / name / arguments 拼接)。
 * include_usage 时末尾 chunk 携带 usage,先读再 continue(末尾 chunk 无 delta)。
 *
 * 包了一层重试:429/5xx/timeout/网络错按指数退避重试(默认 4 次),400/401/用户中断立即抛。
 * 重试由 chat() 统一管,chatOnce() 只负责单次请求,职责单一便于单测。
 */
export async function chat(
  messages: ChatMessage[],
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
  /** 覆盖默认工具 schema;plan 模式传 planChatTools(只读子集),缺省=全量 chatTools。 */
  toolsOverride?: OpenAI.Chat.Completions.ChatCompletionTool[]
): Promise<ChatResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    try {
      if (config.provider === 'anthropic') {
        return await anthropicChatOnce(
          messages,
          handlers,
          signal,
          toolsOverride ?? chatTools,
        );
      }
      return await chatOnce(messages, handlers, signal, toolsOverride);
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_MAX_ATTEMPTS || !isRetryableError(err, signal)) {
        throw err;
      }
      const wait = computeBackoff(attempt, getRetryAfterMs(err));
      handlers.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        waitMs: wait,
        code: retryErrorCode(err),
      });
      logRetry(attempt, err, wait);
      // sleep 自己会在 signal abort 时抛 AbortError——透传,让 runAgentCore 的 catch 按中断处理。
      await sleep(wait, signal);
    }
  }
  // 循环要么 return 要么 throw,理论上走不到这里;写出来让 TS 控制流分析满意。
  throw lastErr;
}

/**
 * 发送前规范化多模态 image_url:去掉 `detail:"auto"`。
 *
 * `auto` 是 OpenAI 的合法枚举,但 MiniMax 等兼容后端只认 low/default/high,收到 auto 直接
 * 400(invalid image detail: auto, 2013)。省略该字段时各家都会用自己的默认值,是唯一
 * 在所有后端都安全的写法;显式 low/high 属通用取值,原样保留。
 *
 * 放在 transport 边界而非构造点:历史里可能已经存着旧版本(或续接会话 / 外部注入)写下的
 * `auto`,那种消息每轮都会被重发,只修构造点无法自愈。
 *
 * 无需改写时返回原数组引用 —— 图片消息含大段 base64,不能无条件深拷贝。
 */
export function normalizeImageDetail(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let messageChanged = false;
    const parts = content.map((part) => {
      const image = (part as { type?: string; image_url?: { detail?: unknown } }).image_url;
      if ((part as { type?: string }).type !== 'image_url' || !image) return part;
      if (image.detail !== 'auto') return part;
      messageChanged = true;
      const { detail: _dropped, ...rest } = image;
      return { ...(part as object), image_url: rest };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...(message as object), content: parts } as ChatMessage;
  });
  return changed ? next : messages;
}

/** 单次流式 LLM 请求(无重试);chat() 的内部实现,可被 __setChatCreateImpl 注入桩以做单测。 */
async function chatOnce(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  toolsOverride: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined
): Promise<ChatResult> {
  // 防御:messages 必须至少含一条非空 user 消息,否则 OpenAI/Anthropic 都会 400。
  // compact force 分支曾把所有 user 丢进摘要 → 重建 history 无 user → 下一轮 400。
  // 在 transport 边界拦住所有类似回归(compact / 外部注入 / resume 损坏)。
  const hasNonEmptyUser = messages.some((m) => {
    if (m.role !== 'user') return false;
    const c = (m as { content?: unknown }).content;
    if (typeof c === 'string') return c.length > 0;
    if (Array.isArray(c)) return c.some((p) => (p as { type?: string; text?: string }).type === 'text' && ((p as { text?: string }).text?.length ?? 0) > 0);
    return false;
  });
  if (!hasNonEmptyUser) {
    throw new Error('messages must contain at least one non-empty user message');
  }
  // signal 透传给 SDK 第二参(RequestOptions);abort 后 for await 抛错,chat 不 catch,透传 runAgent 处理。
  // createImplOverride 的 body 类型故意宽成 Record(测试桩用),生产走 client 分支时由 OpenAI 自己的类型守门。
  const create = createImplOverride
    ? createImplOverride
    : (body: Record<string, unknown>, opts: { signal?: AbortSignal } | undefined) =>
        client.chat.completions.create(
          body as unknown as Parameters<typeof client.chat.completions.create>[0],
          opts as unknown as Parameters<typeof client.chat.completions.create>[1]
        );
  const activeTools = toolsOverride ?? chatTools;
  const stream = await create(
    {
      model: getActiveModel(),
      messages: normalizeImageDetail(messages),
      stream: true,
      // 空工具表(如摘要请求)不发 tools 字段——部分网关拒绝空数组。
      ...(activeTools.length > 0
        ? {
            tools: activeTools,
            // 显式声明允许一次响应携带多个 tool_call(OpenAI 兼容协议标准字段)。
            // 不设置时依赖各家后端的默认值,某些第三方网关/模型在缺省时会退化为串行单步调用。
            parallel_tool_calls: true,
          }
        : {}),
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
      ...(config.includeUsage ? { stream_options: { include_usage: true } } : {}),
    },
    signal ? { signal } : undefined
  );

  // content 内嵌 think 标签由独立增量状态机过滤。它只暂存“可能组成标签”的后缀，
  // 因而既能覆盖标签任意位置跨 chunk，也不会让普通正文固定延迟数个字符。
  let visibleContent = '';
  let consumedAny = false;
  const thinkFilter = new ThinkTagFilter();
  let usage: ChatUsage | undefined;
  const toolAcc = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >();

  const emitVisible = (text: string): void => {
    if (!text) return;
    visibleContent += text;
    handlers.onText?.(text);
    consumedAny = true;
  };

  // 实时 completion 估算(onProgress 提供时才统计,零开销兜底):
  // 按 chunk 累加 CJK/other 字符数、汇总时才 ceil——逐片段 ceil 会把大量小 chunk 各向上
  // 取整造成严重过估。统计口径 = raw content(含 think 段)+ tool_call 参数,与后端真实
  // completion 计费范围一致(reasoning 也计费)。
  let liveCjk = 0;
  let liveOther = 0;
  const countLive = (text: string): void => {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isCJK(cp)) liveCjk++;
      else liveOther++;
    }
  };
  const reportProgress = (): void => {
    handlers.onProgress?.({ completionTokens: Math.ceil(liveCjk + liveOther / 4) });
  };

  for await (const chunk of stream as AsyncIterable<{
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      // 字段名因 provider 而异(cached_tokens / cache_read_input_tokens / ...),
      // 用 extractUsageExtras 容错读,这里类型放宽到 unknown 让 indexed access 不报错。
      [k: string]: unknown;
    };
    choices?: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  }>) {
    // usage:末尾 chunk(choices 可能为空)在 include_usage 时携带;先读再 continue。
    if (chunk.usage) {
      const extras = extractUsageExtras(chunk.usage);
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
        cachedTokens: extras.cachedTokens,
        reasoningTokens: extras.reasoningTokens,
      };
      // 末尾 chunk 把实测 prompt / completion / cache 命中即时推给实时 chip(无 delta,下方 continue 不会再报)。
      handlers.onProgress?.({
        completionTokens: usage.completionTokens,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
      });
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue; // 末尾 usage-only chunk 等无 delta

    if (delta.content) {
      if (handlers.onProgress) countLive(delta.content);
      emitVisible(thinkFilter.push(delta.content));
    }

    if (delta.tool_calls) {
      // 不在这里 flush thinkFilter：其内部若有残留，只可能是 `<th` / `</thi` 一类
      // 潜在标签前缀。旧实现把这段在工具转折点强制送进 onText，正是 `k>` 等残片
      // 偶发混到工具摘要附近的来源。普通文本不会被状态机滞留。
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolAcc.get(idx);
        if (!entry) {
          entry = { name: '', arguments: '' };
          toolAcc.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        const fname = tc.function?.name;
        if (fname) {
          if (!entry.name) handlers.onToolCall?.(fname); // 首次得知工具名:通知调用方启生成中 spinner
          entry.name += fname;
        }
        if (tc.function?.arguments) {
          if (handlers.onProgress) countLive(tc.function.arguments);
          entry.arguments += tc.function.arguments;
        }
      }
    }

    // 流式实时用量:每个带 delta 的 chunk 后回调累计估算,驱动底栏实时 chip。
    if (handlers.onProgress) reportProgress();
  }

  // 流结束后只释放普通态下真实的文本尾；未闭合思考段继续丢弃。
  emitVisible(thinkFilter.finish());

  const toolCalls: ToolCallRef[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({
      id: e.id ?? '',
      name: e.name,
      arguments: e.arguments,
    }));

  return {
    content: consumedAny ? visibleContent : null,
    toolCalls,
    usage,
  };
}

// ── token 估算(自包含,不依赖 ui / 外部 tokenizer)──────────────────────
// CJK 感知启发式:CJK 字符 ≈ 1 token,其余 ≈ 4 字符/token。
// 故意偏过估(安全侧):估算偏高 → 压缩触发偏早 → 不会溢出窗口。
// 真实 usage 由 chat() 的 include_usage 返回;此处仅作预检 / 兜底 / /context 显示。

/** 判断一个码点是否 CJK 表意 / 假名 / 韩文(按 1 token 计)。 */
function isCJK(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0x3040 && cp <= 0x30ff) || // 假名
    (cp >= 0xac00 && cp <= 0xd7a3) // 韩文音节
  );
}

/** 粗估一段文本的 token 数。CJK≈1/字,其余≈1/4字,向上取整。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCJK(cp)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/** 把任意消息内容(content 可能是 string | null | 多模态数组)拍平成字符串。 */
function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** OpenAI 视觉模型单图固定 token(低细节 / auto 模式);高细节更大但属罕见路径,保守按 85 计。 */
const IMAGE_TOKEN_COST = 85;

/** 单个 content part 的 token:text part 走 estimateTokens,image_url part 固定 85。+2 结构开销。 */
function partTokens(part: unknown): number {
  if (!part || typeof part !== 'object') return 0;
  const p = part as { type?: string; text?: string; image_url?: unknown };
  if (p.type === 'text') return 2 + estimateTokens(p.text ?? '');
  if (p.type === 'image_url') return 2 + IMAGE_TOKEN_COST;
  return 2;
}

/** 估算多模态 content 的 token(text parts + 固定每图 85);不把 base64 走 estimateTokens,避免 1MB 图算成 25 万 token。 */
export function contentTokens(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    let sum = 0;
    for (const p of content) sum += partTokens(p);
    return sum;
  }
  return estimateTokens(contentToText(content));
}

/** 估算单条消息的 token 数:结构开销 + content + tool_calls 参数。 */
export function messageTokens(m: ChatMessage): number {
  const role = (m as { role?: string }).role;
  let structural = 4; // {role}\n{content}\n 框架基线
  if (role === 'system') structural = 3;
  else if (role === 'tool') structural = 6;
  let body = contentTokens((m as { content?: unknown }).content);
  const tcs = (m as { tool_calls?: { function?: { arguments?: string } }[] })
    .tool_calls;
  if (tcs) {
    for (const tc of tcs) body += estimateTokens(tc?.function?.arguments ?? '');
  }
  return structural + body;
}

/** 估算整段 messages 的 token 数(不含工具 schema,含 priming 常数)。 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let sum = 3; // priming:每轮对话的基础开销
  for (const m of messages) sum += messageTokens(m);
  return sum;
}

const schemaTokensCache = new WeakMap<object, number>();

/** 估算本次实际发送的工具 schema token；按工具数组实例缓存。 */
export function estimateToolSchemaTokens(
  activeTools: readonly ChatTool[] = chatTools,
): number {
  if (activeTools.length === 0) return 0;
  const key = activeTools as object;
  const cached = schemaTokensCache.get(key);
  if (cached !== undefined) return cached;
  const estimated = estimateTokens(JSON.stringify(activeTools)) + 16;
  schemaTokensCache.set(key, estimated);
  return estimated;
}

/** 把模型级校正系数统一应用到原始估算。 */
export function correctTokenEstimate(estimate: number, correction: number = 1): number {
  const safeCorrection = Number.isFinite(correction)
    ? Math.max(0.5, Math.min(2, correction))
    : 1;
  return estimate > 0 ? Math.max(1, Math.ceil(estimate * safeCorrection)) : 0;
}

/** 估算一次完整请求的 prompt token（messages + 本次实际工具 schema）。 */
export function estimatePromptTokens(
  messages: ChatMessage[],
  activeTools: readonly ChatTool[] = chatTools,
  correction: number = 1,
): number {
  const raw = estimateMessagesTokens(messages) + estimateToolSchemaTokens(activeTools);
  return correctTokenEstimate(raw, correction);
}
