import OpenAI from 'openai';
import { config } from '../config/index.js';
import { tools } from '../tools/registry.js';
import { getPlanDisabledTools } from '../tools/constants.js';

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
// 用 \u003c 表示 <,绕开本工具对 < 的处理(直接写 '<\u003cthink\u003e' 里 < 会被吃掉)。
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

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
  // stderr 而非 stdout —— 不污染流式正文;行首换行防止黏在上一行尾巴。
  process.stderr.write(
    `\n[llm] 第 ${attempt}/${RETRY_MAX_ATTEMPTS} 次失败(${tag}: ${msg}),${(waitMs / 1000).toFixed(1)}s 后重试…\n`
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

/** 把内部工具定义转成 OpenAI 的 tool 格式 */
export const chatTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(
  (t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      // 不同版本 SDK 的 FunctionParameters 宽严不一,用 any 兜底
      parameters: t.parameters as any,
    },
  })
);

/**
 * plan 模式用的受限工具 schema:剔除写盘 / 命令 / 记忆写入类(getPlanDisabledTools())。
 * 模型在 plan 模式下只看得到只读工具 → 调不到会改文件的工具。runAgent 在 plan 模式传给 chat()。
 *
 * 注意:planChatTools 是顶层 const(模块初始化时一次性求值);若运行时 /memory_switch 关闭
 * 记忆,这里仍是按当前 isMemoryEnabled() 算出的快照——重启 REPL 才完全生效。
 */
export const planChatTools: OpenAI.Chat.Completions.ChatCompletionTool[] =
  chatTools.filter((t) => !getPlanDisabledTools().has(t.function.name));

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

/** 流式回调:文本增量 / 首个 tool_call 工具名。 */
export interface StreamHandlers {
  onText?: (delta: string) => void;
  /** 首次得知某个 tool_call 的工具名时回调——模型开始生成工具调用参数(可能很长,如 write_file 大段内容),调用方可据此启「生成中」spinner,避免内容区干等。 */
  onToolCall?: (name: string) => void;
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
      return await chatOnce(messages, handlers, signal, toolsOverride);
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_MAX_ATTEMPTS || !isRetryableError(err, signal)) {
        throw err;
      }
      const wait = computeBackoff(attempt, getRetryAfterMs(err));
      logRetry(attempt, err, wait);
      // sleep 自己会在 signal abort 时抛 AbortError——透传,让 runAgentCore 的 catch 按中断处理。
      await sleep(wait, signal);
    }
  }
  // 循环要么 return 要么 throw,理论上走不到这里;写出来让 TS 控制流分析满意。
  throw lastErr;
}

/** 单次流式 LLM 请求(无重试);chat() 的内部实现,可被 __setChatCreateImpl 注入桩以做单测。 */
async function chatOnce(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  toolsOverride: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined
): Promise<ChatResult> {
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
      model: config.model,
      messages,
      tools: activeTools,
      stream: true,
      // 显式声明允许一次响应携带多个 tool_call(OpenAI 兼容协议标准字段)。
      // 不设置时依赖各家后端的默认值,某些第三方网关/模型在缺省时会退化为串行单步调用。
      ...(activeTools.length > 0 ? { parallel_tool_calls: true } : {}),
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
      ...(config.includeUsage ? { stream_options: { include_usage: true } } : {}),
    },
    signal ? { signal } : undefined
  );

  // 流式  start end 标签过滤(见模块顶部 THINK_OPEN/CLOSE)。
  // 跨 chunk 切分防御:buf 累积跨 chunk 边界,indexOf 扫描;为避免把跨 chunk 标签误判为
  // 普通字符,buf 末尾为当前态保留 (label.length - 1) 个字符给下一 chunk 看。
  let visibleContent = '';
  let consumedAny = false;
  let inThink = false;
  let buf = '';
  let usage: ChatUsage | undefined;
  const toolAcc = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >();

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
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue; // 末尾 usage-only chunk 等无 delta

    if (delta.content) {
      // 状态机切分 delta.content:inThink 外输出到 visibleContent + onText;
      // inThink 内丢弃;标签起始/闭合用 indexOf 在 buf 里扫描。
      // 末尾预留 (label.length - 1) 字符给下一 chunk 防切分误判。
      buf += delta.content;
      let i = 0;
      while (true) {
        if (inThink) {
          // 思考段内,扫描 THINK_CLOSE;末尾预留 THINK_CLOSE.length - 1 防跨 chunk 切分
          const endIdx = buf.indexOf(THINK_CLOSE, i);
          if (endIdx === -1) {
            // 思考段内未找到闭合;buf 短到不可能包含 </think> 时全丢(都是思考段内容),
            // 否则留 (THINK_CLOSE.length - 1) 给下一 chunk 防跨边界切分。
            const safeLen = buf.length >= THINK_CLOSE.length
              ? buf.length - (THINK_CLOSE.length - 1)
              : buf.length;
            i = safeLen;
            break;
          }
          inThink = false;
          i = endIdx + THINK_CLOSE.length;
        } else {
          // 普通段,扫描 THINK_OPEN;末尾预留 THINK_OPEN.length - 1 防跨 chunk 切分
          const startIdx = buf.indexOf(THINK_OPEN, i);
          if (startIdx === -1) {
            // buf 短到不可能包含 <think> 时全输出(无 think 标签的普通模型不受影响);
            // 否则留 (THINK_OPEN.length - 1) 给下一 chunk 防跨边界切分误判。
            const safeLen = buf.length >= THINK_OPEN.length
              ? buf.length - (THINK_OPEN.length - 1)
              : buf.length;
            const seg = buf.slice(i, safeLen);
            if (seg) {
              visibleContent += seg;
              handlers.onText?.(seg);
              consumedAny = true;
            }
            i = safeLen;
            break;
          }
          // THINK_OPEN 之前的普通段:输出
          if (startIdx > i) {
            const seg = buf.slice(i, startIdx);
            visibleContent += seg;
            handlers.onText?.(seg);
            consumedAny = true;
          }
          inThink = true;
          i = startIdx + THINK_OPEN.length;
        }
      }
      buf = buf.slice(i);
    }

    if (delta.tool_calls) {
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
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }
  }

  // 防御:循环内 buf.slice 已把可确认部分消费;此处覆盖流末尾的"安全尾":
  //  - 普通段(stream 已结束,标签不会再出现):作为可见内容追加到 visibleContent(不再调 onText)
  //  - 思考段未闭合:丢弃,防 thinking 文本泄漏到 history
  if (buf) {
    if (!inThink) {
      visibleContent += buf;
      consumedAny = true;
    }
    buf = '';
  }

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

let schemaTokensCache: number | undefined;

/** 估算 chatTools(工具 schema)占用的一次性 token,带缓存。 */
export function estimateToolSchemaTokens(): number {
  if (schemaTokensCache === undefined) {
    schemaTokensCache = estimateTokens(JSON.stringify(chatTools)) + 16;
  }
  return schemaTokensCache;
}
