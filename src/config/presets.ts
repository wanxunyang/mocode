import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 多模型预设(`/model save <name>` 保存的命名配置)的纯 I/O 叶子。
 *
 * 存储:每个预设一个独立 JSON 文件 `~/.mocode/models/<name>.json`。
 *   - 选用 per-file 而非单一 index.json:写不需要读-合并-写整本,天然原子(单文件 rename),
 *     符合 memory/store.ts 的惯例;并发写多个预设互不打架。
 *   - 路径前缀与 CONFIG_PATH 共享 `~/.mocode/`,保证权限/位置一致。
 *
 * 不读 process.env、不触发 config 单例初始化——repl(/model 子命令)与 commands/config.ts
 * 之外的脚本都能安全 import。错误一律抛(写失败属异常路径,调用方决定怎么提示用户)。
 *
 * 命名约束:[a-zA-Z0-9_-]{1,32}。理由:
 *   - 排除路径分隔符与 .. 防止越权写文件。
 *   - 与 dotenv key 风格一致,便于未来扩展到同名 env override。
 *   - 32 位上限防极长名撑爆文件名系统。
 */

/** 预设目录:`~/.mocode/models/`(按需创建)。 */
export const MODELS_DIR = path.join(os.homedir(), '.mocode', 'models');

/**
 * 激活预设指针文件:`~/.mocode/models/.active`,内容为一行预设名。
 * 激活预设是"上下文窗口等配置跟随模型"的真相来源:启动与它窗切换都以此覆盖 LLM 四键。
 * 与 <name>.json 区分:`.active` 不以 .json 结尾、且 '.' 非法首字符,listPresets 天然跳过。
 */
export const ACTIVE_PRESET_PATH = path.join(MODELS_DIR, '.active');

/** 读激活预设名;不存在/空返回 null(供启动回退到 config 文件的裸 LLM 键)。 */
export function getActivePresetName(): string | null {
  try {
    const name = fs.readFileSync(ACTIVE_PRESET_PATH, 'utf8').trim();
    return isValidPresetName(name) ? name : null;
  } catch {
    return null; // 不存在或不可读:无激活预设
  }
}

/** 写激活预设指针(原子:写 tmp 再 rename)。name 必须在预设目录里存在,防止指向空指针。 */
export function setActivePresetName(name: string): void {
  if (!isValidPresetName(name)) {
    throw new Error(`非法预设名: ${JSON.stringify(name)}`);
  }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const tmp = `${ACTIVE_PRESET_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${name}\n`, 'utf8');
  fs.renameSync(tmp, ACTIVE_PRESET_PATH);
}

export type PresetProvider = 'openai' | 'anthropic';

/** 单个预设的内容:provider/cache 字段可选输入，读取后总会规范化。 */
export interface ModelPreset {
  name: string;
  provider: PresetProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  anthropicPromptCache: boolean;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** 名字是否合法(调用方复用,避免在多处重复同一正则)。 */
export function isValidPresetName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 把合法的 name 拼成文件路径;非法 name 抛错(路径穿越防护的第二道)。 */
function filePathFor(name: string): string {
  if (!isValidPresetName(name)) {
    throw new Error(`非法预设名: ${JSON.stringify(name)}(仅允许 [a-zA-Z0-9_-]{1,32})`);
  }
  return path.join(MODELS_DIR, `${name}.json`);
}

/** 把磁盘上的 raw JSON 解析并校验为 ModelPreset;旧预设缺 provider 时按 openai 读取。 */
export function parsePreset(raw: string): ModelPreset {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const { name, baseURL, apiKey, model, contextWindow } = obj;
  if (typeof name !== 'string' || !isValidPresetName(name)) {
    throw new Error('预设文件 name 缺失或非法');
  }
  if (typeof baseURL !== 'string' || !baseURL) {
    throw new Error(`预设 ${name}: baseURL 缺失`);
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new Error(`预设 ${name}: apiKey 缺失`);
  }
  if (typeof model !== 'string' || !model) {
    throw new Error(`预设 ${name}: model 缺失`);
  }
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`预设 ${name}: contextWindow 必须为正数`);
  }
  const provider: PresetProvider = obj.provider === 'anthropic' ? 'anthropic' : 'openai';
  const anthropicPromptCache = provider === 'anthropic' && obj.anthropicPromptCache !== false;
  return {
    name,
    provider,
    baseURL,
    apiKey,
    model,
    contextWindow: Math.floor(contextWindow),
    anthropicPromptCache,
  };
}

/** 读单个预设;不存在抛错。 */
export function getPreset(name: string): ModelPreset {
  const p = filePathFor(name);
  return parsePreset(fs.readFileSync(p, 'utf8'));
}

