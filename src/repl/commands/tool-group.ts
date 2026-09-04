/**
 * 工具开关命令组:/subagent · /fe(/frontend) · /mcp · /memory_switch · /memory_status
 *
 * 四条命令同构:status 只读 → on/off 切换 → updateXxxConfig(内存+env)→
 * updateConfigKey(写盘)→ 视开关性质决定 refreshChatTools / MCP 连接 / 仅提示重启。
 *
 * 关键差异(不要抹平):
 * - /subagent /fe:切换后立即 refreshChatTools(),schema 实时生效。
 * - /mcp:on 时 initializeAllMcp + registerToolsExtension,off 时 closeAllMcp +
 *   注册空表;这是唯一带 async 副作用的开关。
 * - /memory_switch:工具表是**模块初始化快照**,切换不重算 builtinTools——已发出的
 *   请求工具列表不回滚,完全生效需重启 REPL。但 buildSystemMessage 每次 chat 现拼,
 *   所以系统提示词和 plan suffix 下一轮即时反映。
 *
 * 共同收尾:改写 history[0] 系统提示 + rewriteBanner(banner() 闭包实时读开关)。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { t } from '../../i18n/index.js';
import {
  config,
  isSubAgentEnabled,
  updateSubAgentConfig,
  isFrontendToolsEnabled,
  updateFrontendToolsConfig,
  isMcpEnabled,
  updateMcpConfig,
  isMemoryEnabled,
  updateMemoryConfig,
} from '../../config/index.js';
import { updateConfigKey, CONFIG_PATH } from '../../config/file.js';
import { getAgentMode } from '../../agent/mode.js';
import { refreshChatTools } from '../../llm/index.js';
import { registerToolsExtension } from '../../tools/registry.js';
import { initializeAllMcp, getMcpTools, closeAllMcp } from '../../mcp/index.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const toolGroupCommands: CommandHandler[] = [
  // /subagent [status|on|off]
  (ctx) => {
    const { line } = ctx;
    if (line !== '/subagent' && !line.startsWith('/subagent ')) return unhandled();
    const arg = line.startsWith('/subagent ') ? line.slice('/subagent '.length).trim().toLowerCase() : 'status';
    if (arg === '' || arg === 'status') {
      const enabled = isSubAgentEnabled();
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
    if (enabled !== isSubAgentEnabled()) {
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

  // /fe|/frontend [status|on|off] — 前端工具簇总开关(browser / dev_server / screenshot / view_image)。
  // 无参切换 on/off;有参 on|off 显式;status 只读。设计同 /subagent:单一来源
  // isFrontendToolsEnabled();关闭时 4 个工具不进模型 schema(refreshChatTools 过滤)、
  // 运行时 getRuntimeDisabledTools 兜底拦截、plan 模式 getPlanDisabledTools 也剔除。默认 false。
  (ctx) => {
    const { line } = ctx;
    const isFe =
      line === '/fe' || line.startsWith('/fe ') || line === '/frontend' || line.startsWith('/frontend ');
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
      const enabled = isFrontendToolsEnabled();
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
    if (enabled !== isFrontendToolsEnabled()) {
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

  // /memory_switch [on|off|status] · /memory_status — 记忆子系统总开关。
  // 无参切换;/memory_switch on|off 显式;true|false|1|0|yes|no 等同义。/memory_status 只读(不写盘)。
  (ctx) => {
    const { line } = ctx;
    const isMemSwitch =
      line === '/memory_switch' ||
      line.startsWith('/memory_switch ') ||
      line === '/memory_status' ||
      line.startsWith('/memory_status ');
    if (!isMemSwitch) return unhandled();
    try {
      if (line === '/memory_status' || line.startsWith('/memory_status ')) {
        const on = isMemoryEnabled();
        layout.contentWrite(
          `${ui.accent}记忆子系统:${ui.reset} ${on ? `${ui.green}开启` : `${ui.yellow}关闭`}${ui.reset}\n`,
        );
        layout.contentWrite(
          `${ui.dim}  单一来源 isMemoryEnabled()(${config.memoryEnabled});` +
            `持久化 ${ui.accent}MEMORY_ENABLED${ui.dim};` +
            `配置文件 ${CONFIG_PATH}${ui.reset}\n`,
        );
        layout.contentWrite(
          `${ui.dim}  关闭时:memory_*_save/_search/_list/_update/_forget 五个工具整体不进工具表;` +
            `buildBasePrompt() 不含「## Memory」段;` +
            `plan-mode 提示词里也不出现 memory_* 工具名。${ui.reset}\n`,
        );
        layout.contentWrite(
          `${ui.dim}  切换后下次新建 system message 即时反映;当前会话工具表需重启 REPL 才完整重算。${ui.reset}\n`,
        );
        return next();
      }
      const arg = line.startsWith('/memory_switch ')
        ? line.slice('/memory_switch '.length).trim().toLowerCase()
        : '';
      let nextEnabled: boolean;
      if (arg === '') {
        nextEnabled = !isMemoryEnabled();
      } else if (['on', 'true', '1', 'yes', 'y', 'enable', 'enabled'].includes(arg)) {
        nextEnabled = true;
      } else if (['off', 'false', '0', 'no', 'n', 'disable', 'disabled'].includes(arg)) {
        nextEnabled = false;
      } else {
        layout.contentWrite(
          `${ui.yellow}/memory_switch 用法:${ui.reset}\n` +
            `  /memory_switch             切换(开↔关)\n` +
            `  /memory_switch on|off      显式设值\n` +
            `  /memory_switch status      等同 /memory_status\n`,
        );
        return next();
      }
      const prev = isMemoryEnabled();
      if (nextEnabled === prev) {
        layout.contentWrite(
          `${ui.dim}(已是 ${nextEnabled ? '开启' : '关闭'},未变更 — 持久化字段未写入)${ui.reset}\n`,
        );
        return next();
      }
      updateMemoryConfig(nextEnabled);
      // 写盘:mode 文件 values,/~/.mocode/config;writeConfigKeys 不会动其它键(主题 / 模型等)
      updateConfigKey('MEMORY_ENABLED', nextEnabled ? 'true' : 'false');
      const note = nextEnabled
        ? `${ui.green}已开启记忆子系统${ui.reset} — memory_save/search/list/update/forget/graph 进入工具表;` +
          `Memory Index 段会在下次拼 system message 时注入。工具表本身的快照需要重启 REPL 才完整刷新。`
        : `${ui.yellow}已关闭记忆子系统${ui.reset} — 六个 memory_* 工具将在下次拼 system message 时从工具表过滤;` +
          `Memory Index 段不再出现;plan-mode 提示词里的 memory_* 字样消失。重启 REPL 后工具表完全不出现。`;
      layout.contentWrite(`${note}\n`);
      layout.contentWrite(
        `${ui.dim}(写入 ${CONFIG_PATH}:MEMORY_ENABLED=${nextEnabled ? 'true' : 'false'};${ui.reset}` +
          (process.env.MEMORY_ENABLED
            ? `${ui.dim}同 session shell 未 export,文件写入即时生效)${ui.reset}\n`
            : `${ui.dim}下次启动仍生效)${ui.reset}\n`),
      );
      // 即时刷 banner(原地替换顶部 bannerH 行,不留副本):banner() 闭包实时读
      // isMemoryEnabled(),无需重启 REPL。buffer 中 bannerH 之下的对话历史位置不动。
      layout.rewriteBanner(bannerLines(ctx.banner()));
    } catch (e) {
      layout.contentWrite(`${ui.red}/memory_switch 失败:${ui.reset} ${(e as Error).message}\n`);
    }
    return next();
  },
];
