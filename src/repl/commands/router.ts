/**
 * /router —— 工具预路由后端切换与配置(llm | jev)。
 *
 * 为什么单独一个命令而不是并进 /model:
 * /model 管的是「主 Agent 用哪个大模型」(OpenAI/Anthropic 兼容),而预路由后端是**另一个**
 * 决策面——可以让主 Agent 用 A 模型、预路由用 Jev。二者生命周期独立,故独立命令。
 *
 * 即时性:所有读写都落在 process.env(见 config/index.ts 的 getRouterMode/getJevRouterConfig),
 * 而 routeToolGroups 在**每个真实用户 turn** 的调用点才读它 → 改完下一轮生效,无需重启。
 * 这也是为什么不走 Config 单例:const config 在模块初始化时求值,拿不到运行时切换。
 *
 * 持久化:~/.mocode/config(与 /model /theme 同一入口 writeConfigKeys)。
 * 注意 shell 里 export 了同名 MOCODE_ROUTER_* 时,loadEnvFiles 不回填该键,下次启动仍以 shell 为准。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { t } from '../../i18n/index.js';
import {
  getRouterMode,
  updateRouterMode,
  getJevRouterConfig,
  updateJevRouterConfig,
  isJevRouterConfigured,
  isToolRoutingEnabled,
  updateToolRoutingEnabled,
} from '../../config/index.js';
import { writeConfigKeys, CONFIG_PATH } from '../../config/file.js';
import { probeJev } from '../../tools/jev-client.js';
import { maskKey } from '../commands.js';
import { unhandled, next, type CommandHandler } from './types.js';

const ROUTER_ENV_KEYS = {
  enabled: 'MOCODE_ROUTER_ENABLED',
  mode: 'MOCODE_ROUTER_MODE',
  baseUrl: 'MOCODE_ROUTER_JEV_BASE_URL',
  apiKey: 'MOCODE_ROUTER_JEV_API_KEY',
  model: 'MOCODE_ROUTER_JEV_MODEL',
  confidenceMin: 'MOCODE_ROUTER_CONFIDENCE_MIN',
  confidenceMinMcp: 'MOCODE_ROUTER_CONFIDENCE_MIN_MCP',
} as const;

export const routerCommands: CommandHandler[] = [
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/router' && !line.startsWith('/router ')) return unhandled();

    const rest = line.startsWith('/router ') ? line.slice('/router '.length).trim() : '';
    const spaceIndex = rest.indexOf(' ');
    const sub = (spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1).trim();

    const showStatus = (): void => {
      const enabled = isToolRoutingEnabled();
      const stateLabel = t(enabled ? 'router.stateOn' : 'router.stateOff');
      layout.contentWrite(
        `${enabled ? ui.green : ui.yellow}${t('router.toggleStatus', { state: stateLabel })}${ui.reset}\n`,
      );
      const mode = getRouterMode();
      const label = mode === 'jev' ? t('router.modeJev') : t('router.modeLlm');
      layout.contentWrite(`${ui.accent}${t('router.status', { mode: label })}${ui.reset}\n`);
      const jev = getJevRouterConfig();
      layout.contentWrite(
        `${ui.dim}${t('router.jevConfig', {
          baseUrl: jev.baseUrl,
          model: jev.model,
          key: maskKey(jev.apiKey),
          min: String(jev.confidenceMin),
          minMcp: String(jev.confidenceMinMcp),
        })}${ui.reset}\n`,
      );
      layout.contentWrite(
        `${ui.dim}${t('router.source', { env: ROUTER_ENV_KEYS.mode, path: CONFIG_PATH })}${ui.reset}\n`,
      );
    };

    // /router 或 /router status
    if (rest === '' || sub === 'status') {
      showStatus();
      return next();
    }

    // /router on | /router off —— 预路由总开关。off = 跳过每轮路由调用,只保留默认簇。
    if (sub === 'on' || sub === 'off') {
      const enabled = sub === 'on';
      updateToolRoutingEnabled(enabled);
      writeConfigKeys({ [ROUTER_ENV_KEYS.enabled]: enabled ? 'true' : 'false' });
      layout.contentWrite(`${ui.green}${t(enabled ? 'router.enabledOn' : 'router.enabledOff')}${ui.reset}\n`);
      return next();
    }

    // /router llm | /router jev —— 切换后端
    if (sub === 'llm' || sub === 'jev') {
      const mode = sub === 'jev' ? 'jev' : 'llm';
      updateRouterMode(mode);
      writeConfigKeys({ [ROUTER_ENV_KEYS.mode]: mode });
      const label = mode === 'jev' ? t('router.modeJev') : t('router.modeLlm');
      layout.contentWrite(`${ui.green}${t('router.changed', { mode: label })}${ui.reset}\n`);
      // 切到 jev 但没配 key 是最常见的无用配置,当场提示,避免用户以为已生效。
      if (mode === 'jev' && !isJevRouterConfigured()) {
        layout.contentWrite(`${ui.yellow}${t('router.needsKey')}${ui.reset}\n`);
      }
      return next();
    }

    // /router base <url>
    if (sub === 'base') {
      if (!arg) {
        layout.contentWrite(`${ui.yellow}${t('router.usage')}${ui.reset}\n`);
        return next();
      }
      if (!/^https?:\/\//i.test(arg)) {
        layout.contentWrite(`${ui.yellow}${t('router.invalid', { detail: arg })}${ui.reset}\n`);
        return next();
      }
      const baseUrl = arg.replace(/\/+$/, '');
      updateJevRouterConfig({ baseUrl });
      writeConfigKeys({ [ROUTER_ENV_KEYS.baseUrl]: baseUrl });
      layout.contentWrite(`${ui.green}${t('router.set', { field: 'baseUrl', value: baseUrl })}${ui.reset}\n`);
      return next();
    }

    // /router key <key> —— 明文 key 写入 ~/.mocode/config,与 /model 对 LLM_API_KEY 的做法一致;显示只露末 4 位。
    if (sub === 'key') {
      if (!arg) {
        layout.contentWrite(`${ui.yellow}${t('router.usage')}${ui.reset}\n`);
        return next();
      }
      updateJevRouterConfig({ apiKey: arg });
      writeConfigKeys({ [ROUTER_ENV_KEYS.apiKey]: arg });
      layout.contentWrite(`${ui.green}${t('router.set', { field: 'apiKey', value: maskKey(arg) })}${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}${t('router.saved', { path: CONFIG_PATH })}${ui.reset}\n`);
      return next();
    }

    // /router model <name>
    if (sub === 'model') {
      if (!arg) {
        layout.contentWrite(`${ui.yellow}${t('router.usage')}${ui.reset}\n`);
        return next();
      }
      updateJevRouterConfig({ model: arg });
      writeConfigKeys({ [ROUTER_ENV_KEYS.model]: arg });
      layout.contentWrite(`${ui.green}${t('router.set', { field: 'model', value: arg })}${ui.reset}\n`);
      return next();
    }

    // /router min <0-1> 与 /router min-mcp <0-1>
    if (sub === 'min' || sub === 'min-mcp') {
      const value = Number(arg);
      if (!arg || !Number.isFinite(value) || value < 0 || value > 1) {
        layout.contentWrite(`${ui.yellow}${t('router.invalid', { detail: arg || '(空)' })}${ui.reset}\n`);
        return next();
      }
      const field = sub === 'min' ? 'confidenceMin' : 'confidenceMinMcp';
      const envKey = sub === 'min' ? ROUTER_ENV_KEYS.confidenceMin : ROUTER_ENV_KEYS.confidenceMinMcp;
      updateJevRouterConfig({ [field]: value });
      writeConfigKeys({ [envKey]: String(value) });
      layout.contentWrite(`${ui.green}${t('router.set', { field: sub, value: String(value) })}${ui.reset}\n`);
      return next();
    }

    // /router test —— 探测 Jev 端点连通性(不等下一轮,当场给结果)
    if (sub === 'test') {
      const jev = getJevRouterConfig();
      layout.contentWrite(`${ui.dim}${t('router.testRunning')}${ui.reset}\n`);
      const result = await probeJev({ baseUrl: jev.baseUrl, apiKey: jev.apiKey, model: jev.model });
      if (result.ok) {
        layout.contentWrite(
          `${ui.green}${t('router.testOk', { latency: String(result.latencyMs), model: result.model ?? jev.model })}${ui.reset}\n`,
        );
      } else {
        layout.contentWrite(`${ui.red}${t('router.testFail', { error: result.error ?? 'unknown' })}${ui.reset}\n`);
      }
      return next();
    }

    layout.contentWrite(`${ui.yellow}${t('router.usage')}${ui.reset}\n`);
    return next();
  },
];
