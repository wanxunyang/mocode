/**
 * 模型命令组:/model(无参向导)· /model switch · /model list(presets) · /model show ·
 * /model use <name> · /model delete <name>
 *
 * 运行时配置大模型(baseURL/apiKey/model/contextWindowTokens):
 * 即时生效(updateModelConfig 改内存 + env,reconfigureClient 重建 OpenAI 实例)+
 * 持久化(writeConfigKeys 写 ~/.mocode/config)。
 * 仿 /theme:promptIntervention 弹菜单/输入 → 改 config → refreshStatusBase 刷底栏 →
 * clearContent+banner 重显横幅 → dim 警告(shell env 覆盖)。
 *
 * 迁移说明:原分支里的全部 `continue`(取消/校验失败路径)改为 `return next()`,
 * 语义一致(回 INPUT 态);两个内嵌闭包 applyPresetAndPersist / uniquePresetName
 * 原样保留——前者依赖 ctx(history/banner/refreshStatusBase),后者是纯函数提到模块级。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { config, updateModelConfig } from '../../config/index.js';
import { writeConfigKeys, CONFIG_PATH } from '../../config/file.js';
import {
  deletePreset,
  getPreset,
  isValidPresetName,
  listPresets,
  savePreset,
  setActivePresetName,
} from '../../config/presets.js';
import { reconfigureClient } from '../../llm/index.js';
import { promptIntervention } from '../../ui/intervention.js';
import { renderHistory } from '../message-format.js';
import { MODEL_PRESETS, maskKey } from '../commands.js';
import { unhandled, next, type CommandContext, type CommandHandler } from './types.js';

/** 决定自动存的预设名:协议、缓存配置和连接四元组都一致时不重复存。 */
function uniquePresetName(
  desired: string,
  provider: 'openai' | 'anthropic',
  baseURL: string,
  apiKey: string,
  model: string,
  contextWindow: number,
  anthropicPromptCache: boolean,
): string | null {
  const existing = listPresets();
  const sameEntry = existing.find(
    (p) => p.provider === provider && p.baseURL === baseURL && p.apiKey === apiKey
      && p.model === model && p.contextWindow === contextWindow
      && p.anthropicPromptCache === anthropicPromptCache,
  );
  if (sameEntry) return null;
  const sanitized = desired
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'preset';
  const base = isValidPresetName(sanitized) ? sanitized : 'preset';
  if (!existing.some((p) => p.name === base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (candidate.length > 32) return `${base.slice(0, 32 - String(i).length - 1)}-${i}`;
    if (!existing.some((p) => p.name === candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export const modelCommands: CommandHandler[] = [
  async (ctx: CommandContext) => {
    const { line } = ctx;
    if (line !== '/model' && !line.startsWith('/model ')) return unhandled();
    const arg = line.startsWith('/model ') ? line.slice('/model '.length).trim() : '';
    const { history } = ctx;

    // 共用:apply 一个预设到 config + 持久化 + 重建 client + 重显横幅。无参 /model 选菜单和 /model use 都走这里。
    const applyPresetAndPersist = (target: {
      name: string;
      provider: 'openai' | 'anthropic';
      baseURL: string;
      apiKey: string;
      model: string;
      contextWindow: number;
      anthropicPromptCache: boolean;
    }): void => {
      updateModelConfig({
        provider: target.provider,
        model: target.model,
        baseURL: target.baseURL,
        apiKey: target.apiKey,
        contextWindowTokens: target.contextWindow,
        anthropicPromptCache: target.anthropicPromptCache,
      });
      writeConfigKeys({
        LLM_PROVIDER: target.provider,
        LLM_BASE_URL: target.baseURL,
        LLM_API_KEY: target.apiKey,
        LLM_MODEL: target.model,
        CONTEXT_WINDOW_TOKENS: String(target.contextWindow),
        ANTHROPIC_PROMPT_CACHE: target.anthropicPromptCache ? 'true' : 'false',
      });
      reconfigureClient();
      // 记为激活预设:让上下文窗口等配置从此跟随该预设文件(下次启动也用它,不再回退 config 裸键)。
      try { setActivePresetName(target.name); } catch { /* 指针写失败不阻断切换 */ }
      ctx.refreshStatusBase(history);
      layout.clearContent();
      if (history.some((m) => m.role === 'user')) {
        renderHistory(history);
      } else {
        layout.writeBanner(bannerLines(ctx.banner()));
      }
      const cacheLabel = target.provider === 'anthropic'
        ? ` · Prompt Cache ${target.anthropicPromptCache ? 'on' : 'off'}`
        : '';
      layout.contentWrite(`${ui.dim}(已切换到预设 “${target.name}” → ${target.model} · ${target.provider}${cacheLabel} · 窗口 ${target.contextWindow} @ ${target.baseURL})${ui.reset}\n`);
      if (config.llmKeysFromShell.length > 0) {
        layout.contentWrite(
          `${ui.dim}(shell 环境变量已设 ${config.llmKeysFromShell.join(' / ')},优先级最高,下次启动会盖掉预设的对应字段;预设仍记为激活,取消 shell 设置后恢复跟随)${ui.reset}\n`,
        );
      }
    };

    // /model switch:弹 ↑↓·Enter 菜单挑预设切换。无预设时给一行引导。
    if (arg === 'switch') {
      const presets = listPresets();
      if (presets.length === 0) {
        layout.contentWrite(`${ui.dim}(还没有预设;先跑 /model 添加一个)${ui.reset}\n`);
        return next();
      }
      const isCurrent = (p: typeof presets[number]): boolean =>
        p.provider === config.provider &&
        p.baseURL === config.baseURL &&
        p.apiKey === config.apiKey &&
        p.model === config.model &&
        p.contextWindow === config.contextWindowTokens &&
        p.anthropicPromptCache === (config.provider === 'anthropic' && config.anthropicPromptCache);
      const cols = layout.getGeo().cols;
      const labelFor = (p: typeof presets[number]): string => {
        const tag = isCurrent(p) ? ' ★current' : '';
        const cache = p.provider === 'anthropic' ? ` · cache ${p.anthropicPromptCache ? 'on' : 'off'}` : '';
        const right = `${p.provider}${cache} · ${p.model} @ ${p.baseURL}`;
        const left = `${p.name}${tag}`;
        const sep = left.length + 1 + right.length;
        if (sep <= cols - 2) return `${left} ${ui.dim}${right}${ui.reset}`;
        return left;
      };
      const choice = await promptIntervention({
        type: 'choice',
        title: '切换模型预设',
        detail: `当前: ${config.provider} · ${config.model} @ ${config.baseURL}(★ = 已匹配)`,
        options: presets.map(labelFor),
        allowCustom: false, // 纯切换,不需要「其他」干扰
      });
      if (choice.action === 'selected' && choice.value) {
        // 精确匹配 labelFor 生成的完整选项串,避免 name 前缀误命中
        // (如 'qwen3-8-27b' 是 'qwen3-8-27b-2' 的前缀,排序在前会抢中,应用错 contextWindow)。
        const target = presets.find((p) => labelFor(p) === choice.value);
        if (target) applyPresetAndPersist(target);
      }
      return next();
    }

    // /model list:列已配置的预设(★ 标当前);无预设给一行引导。
    // /model presets 是同义别名(老用户习惯)。
    if (arg === 'list' || arg === 'presets') {
      const ps = listPresets();
      if (ps.length === 0) {
        layout.contentWrite(`${ui.dim}(还没有预设;先跑 /model 添加一个)${ui.reset}\n`);
        return next();
      }
      layout.contentWrite(`${ui.dim}已配置 ${ps.length} 个预设:${ui.reset}\n`);
      for (const p of ps) {
        const current = p.provider === config.provider
          && p.baseURL === config.baseURL
          && p.apiKey === config.apiKey
          && p.model === config.model
          && p.contextWindow === config.contextWindowTokens
          && p.anthropicPromptCache === (config.provider === 'anthropic' && config.anthropicPromptCache);
        const star = current ? ' ★' : '';
        const cache = p.provider === 'anthropic' ? ` · cache ${p.anthropicPromptCache ? 'on' : 'off'}` : '';
        layout.contentWrite(
          `  ${ui.accent}${p.name}${ui.reset}${star}  ${ui.dim}${p.provider}${cache} · ${p.model} @ ${p.baseURL}${ui.reset}\n`,
        );
      }
      layout.contentWrite(`${ui.dim}(★ = 与当前协议及缓存配置一致;切换用 /model switch)${ui.reset}\n`);
      return next();
    }

    // /model show:显示当前协议、连接与缓存配置(apiKey 脱敏)。
    if (arg === 'show') {
      layout.contentWrite(`${ui.dim}当前模型配置:${ui.reset}\n`);
      layout.contentWrite(`  ${ui.accent}provider${ui.reset}  ${config.provider}\n`);
      layout.contentWrite(`  ${ui.accent}baseURL ${ui.reset}  ${config.baseURL}\n`);
      layout.contentWrite(`  ${ui.accent}apiKey  ${ui.reset}  ${maskKey(config.apiKey)}\n`);
      layout.contentWrite(`  ${ui.accent}model   ${ui.reset}  ${config.model}\n`);
      layout.contentWrite(`  ${ui.accent}窗口    ${ui.reset}  ${config.contextWindowTokens} tokens\n`);
      if (config.provider === 'anthropic') {
        layout.contentWrite(`  ${ui.accent}缓存    ${ui.reset}  Prompt Cache ${config.anthropicPromptCache ? 'on' : 'off'}\n`);
      }
      layout.contentWrite(`${ui.dim}(配置文件: ${CONFIG_PATH})${ui.reset}\n`);
      return next();
    }

    // /model use <name>:一键把预设应用到 config + 持久化 + 重建 client。
    if (arg.startsWith('use ')) {
      const name = arg.slice(4).trim();
      if (!name) {
        layout.contentWrite(`${ui.yellow}用法: /model use <name>${ui.reset}\n`);
        return next();
      }
      if (!isValidPresetName(name)) {
        layout.contentWrite(`${ui.yellow}非法名字: ${name}(仅允许 [a-zA-Z0-9_-]{1,32})${ui.reset}\n`);
        return next();
      }
      let preset;
      try {
        preset = getPreset(name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          layout.contentWrite(`${ui.yellow}没有预设 “${name}”;先 /model save ${name}${ui.reset}\n`);
        } else {
          layout.contentWrite(`${ui.red}/model use 失败: ${(e as Error).message}${ui.reset}\n`);
        }
        return next();
      }
      applyPresetAndPersist(preset);
      return next();
    }

    // /model delete <name>:删一个预设。无参 / 重名 / 非法名字分别给不同提示。
    if (arg.startsWith('delete ')) {
      const name = arg.slice(7).trim();
      if (!name) {
        layout.contentWrite(`${ui.yellow}用法: /model delete <name>${ui.reset}\n`);
        return next();
      }
      if (!isValidPresetName(name)) {
        layout.contentWrite(`${ui.yellow}非法名字: ${name}(仅允许 [a-zA-Z0-9_-]{1,32})${ui.reset}\n`);
        return next();
      }
      if (deletePreset(name)) {
        layout.contentWrite(`${ui.dim}已删除预设 “${name}”${ui.reset}\n`);
      } else {
        layout.contentWrite(`${ui.yellow}没有预设 “${name}”${ui.reset}\n`);
      }
      return next();
    }

    // /model 后跟了未知子命令 → 给一行简短用法提示,免得静默吞用户输入。
    // arg === '' → 直接进向导(下方 4 步链);这里只兜底非法子命令。
    if (arg !== '') {
      layout.contentWrite(
        `${ui.yellow}未知子命令: ${arg}${ui.reset}\n` +
          `${ui.dim}用法: /model(配置新模型向导) · /model switch · /model list · /model delete <name>${ui.reset}\n`,
      );
      return next();
    }

    // /model 无参 → 直接进入「配置新模型」4 步向导(不弹动作菜单)。
    //   切换 / 查看 / 删除已配置预设改用显式子命令:/model switch · /model list · /model delete <name>。

    // 1) 选 provider 预设(预填 baseURL,后续仍可逐项改)。
    let preset: typeof MODEL_PRESETS[number];
    try {
      const res = await promptIntervention({
        type: 'choice',
        title: '选择后端预设(预填 baseURL,后续可改)',
        detail: '选一个会预填 baseURL/model/窗口,之后逐项确认。选「自定义」全部手填。',
        options: MODEL_PRESETS.map((p) => p.label),
      });
      if (res.action === 'cancelled') { return next(); }
      const idx = MODEL_PRESETS.findIndex((p) => p.label === res.value);
      if (idx === -1) { return next(); }
      preset = MODEL_PRESETS[idx];
    } catch {
      return next(); // Ctrl+C
    }

    // 1.5) 一键应用确认:非「自定义」预设(带预填值)给直接应用入口,免连按 4 次回车。
    //      直接应用 = 用预设 model/baseURL/window + 保留当前 apiKey(等价于下方逐项链连按回车)。
    //      逐项修改 / 自定义输入(promptIntervention choice 自动追加的「其他」项 submitted)→ 回落 4 步链。
    //      「自定义」预设字段空,跳过确认直接进链。
    let quickApply = false;
    if (preset.model || preset.baseURL) {
      try {
        const res = await promptIntervention({
          type: 'choice',
          title: `应用 ${preset.label}?`,
          detail: `model   ${preset.model}\nbaseURL ${preset.baseURL}\napiKey  ${maskKey(config.apiKey)}(直接应用=保留当前)\n窗口    ${preset.window}`,
          options: ['直接应用', '逐项修改'],
          allowCustom: false,
        });
        if (res.action === 'cancelled') { return next(); }
        if (res.action === 'selected' && res.value === '直接应用') {
          quickApply = true;
        }
        // 其余(逐项修改 / 自定义输入 submitted)→ quickApply 保持 false,走下方逐项链
      } catch {
        return next(); // Ctrl+C
      }
    }

    // 2) 收集 baseURL / apiKey / model / contextWindowTokens。
    //    quickApply:直接取预设值 + 当前 apiKey;否则逐项 input(预填 preset 值,回车=采纳;apiKey 不预填明文,回车=保留旧值)。
    let baseURL: string;
    let apiKey: string;
    let model: string;
    let window: number;
    if (quickApply) {
      baseURL = preset.baseURL;
      apiKey = config.apiKey;
      model = preset.model;
      window = preset.window;
    } else {
      // baseURL
      {
        const res = await promptIntervention({
          type: 'input',
          title: 'LLM_BASE_URL',
          detail: 'OpenAI 兼容 API 端点。回车采纳预填值。',
          seed: preset.baseURL || config.baseURL,
        });
        if (res.action === 'cancelled') { return next(); }
        baseURL = (res.value ?? '').trim() || preset.baseURL || config.baseURL;
      }
      if (!baseURL) {
        layout.contentWrite(`${ui.yellow}baseURL 不能为空,已取消。${ui.reset}\n`);
        return next();
      }

      // apiKey(不预填明文:回车=保留旧值,输入新值=覆盖)
      {
        const res = await promptIntervention({
          type: 'input',
          title: 'LLM_API_KEY',
          detail: `回车保留当前 ${maskKey(config.apiKey)};输入新值则覆盖。`,
          seed: '',
        });
        if (res.action === 'cancelled') { return next(); }
        const v = (res.value ?? '').trim();
        apiKey = v || config.apiKey;
      }
      if (!apiKey) {
        layout.contentWrite(`${ui.yellow}apiKey 不能为空,已取消。${ui.reset}\n`);
        return next();
      }

      // model
      {
        const res = await promptIntervention({
          type: 'input',
          title: 'LLM_MODEL',
          detail: '模型名(须支持 function calling)。回车采纳预填值。',
          seed: preset.model || config.model,
        });
        if (res.action === 'cancelled') { return next(); }
        model = (res.value ?? '').trim() || preset.model || config.model;
      }
      if (!model) {
        layout.contentWrite(`${ui.yellow}model 不能为空,已取消。${ui.reset}\n`);
        return next();
      }

      // contextWindowTokens
      {
        const res = await promptIntervention({
          type: 'input',
          title: 'CONTEXT_WINDOW_TOKENS',
          detail: '模型上下文窗口，全局默认 256k；如需不同窗口可手动覆盖。回车采纳预填值。',
          seed: String(preset.window || config.contextWindowTokens),
        });
        if (res.action === 'cancelled') { return next(); }
        const v = (res.value ?? '').trim();
        const n = Number(v);
        if (!v || !Number.isFinite(n) || n <= 0) {
          // 非法输入:保留旧值,不阻断(用 preset.window 或当前值兜底)
          window = preset.window || config.contextWindowTokens;
        } else {
          window = Math.floor(n);
        }
      }
    }

    // 3) 应用协议、连接与缓存配置；Anthropic 原生协议无需重建 OpenAI client，但统一刷新无害。
    const provider = preset.provider;
    const anthropicPromptCache = provider === 'anthropic' && preset.anthropicPromptCache;
    updateModelConfig({
      provider,
      model,
      baseURL,
      apiKey,
      contextWindowTokens: window,
      anthropicPromptCache,
    });
    writeConfigKeys({
      LLM_PROVIDER: provider,
      LLM_BASE_URL: baseURL,
      LLM_API_KEY: apiKey,
      LLM_MODEL: model,
      CONTEXT_WINDOW_TOKENS: String(window),
      ANTHROPIC_PROMPT_CACHE: anthropicPromptCache ? 'true' : 'false',
    });
    reconfigureClient();

    // 3.5) 自动存为命名预设；协议与缓存策略也是去重键的一部分。
    let savedName: string | null = null;
    try {
      const finalName = uniquePresetName(
        model,
        provider,
        baseURL,
        apiKey,
        model,
        window,
        anthropicPromptCache,
      );
      if (finalName) {
        savePreset({
          name: finalName,
          provider,
          baseURL,
          apiKey,
          model,
          contextWindow: window,
          anthropicPromptCache,
        });
        savedName = finalName;
      }
      // 记为激活预设(新存或复用同名都记),让窗口跟随该预设文件。
      if (savedName) {
        try { setActivePresetName(savedName); } catch { /* 指针写失败不阻断 */ }
      }
    } catch (e) {
      layout.contentWrite(`${ui.red}保存预设失败: ${(e as Error).message}${ui.reset}\n`);
    }

    // 4) 刷新 UI:底栏模型名 + 重显横幅(banner() 闭包实时读 config,自动反映新值)。
    ctx.refreshStatusBase(history);
    layout.clearContent();
    if (history.some((m) => m.role === 'user')) {
      renderHistory(history);
    } else {
      layout.writeBanner(bannerLines(ctx.banner()));
    }
    const cacheLabel = provider === 'anthropic'
      ? ` · Prompt Cache ${anthropicPromptCache ? 'on' : 'off'}`
      : '';
    layout.contentWrite(`${ui.dim}(已切换模型 → ${model} · ${provider}${cacheLabel} @ ${baseURL})${ui.reset}\n`);
    if (savedName) {
      layout.contentWrite(`${ui.dim}(已保存为预设 “${savedName}”,下次 /model use ${savedName} 一键切回)${ui.reset}\n`);
    }

    // 5) dim 警告:shell export 的 LLM 键下次启动会覆盖文件值。
    if (config.llmKeysFromShell.length > 0) {
      layout.contentWrite(
        `${ui.dim}(shell 环境变量已设 ${config.llmKeysFromShell.join(' / ')},文件写入下次启动被其覆盖;取消该 shell 设置后生效)${ui.reset}\n`,
      );
    }
    return next();
  },
];
