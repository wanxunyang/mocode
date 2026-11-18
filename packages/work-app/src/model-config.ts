/**
 * work-app 模型预设的 Node 侧纯读写，与 core 的 src/config/presets.ts 共用 JSON 契约。
 * 浏览器可执行的能力探测与共享类型在 model-capabilities.ts；本文件不进入 renderer。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseEffort, type WorkPresetDraft, type WorkPresetFile } from './model-capabilities.js';

export * from './model-capabilities.js';

/** 规范化表单/悬停页草稿，同时保留目录能力与价格字段，避免编辑时静默丢字段。 */
export function normalizeWorkPresetDraft(
  input: Partial<WorkPresetDraft>,
): { ok: true; value: WorkPresetDraft } | { ok: false; message: string } {
  const baseURL = String(input.baseURL ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  const model = String(input.model ?? '').trim();
  const contextWindow = Number(input.contextWindow ?? 0);
  const provider = input.provider === 'anthropic' || input.provider === 'google' ? input.provider : 'openai';
  if (!baseURL) return { ok: false, message: 'modelForm.errorBaseUrl' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(baseURL)) return { ok: false, message: 'modelForm.errorBaseUrl' };
  try { new URL(baseURL); } catch { return { ok: false, message: 'modelForm.errorBaseUrl' }; }
  if (!apiKey) return { ok: false, message: 'modelForm.errorApiKey' };
  if (!model) return { ok: false, message: 'modelForm.errorModel' };
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { ok: false, message: 'modelForm.errorWindow' };

  let maxTokens: number | undefined;
  if (input.maxTokens !== undefined && input.maxTokens !== null) {
    if (typeof input.maxTokens !== 'number' || !Number.isFinite(input.maxTokens) || input.maxTokens <= 0) {
      return { ok: false, message: 'modelForm.errorMaxTokens' };
    }
    maxTokens = Math.floor(input.maxTokens);
  }
  const reasoningEffort = parseEffort(input.reasoningEffort);
  const value: WorkPresetDraft = {
    provider,
    baseURL,
    apiKey,
    model,
    contextWindow: Math.floor(contextWindow),
    anthropicPromptCache: provider === 'anthropic' && input.anthropicPromptCache !== false,
    reasoningEffort: reasoningEffort ?? 'auto',
    // 显式带 undefined 可覆盖 writeWorkPreset 合并的旧值，从而真正清空 MAX_TOKENS。
    maxTokens,
    ...(typeof input.catalogProvider === 'string' && input.catalogProvider ? { catalogProvider: input.catalogProvider } : {}),
    ...(typeof input.catalogModel === 'string' && input.catalogModel ? { catalogModel: input.catalogModel } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.pricing ? { pricing: input.pricing } : {}),
  };
  return { ok: true, value };
}

/** 读预设；旧文件缺少新增字段时按 core 的默认值读取。 */
export function readWorkPreset(filePath: string): WorkPresetFile | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<WorkPresetFile>;
    const normalized = normalizeWorkPresetDraft({
      ...raw,
      provider: raw.provider === 'anthropic' || raw.provider === 'google' ? raw.provider : 'openai',
      contextWindow: Number(raw.contextWindow ?? 0),
      anthropicPromptCache: raw.anthropicPromptCache !== false,
    });
    if (!normalized.ok) return null;
    return {
      name: path.basename(filePath, '.json'),
      ...normalized.value,
      anthropicPromptCache: normalized.value.anthropicPromptCache ?? false,
    };
  } catch {
    return null;
  }
}

/** 原子写预设；先合并旧字段，保留目录能力、价格及未来扩展字段。 */
export function writeWorkPreset(filePath: string, preset: WorkPresetFile): void {
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>; } catch { /* 新建 */ }
  const payload = { ...previous, ...preset };
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已 rename 或临时文件未落盘 */ }
    throw error;
  }
}
