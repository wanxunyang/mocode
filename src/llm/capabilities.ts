/**
 * 模型能力检测:仅用于 /image 等多模态输入的友好提示。
 *
 * 策略 — 保守 + 显式白名单/黑名单:
 * - 命中 KNOWN_TEXT_ONLY_PREFIXES 任一前缀 → false(确定无视觉)
 * - 命中 KNOWN_VISION_FAMILIES 任一前缀 → true(确定有视觉)
 * - 其它(未识别 / 自定义代理 / 新发布模型)→ 默认 true(放行,让 API 拒收兜底)
 *
 * 理由:视觉能力在 2024 后已成新模型默认;自定义 OpenAI 代理常把上游视觉模型重命名;
 * 过度保守会误伤合法配置。
 */

const KNOWN_TEXT_ONLY_PREFIXES: string[] = [
  'gpt-3.5',
  'gpt-3.5-turbo',
  'gpt-4-0613', // 早期 gpt-4,无视觉
  'gpt-4-0314',
  'gpt-4-32k',
  'o1-mini', // 纯推理,无视觉
  'o1-preview',
  'o3-mini',
  'text-embedding-',
  'text-davinci-',
  'dall-e-', // 反过来:它是图像生成不是视觉理解
  'whisper-',
  'tts-',
  'babbage-',
  'davinci-',
  'gpt-4o-mini-search', // 搜索专用,无视觉入口
  // MiniMax M2 系列(M2 / M2.1 / M2.5 / M2.7,含各自 -highspeed 变体):纯文本,无视觉输入。
  // 官方文档明确仅 MiniMax-M3 支持 image/video content parts;M2.x 传 image_url 会被拒。
  'minimax-m2',
];

const KNOWN_VISION_FAMILIES: string[] = [
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4-vision',
  'gpt-4.1',
  'gpt-4.5',
  'gpt-5',
  'chatgpt-4o',
  'o1', // o1 / o1-pro 支持视觉(与 o1-mini 不同)
  'claude-3',
  'claude-3.5',
  'claude-3.7',
  'claude-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'gemini-1.5',
  'gemini-2',
  'gemini-exp',
  'pixtral',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'llava',
  'internvl',
  'minicpm-v',
  'glm-4v',
  'yi-vl',
  'minimax-m3', // 官方文档:仅 M3 支持 image_url/video_url content parts
];

/** 归一化:小写、去空白;用于前缀比较。 */
function normalize(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * 判断模型是否支持视觉(多模态 image_url)。
 * - 模型未配置(`config.model` 为空或 default 兜底字符串)→ true(不阻断,等 API 报错)
 * - 命中 KNOWN_TEXT_ONLY_PREFIXES 任一前缀 → false(确定无视觉,优先查,避免 gpt-4o-mini vs -search 系列名冲突)
 * - 命中 KNOWN_VISION_FAMILIES 任一前缀 → true
 * - 其它(未识别 / 自定义代理 / 新发布模型)→ true(保守放行)
 */
export function modelSupportsVision(model: string): boolean {
  const m = normalize(model);
  if (!m) return true;
  for (const p of KNOWN_TEXT_ONLY_PREFIXES) {
    if (m === p || m.startsWith(p)) return false;
  }
  for (const p of KNOWN_VISION_FAMILIES) {
    if (m === p || m.startsWith(p)) return true;
  }
  return true;
}