/** 读单个预设;不存在返回 null(供列表/可选切换场景)。 */
export function readPreset(name: string): ModelPreset | null {
  try {
    return getPreset(name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** 写/覆盖一个预设(原子:写 tmp 再 rename)。旧调用缺 provider 时仍按 openai 保存。 */
export function savePreset(
  preset: Omit<ModelPreset, 'provider' | 'anthropicPromptCache'> &
    Partial<Pick<ModelPreset, 'provider' | 'anthropicPromptCache'>>,
): void {
  if (!isValidPresetName(preset.name)) {
    throw new Error(`非法预设名: ${JSON.stringify(preset.name)}`);
  }
  const provider = preset.provider ?? 'openai';
  const normalized: ModelPreset = {
    ...preset,
    provider,
    anthropicPromptCache: provider === 'anthropic' && preset.anthropicPromptCache !== false,
  };
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = filePathFor(preset.name);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
}

/** 删除一个预设;不存在返回 false,成功返回 true。若删的是激活预设,顺带清掉指针。 */
export function deletePreset(name: string): boolean {
  try {
    fs.unlinkSync(filePathFor(name));
    if (getActivePresetName() === name) {
      try {
        fs.unlinkSync(ACTIVE_PRESET_PATH);
      } catch {
        /* 指针已不在,忽略 */
      }
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * 重命名一个预设(原子:link+unlink,跨设备时退化为 copy+unlink)。
 * 用于 /model rename <old> <new>;不存在的旧名 / 已存在的新名返回 false,具体由调用方决定提示文案。
 */
export function renamePreset(oldName: string, newName: string): boolean {
  if (!isValidPresetName(newName)) {
    throw new Error(`非法新名: ${JSON.stringify(newName)}`);
  }
  const oldPath = filePathFor(oldName);
  const newPath = filePathFor(newName);
  if (!fs.existsSync(oldPath)) return false;
  if (fs.existsSync(newPath)) return false; // 拒绝覆盖,避免静默吞用户数据
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  try {
    fs.renameSync(oldPath, newPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    // 跨设备:rename 会抛 EXDEV,改 copy+unlink。
    fs.copyFileSync(oldPath, newPath);
    fs.unlinkSync(oldPath);
  }
  // 重命名后同步更新文件内的 name 字段(我们写出去时总一致,但允许用户手改过 JSON 后不一致)。
  const p = parsePreset(fs.readFileSync(newPath, 'utf8'));
  if (p.name !== newName) savePreset({ ...p, name: newName });
  // 激活预设被重命名 → 指针跟随新名,否则下次启动回退裸 config 丢窗口。
  if (getActivePresetName() === oldName) setActivePresetName(newName);
  return true;
}

/** 列出全部预设(按 name 升序);目录不存在返回空数组。 */
export function listPresets(): ModelPreset[] {
  if (!fs.existsSync(MODELS_DIR)) return [];
  const out: ModelPreset[] = [];
  for (const entry of fs.readdirSync(MODELS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    if (!isValidPresetName(name)) continue; // 跳过非我们写的杂文件
    try {
      out.push(parsePreset(fs.readFileSync(path.join(MODELS_DIR, entry), 'utf8')));
    } catch {
      // 单个坏文件不阻断列表;用户用 /model delete 显式清理即可。
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 把当前 config 的 LLM 四键(baseURL/apiKey/model/contextWindow)迁为命名预设。
 * 用于启动时一次性兜底老用户:加 /model 之前就已经在 ~/.mocode/config 写过的配置,
 * /model list 应该立刻能看到,而不是空。已有同名预设则不重复写。
 *
 * 返回新建的预设名;若未配置完整(baseURL/apiKey 缺失)或已有同名则返回 null。
 * 设计为幂等:重启调用一次也只会生效一次。
 */
export function migrateCurrentToPreset(input: {
  provider?: PresetProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  anthropicPromptCache?: boolean;
}): string | null {
  if (!input.baseURL || !input.apiKey || !input.model) return null;
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) return null;
  const provider = input.provider ?? 'openai';
  const anthropicPromptCache = provider === 'anthropic' && input.anthropicPromptCache !== false;
  const existing = listPresets();
  const dup = existing.find(
    (p) =>
      p.provider === provider &&
      p.baseURL === input.baseURL &&
      p.apiKey === input.apiKey &&
      p.model === input.model &&
      p.contextWindow === input.contextWindow &&
      p.anthropicPromptCache === anthropicPromptCache,
  );
  if (dup) return null;
  // 'default' 已被占 → 用户已显式起过预设,无需老数据迁入;返回 null 让调用方跳过即可。
  if (existing.some((p) => p.name === 'default')) return null;
  savePreset({
    name: 'default',
    provider,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    model: input.model,
    contextWindow: input.contextWindow,
    anthropicPromptCache,
  });
  return 'default';
}
