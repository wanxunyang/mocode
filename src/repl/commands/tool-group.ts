/**
 * 自动工具路由的 capability gate 命令组：/subagent · /fe(/frontend) · /cu(/computer) ·
 * /mcp · /memory_switch · /memory_status。
 *
 * `/subagent`、`/fe`、`/cu` 不再把工具常驻加入 schema：on/unset 仅允许下一真实用户轮的
 * LLM router 按需选择对应簇，off 写入 env=false 并形成硬否决。refreshChatTools 只为没有
 * ToolPolicy 的 legacy 嵌入路径保留。MCP 仍负责真实连接生命周期；memory 开关还控制索引。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { t } from '../../i18n/index.js';
import {
  isSubAgentRouteAllowed,
  updateSubAgentConfig,
  isFrontendRouteAllowed,
  updateFrontendToolsConfig,
  isComputerUseRouteAllowed,
  updateComputerUseConfig,
  isMcpEnabled,
  updateMcpConfig,
  isMemoryEnabled,
  isMemoryRouteAllowed,
  updateMemoryConfig,
} from '../../config/index.js';
import { updateConfigKey, CONFIG_PATH } from '../../config/file.js';
import { getAgentMode } from '../../agent/mode.js';
import { refreshChatTools } from '../../llm/index.js';
import { registerToolsExtension } from '../../tools/registry.js';
import { initializeAllMcp, getMcpTools, closeAllMcp } from '../../mcp/index.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const toolGroupCommands: CommandHandler[] = [
  // /subagent [status|on|off] — orchestration 簇的兼容 capability gate。
  (ctx) => {
    const { line } = ctx;
    if (line !== '/subagent' && !line.startsWith('/subagent ')) return unhandled();
    const arg = line.startsWith('/subagent ') ? line.slice('/subagent '.length).trim().toLowerCase() : 'status';
    if (arg === '' || arg === 'status') {
      const enabled = isSubAgentRouteAllowed();
      const state = t(enabled ? 'subagent.stateOn' : 'subagent.stateOff');
      layout.contentWrite(
        `${ui.accent}${t('subagent.status', { state })}${ui.reset}\n` +
          `${ui.dim}MOCODE_SUBAGENT_ENABLED=${enabled ? 'true' : 'false'} · ${CONFIG_PATH}${ui.reset}\n`,
      );
      return next();
    }
    if (arg !== 'on' && arg !== 'off') {
      layout.contentWrite(`${ui.yellow}${t('subagent.usage')}${ui.reset}\n`);
      return next();
    }
    const enabled = arg === 'on';
    if (enabled !== isSubAgentRouteAllowed()) {
      updateSubAgentConfig(enabled);
      updateConfigKey('MOCODE_SUBAGENT_ENABLED', enabled ? 'true' : 'false');
      refreshChatTools();
      ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
      layout.rewriteBanner(bannerLines(ctx.banner()));
    }
    layout.contentWrite(
      `${enabled ? ui.green : ui.yellow}${t(enabled ? 'subagent.changedOn' : 'subagent.changedOff')}${ui.reset}\n`,
    );
    return next();
  },

  // /fe|/frontend [status|on|off] — browser-debug + desktop-observe 的兼容 gate。
  // view_image 是 common 工具，不受此开关影响。
  (ctx) => {
    const { line } = ctx;
    const isFe = line === '/fe' || line.startsWith('/fe ') || line === '/frontend' || line.startsWith('/frontend ');
    if (!isFe) return unhandled();
    const raw = line.startsWith('/fe ')
      ? line.slice('/fe '.length)
      : line.startsWith('/frontend ')
        ? line.slice('/frontend '.length)
        : line === '/frontend'
          ? ''
          : line.slice('/fe'.length);
    const arg = raw.trim().toLowerCase();
    if (arg === '' || arg === 'status') {
      const enabled = isFrontendRouteAllowed();
      const state = t(enabled ? 'fe.stateOn' : 'fe.stateOff');
      layout.contentWrite(
        `${ui.accent}${t('fe.status', { state })}${ui.reset}\n` +
          `${ui.dim}MOCODE_FRONTEND_TOOLS_ENABLED=${enabled ? 'true' : 'false'} · ${CONFIG_PATH}${ui.reset}\n`,
      );
      return next();
    }
    if (arg !== 'on' && arg !== 'off') {
      layout.contentWrite(`${ui.yellow}${t('fe.usage')}${ui.reset}\n`);
      return next();
    }
    const enabled = arg === 'on';
    if (enabled !== isFrontendRouteAllowed()) {
      updateFrontendToolsConfig(enabled);
      updateConfigKey('MOCODE_FRONTEND_TOOLS_ENABLED', enabled ? 'true' : 'false');
      refreshChatTools();
      ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
      layout.rewriteBanner(bannerLines(ctx.banner()));
    }
    layout.contentWrite(
      `${enabled ? ui.green : ui.yellow}${t(enabled ? 'fe.changedOn' : 'fe.changedOff')}${ui.reset}\n`,
    );
    return next();
  },

  // /cu|/computer [status|on|off] — computer-control 的高危 capability gate。
  // on 仅允许 router 在用户明确要求 GUI 操作时选择；每个动作仍经过权限门，plan 永远过滤。
  (ctx) => {
    const { line } = ctx;
    const isCu = line === '/cu' || line.startsWith('/cu ') || line === '/computer' || line.startsWith('/computer ');
    if (!isCu) return unhandled();
    const raw = line.startsWith('/cu ')
      ? line.slice('/cu '.length)
      : line.startsWith('/computer ')
        ? line.slice('/computer '.length)
        : line === '/computer'
          ? ''
          : line.slice('/cu'.length);
    const arg = raw.trim().toLowerCase();
    if (arg === '' || arg === 'status') {
      const enabled = isComputerUseRouteAllowed();
      const state = t(enabled ? 'cu.stateOn' : 'cu.stateOff');
      layout.contentWrite(
        `${ui.accent}${t('cu.status', { state })}${ui.reset}\n` +
          `${ui.dim}MOCODE_COMPUTER_USE_ENABLED=${enabled ? 'true' : 'false'} · ${CONFIG_PATH}${ui.reset}\n`,
      );
      return next();
    }
    if (arg !== 'on' && arg !== 'off') {
      layout.contentWrite(`${ui.yellow}${t('cu.usage')}${ui.reset}\n`);
      return next();
    }
    const enabled = arg === 'on';
    if (enabled !== isComputerUseRouteAllowed()) {
      updateComputerUseConfig(enabled);
      updateConfigKey('MOCODE_COMPUTER_USE_ENABLED', enabled ? 'true' : 'false');
      refreshChatTools();
      ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
      layout.rewriteBanner(bannerLines(ctx.banner()));
    }
    layout.contentWrite(
      `${enabled ? ui.green : ui.yellow}${t(enabled ? 'cu.changedOn' : 'cu.changedOff')}${ui.reset}\n`,
    );
    return next();
  },

  // /mcp [status|on|off] — 唯一带 async 副作用的开关(on 连 MCP,off 断)。
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/mcp' && !line.startsWith('/mcp ')) return unhandled();
    const arg = line.startsWith('/mcp ') ? line.slice('/mcp '.length).trim().toLowerCase() : 'status';
    if (arg === '' || arg === 'status') {
      const enabled = isMcpEnabled();
      const state = t(enabled ? 'mcp.stateOn' : 'mcp.stateOff');
      layout.contentWrite(
        `${ui.accent}${t('mcp.status', { state })}${ui.reset}\n` +
          `${ui.dim}MOCODE_MCP_ENABLED=${enabled ? 'true' : 'false'} · ${CONFIG_PATH}${ui.reset}\n` +
          `${ui.dim}${t('mcp.restartHint')}${ui.reset}\n`,
      );
      return next();
    }
    if (arg !== 'on' && arg !== 'off') {
      layout.contentWrite(`${ui.yellow}${t('mcp.usage')}${ui.reset}\n`);
      return next();
    }
    const enabled = arg === 'on';
    if (enabled === isMcpEnabled()) {
      layout.contentWrite(
        `${ui.dim}${t('mcp.unchanged', { state: t(enabled ? 'mcp.stateOn' : 'mcp.stateOff') })}${ui.reset}\n`,
      );
      return next();
    }
    updateMcpConfig(enabled);
    updateConfigKey('MOCODE_MCP_ENABLED', enabled ? 'true' : 'false');
    if (enabled) {
      await initializeAllMcp();
      registerToolsExtension('mcp', getMcpTools());
    } else {
      await closeAllMcp();
      registerToolsExtension('mcp', []);
    }
    refreshChatTools();
    ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
    layout.rewriteBanner(bannerLines(ctx.banner()));
    layout.contentWrite(
      `${enabled ? ui.green : ui.yellow}${t(enabled ? 'mcp.changedOn' : 'mcp.changedOff')}${ui.reset}\n`,
    );
    return next();
  },

  // /memory_switch [on|off|status] · /memory_status — 同时管理 memory route gate 与 Memory Index。
  // 无参切换；status 明确区分“可被路由”和“索引/反思已启用”，避免 unset 状态被误报为禁用。
  (ctx) => {
    const { line } = ctx;
    const isMemSwitch =
      line === '/memory_switch' ||
      line.startsWith('/memory_switch ') ||
      line === '/memory_status' ||
      line.startsWith('/memory_status ');
    if (!isMemSwitch) return unhandled();
    try {
      const switchArg = line.startsWith('/memory_switch ')
        ? line.slice('/memory_switch '.length).trim().toLowerCase()
        : '';
      const showStatus = line === '/memory_status' || line.startsWith('/memory_status ') || switchArg === 'status';
      if (showStatus) {
        const routeAllowed = isMemoryRouteAllowed();
        const indexEnabled = isMemoryEnabled();
        layout.contentWrite(
          `${ui.accent}${t('memory.routeStatus', {
            state: t(routeAllowed ? 'memory.stateAllowed' : 'memory.stateBlocked'),
          })}${ui.reset}\n` +
            `${ui.accent}${t('memory.indexStatus', {
              state: t(indexEnabled ? 'memory.stateEnabled' : 'memory.stateDisabled'),
            })}${ui.reset}\n`,
        );
        layout.contentWrite(
          `${ui.dim}${t('memory.source', {
            value: process.env.MEMORY_ENABLED ?? '<unset>',
            path: CONFIG_PATH,
          })}${ui.reset}\n` + `${ui.dim}${t('memory.statusHint')}${ui.reset}\n`,
        );
        return next();
      }

      let nextEnabled: boolean;
      if (switchArg === '') {
        nextEnabled = !isMemoryEnabled();
      } else if (['on', 'true', '1', 'yes', 'y', 'enable', 'enabled'].includes(switchArg)) {
        nextEnabled = true;
      } else if (['off', 'false', '0', 'no', 'n', 'disable', 'disabled'].includes(switchArg)) {
        nextEnabled = false;
      } else {
        layout.contentWrite(`${ui.yellow}${t('memory.usage')}${ui.reset}\n`);
        return next();
      }

      const indexEnabled = isMemoryEnabled();
      const routeAllowed = isMemoryRouteAllowed();
      const alreadyAligned = nextEnabled ? indexEnabled && routeAllowed : !indexEnabled && !routeAllowed;
      if (alreadyAligned) {
        layout.contentWrite(
          `${ui.dim}${t('memory.unchanged', {
            state: t(nextEnabled ? 'memory.stateEnabled' : 'memory.stateDisabled'),
          })}${ui.reset}\n`,
        );
        return next();
      }

      updateMemoryConfig(nextEnabled);
      updateConfigKey('MEMORY_ENABLED', nextEnabled ? 'true' : 'false');
      // 自动路由读取 env gate；legacy chatTools 同步刷新。
      refreshChatTools();
      ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
      layout.contentWrite(
        `${nextEnabled ? ui.green : ui.yellow}${t(nextEnabled ? 'memory.changedOn' : 'memory.changedOff')}${ui.reset}\n`,
      );
      layout.contentWrite(
        `${ui.dim}${t('memory.saved', {
          path: CONFIG_PATH,
          value: nextEnabled ? 'true' : 'false',
        })}${ui.reset}\n`,
      );
      // 即时刷新 banner；当前已发出的 immutable policy snapshot 不受影响。
      layout.rewriteBanner(bannerLines(ctx.banner()));
    } catch (error) {
      layout.contentWrite(
        `${ui.red}${t('memory.failed', { error: error instanceof Error ? error.message : String(error) })}${ui.reset}\n`,
      );
    }
    return next();
  },
];
