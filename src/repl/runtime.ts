import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin } from 'node:process';
import {
  config,
  updateModelConfig,
  isModelConfigured,
  isMemoryEnabled,
  buildBasePrompt,
  getPlanModeSuffix,
  pinSessionModel,
} from '../config/index.js';
import { t } from '../i18n/index.js';
import { writeConfigKeys, CONFIG_PATH } from '../config/file.js';
import {
  deletePreset,
  getPreset,
  isValidPresetName,
  listPresets,
  migrateCurrentToPreset,
  savePreset,
  setActivePresetName,
} from '../config/presets.js';
import { runAgent } from '../agent/index.js';
import { getAgentMode, setAgentMode, onModeChange } from '../agent/mode.js';
import { sendState } from '../pet/bridge.js';
import { setSandboxRoot } from '../sandbox/root.js';
import { ui, setTheme } from '../ui/theme.js';
import { bannerLines, displayWidth } from '../ui/render.js';
import * as layout from '../ui/layout.js';
import * as mouse from '../ui/mouse.js';
import {
  promptWithSlashMenu,
  promptTurnPicker,
  promptRevertChoice,
  type SessionPickerItem,
} from '../ui/prompt.js';
import { promptIntervention } from '../ui/intervention.js';
import { registerToolsExtension } from '../tools/registry.js';
import { initializeAllMcp, getMcpTools, closeAllMcp } from '../mcp/index.js';
import {
  reconfigureClient,
  refreshChatTools,
  chatTools,
  classifyChatError,
  type ChatMessage,
  type ChatUsage,
} from '../llm/index.js';
import { renderChip, type ImageAttachment } from '../attachments/image.js';
import type { ContentPart } from '../agent/core.js';
import {
  contextState,
  newSessionId,
  saveSession,
  loadSession,
  appendCurrentSessionRuntimeEvent,
} from '../session/index.js';
import {
  listTurns,
  planRollback,
  applyRollback,
  persistSnapshots,
  loadSnapshots,
  rebuildFromHistory,
  getCurrentTurnId,
} from '../rollback/index.js';
import { effectiveSystemPrompt } from '../skills/index.js';
import { clearSkillActivation } from '../skills/activation.js';
import {
  buildMemoryIndexSection,
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
} from '../memory/index.js';
import { setCurrentSessionId } from '../session/state.js';
import { collectQueryHistory } from '../session/query-history.js';

// ── 已拆分的子模块 ──
import {
  PROMPT,
  buildSlashCommands,
  LLM_ERROR_HINT_KEYS,
  isCommandShape,
  suggestCommand,
  MODEL_PRESETS,
  maskKey,
} from './commands.js';
import { dispatchCommand } from './commands/registry.js';
import {
  settlePlanStatus,
  refreshStatusBase,
  runningStateFor,
} from './status-bar.js';
import {
  messageAttachments,
  formatUserMessage,
  textOf,
  queryHistoryFromMessages,
  renderHistory,
} from './message-format.js';
import {
  startRunningListener,
  stopRunningListener,
  getRunningInput,
  clearRunningInput,
} from './running-input.js';

// ── 斜杠命令树已移到 ./commands.ts ──
// ── 状态栏已移到 ./status-bar.ts ──
// ── 运行中输入已移到 ./running-input.ts ──
// ── 消息格式化已移到 ./message-format.ts ──

// ── buildInitPrompt(/init 指令)已随 system 命令组搬到 ./commands/system.ts ──

/** stdin 的 keypress 事件接口(emitKeypressEvents 后发,不在 ReadStream 类型里)。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  off(event: 'keypress', listener: (str: string, key: Key) => void): this;
}
const emitter = stdin as unknown as KeypressEmitter;

// ── 运行态交互已移到 ./running-input.ts ──
// ── pendingPrefill / pendingTimer / pendingAttachments 保留在此(awaitPendingRecall / echoInput 用)
let pendingPrefill: string[] | null = null; // /rollback 选中后预填的 user 输入(下轮 INPUT 态消费)

// ── pending send 撤回窗口(用户按 Enter 后、agent 真发请求前)──
// 500ms 内 Ctrl+C / Esc → 整条用户气泡从内容区擦掉 + 原行 prefilled 回输入框(可改可再发);
// 期间再按 Enter 立即推进 / 时间到自然推进 → 走原流程 enterRunningMode + runTurn。
// attachmentsCount 记 pendingAttachments 当时长度——撤回时 attachments 保留(用户意图未变,只是改字)。
// 短单行:500ms(不拖慢日常)。长文本:MOCODE_RECALL_MS,默认 2000ms —— 人发现"误发了"通常要 1-3 秒,
// 500ms 根本来不及反应,只能事后 /rollback。
const PENDING_RECALL_MS = 500;
const PENDING_RECALL_LONG_MS = 2000;
/** 长输入阈值:与 prompt.ts 的二次确认阈值保持一致(≥2 行 或 ≥120 码点)。 */
const LONG_INPUT_CHARS = 120;

/** 按输入长度决定撤回窗口:长 prompt 给更宽的补救时间,短单行仍走 500ms。 */
function recallWindowMs(input: string[]): number {
  const joined = input.join('\n');
  const long = input.length >= 2 || [...joined].length >= LONG_INPUT_CHARS;
  if (!long) return PENDING_RECALL_MS;
  const env = Number(process.env.MOCODE_RECALL_MS);
  return Number.isFinite(env) && env >= 0 ? env : PENDING_RECALL_LONG_MS;
}
let pendingTimer: NodeJS.Timeout | null = null;
// agent 模式状态已提到 src/agent/mode.ts(共享叶子:switch_mode 工具可写、agent 每步读、repl 注册 onModeChange 监听器)。

/** 多模态 user 输入的附件状态。pending = 本轮尚未提交的待发图片;messageAttachments = 已 push 进 history 的图片元数据
 *  (供 renderHistory 复显文件名——base64 不可逆地塞进 history 后,只能从侧 channel 拿原文件名)。
 *  messageAttachments 已移到 ./message-format.ts (共享 Map,renderHistory 与 runTurn 都用)。 */
let pendingAttachments: ImageAttachment[] = [];

// ── onRunningKey / onRunningMousePaste / startRunningListener / stopRunningListener 已移到 ./running-input.ts ──

// formatUserMessage 已移到 ./message-format.ts

/** 把多行提交输入回显进内容区(❯ 首行,续行按 prompt 宽度缩进)。仅 TUI 态回显(非 TTY 由 readline 自带回显)。 */
function echoInput(lines: string[], trailingBlank = true): void {
  if (!layout.isActive()) return;
  layout.contentWrite(formatUserMessage(lines, trailingBlank));
  // 多模态附件:每张一行 chip 跟在 user bubble 后(原 /rollback /resume 复显一致)
  for (const a of pendingAttachments) {
    layout.contentWrite(`  ${ui.dim}${renderChip(a)}${ui.reset}\n`);
  }
  // 用户气泡会填满终端整列宽；Windows Terminal 在末列进入 pending-wrap 后，紧随的 LF
  // 偶尔只更新内部滚屏状态，导致上一轮耗时行与新气泡暂时黏连。缓冲中的物理行始终正确，
  // 提交后立即按缓冲重绘，避免必须等滚动或 Agent 结束时的 repaint 才显示正确边界。
  layout.repaintViewport();
}

/**
 * 等待 pending 撤回窗口(用户 Enter 后、agent 真发请求前的 500ms 兜底)。
 * 返 true=应 commit(走原 enterRunningMode + runTurn);false=应 recall(主循环 rewindContent 擦气泡 + prefill 回输入框)。
 *
 * 监听:
 *   - Esc / Ctrl+C → recall(shouldCommit=false)
 *   - Enter / Return → 立即 commit(shouldCommit=true)
 *   - 其它键忽略(不进 paste 路径、不挂 timer)
 *   - 500ms 定时器到 → 自动 commit(shouldCommit=true)
 *
 * 视觉:状态行 spinner 位临时改 '发送中…  (Esc / Ctrl+C 撤回)';commit 后
 * runAgent.onStepStart 会 setStatus('思考中') 接管,无需手动还原。
 *
 * 降级:非 TTY(setRawMode 抛错)直接 commit,window=0 —— CI / 管道回放路径不退化。
 */
function awaitPendingRecall(input: string[]): Promise<boolean> {
  layout.setStatus(t('agent.sending'), '●');

  // 非 TTY:setRawMode 抛错 → window=0 直返 true(向后退化,不走 raw + 不挂监听)。
  let ttyReady = false;
  try {
    stdin.setRawMode(true);
    ttyReady = true;
  } catch {
    ttyReady = false;
  }
  if (!ttyReady) {
    return Promise.resolve(true);
  }

  stdin.resume();
  emitKeypressEvents(stdin);

  return new Promise<boolean>((resolve) => {
    let done = false;
    const finalize = (shouldCommit: boolean): void => {
      if (done) return;
      done = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      emitter.off('keypress', onPendingKey);
      resolve(shouldCommit);
    };
    const onPendingKey = (_str: string, key?: Key): void => {
      if (!key || done) return;
      // 鼠标报表:吞(与 prompt.ts / onRunningKey 风格一致)
      if (mouse.swallow(key.sequence ?? '')) return;
      // 撤回
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finalize(false);
        return;
      }
      // 确认立即发送:Enter / Return
      if (key.name === 'enter' || key.name === 'return') {
        finalize(true);
        return;
      }
      // 其它任何键 → 撤回。
      // 旧实现把非 Enter 键"忽略"掉:误按 Enter 后人的第一反应是狂敲键盘 / 按空格 / 按退格,
      // 这一串输入被静默丢弃,白白错过补救窗口。撤回窗口期间输入框尚未接管键盘,
      // 这些键本来也不会进输入框,吞掉它们没有任何收益 —— 全部当作撤回信号更有用。
      finalize(false);
    };
    emitter.on('keypress', onPendingKey);
    pendingTimer = setTimeout(() => finalize(true), recallWindowMs(input));
    pendingTimer.unref?.();
  });
}

// ── textOf / queryHistoryFromMessages / renderHistory 已移到 ./message-format.ts ──

/**
 * 交互式 REPL:全屏 TUI(alt screen + 固定底栏)。INPUT 态底栏=状态行+输入框(raw mode 等按键);
 * 提交后 enterRunningMode(底栏改 dim 占位、光标回内容续写位),命令分发与 runAgent 的流式输出经
 * contentWrite 落入内容区(滚动区域内自动滚动,底栏不动)。history 由本模块持有,在轮次间持久;
 * agent 只读取并追加(+ 经 session/ 压缩)。每轮成功结束后自动落盘,退出后可用 --resume / /resume 续接。
 */
export async function startRepl(
  initialHistory?: ChatMessage[],
  sessionId?: string,
  sandboxRootOverride?: string,
  initialQueryHistory?: readonly string[],
): Promise<void> {
  // 模式重置:agentMode 不落盘,每个 REPL 会话从 auto 开始(/resume / --resume 亦重置)。
  setAgentMode('auto');
  // 钉死本会话模型：之后运行中 agent 一律用此值，其它窗口的 /model switch 不会影响本窗口。
  pinSessionModel();
  // 沙箱根:文件操作边界。优先级 --sandbox-root > SANDBOX_ROOT env > process.cwd()。
  // 纯边界记录(不 chdir),jail.ts 内部 resolve。子 agent 同进程继承全局 root。
  setSandboxRoot(sandboxRootOverride ?? config.sandboxRoot ?? process.cwd());
  // MCP 在工具表和 LLM schema 创建前连接；失败的单个 server 只给提示，不阻断 REPL。
  const mcpReport = await initializeAllMcp();
  registerToolsExtension('mcp', getMcpTools());
  refreshChatTools();
  // --resume:读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
  let currentSessionId: string | undefined = sessionId;
  if (!currentSessionId) currentSessionId = newSessionId(); // 新会话立即分配 ID,确保 prompt 里有正确路径
  setCurrentSessionId(currentSessionId, process.cwd()); // 必须在 buildBasePrompt() 之前,让 prompt 能读到 sessionId

  // 构造系统提示:auto 用 base;plan 在 base 后追加按当前开关现拼的 plan suffix。
  // 切模式时 applyMode 重算 history[0](history[0] 恒 system,compaction 保它,不破坏)。
  // 活跃 plan 摘要拼在 memory 段后(systemPrompt 的尾段),todo 工具变更后 listener 重写 history[0]。
  //
  // 与开关联动:① base 用 buildBasePrompt() 取代 config.systemPrompt(后者是启动时一次性
  // 求值的常量,运行时 /memory_switch 不会刷新);② plan suffix 走 getPlanModeSuffix() 现拼;
  // ③ AGENTS.md 存在工作区根时由 base 无条件自动导入正文(超长截断，与 memory 开关无关)；④ Memory Index 按开关注入。
  const buildSystemMessage = (planMode: boolean): string =>
    effectiveSystemPrompt(
      buildBasePrompt(currentSessionId) +
        (planMode ? getPlanModeSuffix() : '') +
        buildMemoryIndexSection(isMemoryEnabled()),
    );
  // 有预加载(--resume)则用它,并把 history[0] 刷成当前 system prompt(config 可能已变);
  // 否则新会话只塞 system 提示(默认 auto)。
  const history: ChatMessage[] =
    initialHistory && initialHistory.length
      ? initialHistory
      : [{ role: 'system', content: buildSystemMessage(false) }];
  // 新 session 使用独立输入历史；旧 session 没有该字段时从 user 消息兼容回填一次。
  let queryHistory: string[] = initialQueryHistory
    ? [...initialQueryHistory]
    : queryHistoryFromMessages(history);
  if (
    initialHistory &&
    initialHistory.length &&
    history[0]?.role === 'system'
  ) {
    history[0] = { role: 'system', content: buildSystemMessage(false) };
  }
  if (sessionId && initialHistory && initialHistory.length) {
    if (!loadSnapshots(sessionId)) rebuildFromHistory(history);
  }
  // 反思 cadence 计数:每 reflectEveryN 轮 fire-and-forget 一次后台反思 pass。
  let turnCount = 0;
  // 本轮 token 累计:runAgent 返回后写入,供底栏模式 chip 右边显示。undefined=无实测
  // (后端不开 include_usage / 后端失败时)。
  let lastTurnUsage: ChatUsage | undefined;

  const banner = () => ({
    model: config.model,
    baseURL: config.baseURL,
    cwd: process.cwd(),
    tools: chatTools.map((tool) => tool.function.name).join(' · '),
    memoryEnabled: isMemoryEnabled(),
  });

  /**
   * 欢迎引导块:新会话开场写在内容区(banner 之下),教用户怎么开始 / 能做什么。
   * 首次提交任何输入(消息或斜杠命令)前由 layout.dismissWelcomeBlock 整块撤掉——
   * 「一打开就能看见,开始干活就消失」。/clear 清空后重新写一次(回到空会话状态)。
   */
  // 欢迎块整块按终端宽度居中:先按纯文本(displayWidth 不剥 ANSI)算左缩进,再套色;
  // 余数列归左,与输入框提示行的居中策略一致;超宽行由 contentWrite 兜底折行。
  const welcomeLines = (): string[] => {
    const cols = layout.getGeo().cols;
    const pad = (plain: string): string => ' '.repeat(Math.max(0, Math.floor((cols - displayWidth(plain)) / 2)));
    const ideNotice = `⚠ ${t('welcome.ideNotice')}`;
    return [
      '',
      `${pad(ideNotice)}${ui.yellow}${ui.bold}${ideNotice}${ui.reset}`,
      '',
      `${pad(t('welcome.gettingStarted'))}${ui.accent}${ui.bold}${t('welcome.gettingStarted')}${ui.reset}`,
      `${pad(`· ${t('welcome.start1')}`)}${ui.dim}· ${t('welcome.start1')}${ui.reset}`,
      `${pad(`· ${t('welcome.start2')}`)}${ui.dim}· ${t('welcome.start2')}${ui.reset}`,
      `${pad(`· ${t('welcome.start3')}`)}${ui.dim}· ${t('welcome.start3')}${ui.reset}`,
      '',
      `${pad(t('welcome.capabilities'))}${ui.accent}${ui.bold}${t('welcome.capabilities')}${ui.reset}`,
      `${pad(`· ${t('welcome.cap1')}`)}${ui.dim}· ${t('welcome.cap1')}${ui.reset}`,
      `${pad(`· ${t('welcome.cap2')}`)}${ui.dim}· ${t('welcome.cap2')}${ui.reset}`,
      `${pad(`· ${t('welcome.cap3')}`)}${ui.dim}· ${t('welcome.cap3')}${ui.reset}`,
      '',
      `${pad(t('welcome.try'))}${ui.dim}${t('welcome.try')}${ui.reset}`,
      '',
    ];
  };

  // 开场:按 config.theme 切主题(横幅 / 状态行 / 后续渲染皆用新色),再进 alt screen + 状态基线 + 清内容区。
  // --resume 有历史则渲染对话,否则横幅。
  setTheme(config.theme);
  layout.enterAltScreen();
  refreshStatusBase(history);
  layout.clearContent();
  layout.contentMode();
  if (history.some((m) => m.role === 'user')) {
    // --resume 锚点:先给一行会话摘要(id/消息数/当前模型),新手对恢复状态有定位感,
    // 再铺历史对话。renderHistory 之后不再追加,锚点恒为恢复内容的第一行。
    const anchorCount = history.filter((m) => m.role !== 'system').length;
    layout.contentWrite(
      `${ui.dim}${t('repl.resumeAnchor', { id: currentSessionId, count: anchorCount, model: config.model })}${ui.reset}\n`,
    );
    renderHistory(history);
    // 强制回尾:同 /resume 命令,renderHistory 展开详情会设 scrollOffset>0,需复位避免闪烁。
    layout.resetScroll();
    layout.repaintViewport();
  } else {
    layout.writeBanner(bannerLines(banner()));
  }
  if (mcpReport.connected.length > 0) {
    layout.contentWrite(`${ui.dim}  ↳ 已连接 MCP: ${mcpReport.connected.join(', ')} (${getMcpTools().length} 个工具;外部工具每次均需授权)${ui.reset}\n`);
  }
  for (const warning of mcpReport.warnings) {
    layout.contentWrite(`${ui.yellow}  ⚠ ${warning}${ui.reset}\n`);
  }
  if (!isModelConfigured()) {
    // 未配置 baseURL/apiKey:醒目提示引导 /model(不退出,REPL 仍可用;发消息会失败但不崩)。
    layout.contentWrite(
      `${ui.yellow}  ⚠ 未配置大模型。输入 ${ui.cyan}/model${ui.yellow} 配置 baseURL / apiKey / model(即时生效),或退出后运行 ${ui.cyan}mocode config${ui.yellow} 走向导。${ui.reset}\n`,
    );
  } else {
    // 老用户兜底:若 ~/.mocode/models/ 空,自动把 ~/.mocode/config 的当前 LLM 四键迁成 'default' 预设。
    // 这样 /model list / switch 立即可见,无需手动 /model 重存一遍。幂等:重启只生效一次。
    if (listPresets().length === 0) {
      try {
        const migrated = migrateCurrentToPreset({
          provider: config.provider,
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          model: config.model,
          contextWindow: config.contextWindowTokens,
          anthropicPromptCache: config.anthropicPromptCache,
        });
        if (migrated) {
          layout.contentWrite(
            `${ui.dim}  ↳ 检测到老配置,已自动迁为预设 “${migrated}”(${ui.cyan}/model list${ui.dim} 查看 · /model switch 切换)${ui.reset}\n`,
          );
        }
      } catch {
        // 迁移失败不阻塞启动;用户后续 /model 时仍能手动配。
      }
    }
  }
  // 新会话开场:banner 之后写欢迎引导块(--resume 有历史时不写,历史本身就是上下文)。
  if (!history.some((m) => m.role === 'user')) {
    layout.writeWelcomeBlock(welcomeLines());
  }
  /**
   * 切换 agent 模式(Shift+Tab 触发,经 prompt.ts 的 onCycleMode 回调)。
   * cycleMode 翻 agentMode + applyMode 重写 history[0] + refreshStatusBase 设状态行 modeTag;
   * 随后 prompt.ts 自调 redraw() 经 paintInput 把 chip 画出来(光标留输入框,不调 drawStatusBar)。
   */
  const applyMode = (planMode: boolean): void => {
    history[0] = { role: 'system', content: buildSystemMessage(planMode) };
  };
  const cycleMode = (): void => {
    const prev = getAgentMode();
    setAgentMode(prev === 'plan' ? 'auto' : 'plan'); // listener 接手 applyMode + refreshStatusBase
    // Shift+Tab 只有 chip 变化,新手可能没感知:内容区补一行确认(与 /plan / /auto 同文案,复用不新造键)。
    layout.contentWrite(`${ui.dim}${t(prev === 'plan' ? 'repl.autoChanged' : 'repl.planChanged')}${ui.reset}\n`);
  };
  // 注册模式变更监听器:switch_mode 工具 / cycleMode / /plan / /auto / runTurn 调 setAgentMode 时同步触发,
  // 重写 history[0] 系统提示(切 plan 追加 PLAN_MODE_SUFFIX)+ 刷状态行 modeTag。
  // 不调 drawStatusBar:INPUT 态靠 prompt.ts redraw 画 chip;RUNNING 态(switch_mode 中途切)靠 200ms turnTimer 兜底。
  onModeChange((m) => {
    applyMode(m === 'plan');
    refreshStatusBase(history);
  });

  /**
   * 回滚子流程(由 /rollback 触发):菜单(↑/↓)选轮次 → 选中第 X 轮 = 删第 X 轮及之后 + 预填第 X 轮 user 输入
   * (Enter 重新跑该轮);被删轮次的文件改动走二选一菜单(promptRevertChoice:
   * 撤销文件 / 只撤销消息)。选轮 + 方式菜单均走 raw mode。预填经 pendingPrefill 注入下轮 INPUT。
   */
  const rollbackFlow = async (): Promise<void> => {
    const turnList = listTurns();
    if (turnList.length < 1) {
      layout.contentWrite(`${ui.dim}(没有可回滚的轮次)${ui.reset}\n`);
      return;
    }
    // 各轮 user 全文(预填用;按 user 消息顺序与 turnList 对齐)
    const userTexts: string[] = [];
    for (const m of history) {
      if (m.role === 'user') userTexts.push(textOf((m as { content?: unknown }).content));
    }
    const items = turnList.map((t) => ({ firstLine: t.firstLine }));
    let picked: number | null;
    try {
      picked = await promptTurnPicker(items);
    } catch {
      return; // Ctrl+C(SIGINT)→ 取消回滚
    }
    if (picked === null) return; // Esc 取消
    // picked(0-based)= 第 (picked+1) 轮:删该轮及之后(planRollback(picked) 保 1..picked),预填该轮 user 输入
    const prefillText = userTexts[picked] ?? '';
    const plan = planRollback(picked, history);
    // 清屏(擦选轮菜单 + /rollback 回显)+ 复位 lastView(dim 空),给文件询问一个干净、resize 安全的画面
    layout.clearContent();
    layout.paintInput({
      prompt: '❯ ',
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
      dim: true,
    });
    const revertPaths = new Set<string>();
    // 文件撤销:二选一菜单(1=撤销文件改动 / 2=只撤销消息保留文件)
    // 返回 true=撤销文件(把 changes 里所有可撤销的路径加入 revertPaths);
    // false/null(取消/非 TTY/Ctrl+C)=只撤销消息,保留文件改动。
    const changes = plan.changes;
    const revertable = changes.filter((c) => c.snapshotAvailable);
    let revertFiles = false;
    if (changes.length > 0) {
      try {
        const choice = await promptRevertChoice(revertable.length);
        revertFiles = choice === true;
      } catch {
        revertFiles = false; // Ctrl+C(SIGINT)→ 保留文件,只撤销消息
      }
    }
    if (revertFiles) {
      for (const c of revertable) revertPaths.add(c.path);
    }
    const rolledBackFromTurnId = getCurrentTurnId();
    const turnCountBeforeRollback = listTurns().length;
    const rollbackResult = applyRollback(plan, history, revertPaths);
    if (!currentSessionId) currentSessionId = newSessionId();
    setCurrentSessionId(currentSessionId, process.cwd()); // 同步到 session/state,确保 notes.md 存在
    appendCurrentSessionRuntimeEvent('rollback', {
      status: 'applied',
      rolledBackFromTurnId,
      cutoffTurnId: plan.cutoffTurnId,
      retainedTurns: plan.n,
      rolledBackTurns: Math.max(0, turnCountBeforeRollback - plan.n),
      deletedMessages: rollbackResult.deletedMsgs,
      revertedFiles: rollbackResult.revertedFiles,
      conflictedFiles: rollbackResult.conflictedFiles,
      requestedFileCount: revertPaths.size,
    }, plan.cutoffTurnId);
    try {
      saveSession(history, currentSessionId, queryHistory);
    } catch {
      // 落盘失败不阻断
    }
    persistSnapshots(currentSessionId);
    // 复显剩余对话(无提示行),输入框预填该轮 user 输入 → 下轮 Enter 重新跑
    layout.clearContent();
    renderHistory(history);
    if (rollbackResult.conflictedFiles.length > 0) {
      layout.contentWrite(
        `${ui.yellow}  ⚠ rollback conflict: ${rollbackResult.conflictedFiles.join(', ')} 已在 Agent 提交后变化，未覆盖。${ui.reset}\n`,
      );
    }
    // 末尾补空行:与后续用户消息(❯ bubble)之间分隔。runTurn 在每个 agent 轮结束后
    // contentWrite('\n') 做轮次分隔,/resume 后接 \n\n,/theme·/model 后接 \n;
    // rollbackFlow 原本漏了这一行,renderHistory 末尾的 batch 摘要行 / assistant 文本
    // 收口后,续写位未稳到新空行,下一次 echoInput 的 ❯ 气泡会黏在最后一条输出后面。
    layout.contentWrite('\n');
    // 回滚后强制回尾:确保 scrollOffset=0，避免后续 showLiveBatch 在冻结视口下
    // 调用 repaintViewport 导致工具信息闪烁/滚动消失（rollback 后用户继续输入触发新 agent
    // 运行时，若 scrollOffset 意外 >0，contentWrite 只喂缓冲不物理写，showLiveBatch 的
    // repaintViewport 画出不含新摘要的冻结窗口 → 工具信息"闪现后消失"）。
    layout.resetScroll();
    pendingPrefill = prefillText.split('\n');
  };

  /**
   * 跑一轮 agent(enterRunningMode 已由调用方完成):startRunningListener → runAgent → autosave / reflect。
   * plan 模式传 planMode=true(runAgent 用 planChatTools 只读子集)。返 ok=正常结束(未中断 / 未抛错),
   * 供调用方决定是否弹审批面板。execute 轮的合成输入也走这里。
   *
   * 多模态:把 pendingAttachments flush 进 userInput:有图时构造 ContentPart[] 数组;
   * 无图时保持 string(向后兼容,且 messageTokens 走 estimateTokens 不走 IMAGE_TOKEN_COST)。
   * side channel 记录本轮 msg 在 history 的 index → attachments,供 renderHistory 复显文件名。
   */
  const runTurn = async (
    input: string,
    planMode: boolean,
    placeholder: string,
  ): Promise<boolean> => {
    const imgs = pendingAttachments;
    pendingAttachments = []; // 入口即清,即使后续抛错也不留陈旧附件
    const userInput: string | ContentPart[] =
      imgs.length === 0
        ? input
        : [
            { type: 'text' as const, text: input },
            // detail 故意不设(留 undefined,JSON.stringify 时被丢弃):OpenAI 认 'auto'/'low'/'high',
            // 但 MiniMax 只认 'low'/'default'/'high'——'auto' 不是合法枚举值,某些后端会 400。
            // 不传 detail 让各 provider 用自己的默认值(OpenAI 默认视为 auto,MiniMax 默认 default),
            // 是唯一在两边都不出错的写法。
            ...imgs.map((a) => ({
              type: 'image_url' as const,
              image_url: { url: a.dataUrl },
            })),
          ];
    const msgIndex = history.length; // runAgent push 后 = 这个 index
    if (imgs.length) messageAttachments.set(msgIndex, imgs);
    let ok = false;
    try {
      const signal = startRunningListener(placeholder);
      // 入口设定本轮初始模式(合成执行轮传 false→auto;用户轮传当前 mode)。
      // setAgentMode 触发 listener 重写 history[0];LLM 可在轮中调 switch_mode 切模式,runAgent 每步读实时值。
      setAgentMode(planMode ? 'plan' : 'auto');
      // 新用户轮开始:清除上一轮 inline skill 的激活态(允许/disallowed 约束一 turn 有效)。
      clearSkillActivation();
      // 运行中每步 chat() 返回后刷新状态行 context 用量条(用 fresh lastUsage / 估算),
      // 否则整轮冻结在轮首 refreshStatusBase 的值,「执行 grep」时 2k/1000k 不动。
      const result = await runAgent(
        history,
        userInput,
        signal,
        () => {
          refreshStatusBase(history);
          layout.drawStatusBar();
        },
      );
      // 本轮 token 累计(底栏模式 chip 右边显示)。undefined = 后端不开 include_usage。
      // 状态栏统一在 finally 刷新，确保正常、中断、异常都经过同一 plan 收尾路径。
      lastTurnUsage = result.usage;
      ok = !signal.aborted; // 中断(Ctrl+C)→ runAgent 已还原 history,ok=false 不弹审批
      // 成功轮次自动落盘(崩溃也保住上一轮);新会话首轮分配 id
      if (!currentSessionId) currentSessionId = newSessionId();
      setCurrentSessionId(currentSessionId, process.cwd()); // 同步到 session/state,确保 notes.md 存在
      try {
        saveSession(history, currentSessionId, queryHistory);
      } catch {
        // 落盘失败不阻断 REPL
      }
      persistSnapshots(currentSessionId); // 随会话落盘回滚快照(/resume 后仍可撤销)
      // 后台反思:每 reflectEveryN 轮 fire-and-forget 一次(与下一轮 agent 并发,不阻塞)。
      // 已有在飞任务 / autoReflect 关 → kickoff 内部自守卫。快照同步取(避免下一轮 mutate history 竞态)。
      turnCount++;
      if (turnCount % config.reflectEveryN === 0) {
        kickoffReflection(snapshotTranscript(history, 20));
      }
    } catch (e) {
      ok = false;
      // 请求失败也保存已确认提交的 query，确保立即退出后仍可通过 ↑ 或 resume 找回。
      if (!currentSessionId) currentSessionId = newSessionId();
      setCurrentSessionId(currentSessionId, process.cwd());
      try {
        saveSession(history, currentSessionId, queryHistory);
      } catch {
        // 落盘失败不覆盖原始请求错误
      }
      // 多模态相关错误友好提示:OpenAI/Anthropic 等会报 "does not support image" / "vision" / "multimodal" 等关键词,
      // 直接给原文对中文用户不友好。这里翻译成中文 + 提示 /model 换视觉模型。
      const msg = e instanceof Error ? e.message : String(e);
      const lower = msg.toLowerCase();
      // 只有明确的「能力不支持」才显示换模型提示。不能仅因错误里出现 image/vision
      // 就下结论:例如 MiniMax 会因 `image_url.detail=auto` 返 400 invalid params，
      // 模型本身仍支持视觉。参数/格式错误应保留原始 provider 诊断，方便准确修复。
      const isImageParameterError =
        /\b(?:invalid|unsupported)\s+(?:image\s+)?(?:detail|parameter|param|format|url)\b/i.test(lower);
      const isVisionUnsupportedError = !isImageParameterError && (
        /\b(?:does not support|doesn't support|not supported|unsupported)\b.{0,48}\b(?:image|vision|multimodal|media)\b/i.test(lower) ||
        /\b(?:image|vision|multimodal|media)\b.{0,48}\b(?:is not supported|not supported|unsupported)\b/i.test(lower) ||
        /(?:不支持|不具备).{0,12}(?:视觉|图片|图像|多模态)|(?:视觉|图片|图像|多模态).{0,12}(?:不支持|不可用)/.test(msg)
      );
      if (isVisionUnsupportedError) {
        layout.contentWrite(
          `${ui.red}${t('repl.errorLabel')}${ui.reset} ${t('repl.visionUnsupported', { model: `${ui.accent}${config.model}${ui.reset}` })}${ui.dim}${t('repl.originalError', { message: msg })}${ui.reset}\n`
        );
        layout.contentWrite(
          `${ui.dim}${t('repl.visionHint')}${ui.reset}\n`
        );
      } else {
        // 常见错误翻译:认证 / 限流 / 超时 / 网络 / 上下文超长 → 中文引导(新手第一堵墙);
        // 认不出的错误保留原始 provider 诊断,不瞎猜。
        const kind = classifyChatError(msg);
        if (kind) {
          const key = LLM_ERROR_HINT_KEYS[kind];
          layout.contentWrite(
            `${ui.red}${t('repl.errorLabel')}${ui.reset} ${t(key, { base: config.baseURL, model: config.model })}\n`,
          );
          layout.contentWrite(`${ui.dim}${t('repl.originalError', { message: msg })}${ui.reset}\n`);
        } else {
          layout.contentWrite(`${ui.red}${t('repl.errorLabel')}${ui.reset} ${msg}\n`);
        }
      }
    } finally {
      stopRunningListener();
      // 纯 plan 轮正常结束后仍需等待审批/细化，继续展示；其余终态统一结算。
      // 结算只隐藏当前 fingerprint，不修改 notes；后续内容或 mtime 变化会自动重新显示。
      const waitingForPlanApproval = ok && planMode && getAgentMode() === 'plan';
      if (!waitingForPlanApproval) settlePlanStatus();
      layout.setLiveUsage(undefined); // 轮末清实时 chip,回 INPUT 态不再显示
      refreshStatusBase(history, lastTurnUsage);
      layout.drawStatusBar();
    }
    layout.contentWrite('\n'); // 轮次之间空行
    return ok;
  };

  /** 把 picker 选中的会话加载进 REPL(刷 history + 重建 snapshots + 重画)。/resume / /sessions 共用。 */
  async function resumeFromPick(pick: SessionPickerItem | null): Promise<void> {
    if (!pick) return; // Esc / Ctrl+D 取消
    const loaded = loadSession(pick.id);
    if (!loaded || !loaded.history.length) {
      layout.contentWrite(`${ui.yellow}${t('repl.loadFailed')}${ui.reset}\n`);
      return;
    }
    // Bind before rebuilding the prompt, or it can retain the previous session's notes path.
    currentSessionId = loaded.id;
    setCurrentSessionId(loaded.id, process.cwd());
    if (loaded.history[0]?.role === 'system') {
      loaded.history[0] = { role: 'system', content: buildSystemMessage(false) };
    }
    history.length = 0;
    history.push(...loaded.history);
    queryHistory = loaded.queryHistory
      ? [...loaded.queryHistory]
      : queryHistoryFromMessages(loaded.history);
    setAgentMode('auto'); // 续接重置为 auto(mode 不落盘;listener 重写 history[0] 回 auto,与 loaded 幂等)
    // 读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
    if (!loadSnapshots(loaded.id)) rebuildFromHistory(history);
    contextState.lastUsage = undefined;
    contextState.lifecycleStats = undefined;
    contextState.ephemeralText = undefined;
    lastTurnUsage = undefined; // 续接:旧会话的 token 累计已无意义,清空等下轮覆写
    layout.clearContent();
    // 锚点行:会话 id / 消息数 / 当前模型,给续接的会话一个定位起点(与 --resume 启动路径同文案)。
    const anchorCount = history.filter((m) => m.role !== 'system').length;
    layout.contentWrite(
      `${ui.dim}${t('repl.resumeAnchor', { id: loaded.id, count: anchorCount, model: config.model })}${ui.reset}\n\n`,
    );
    renderHistory(history);
    // 强制回尾:renderHistory 展开 mutation 工具详情会经 contentInsertAfter 设置 scrollOffset>0;
    // 先把"已续接会话"提示写入缓冲，再统一回尾重画，避免切换后视口停留在历史顶部。
    layout.resetScroll();
    layout.repaintViewport();
  }

  let hasSubmittedInput = false;
  while (true) {
    // INPUT 态:画底栏输入框 + 状态行,光标入输入框
    refreshStatusBase(history);
    // 后台反思若已完成(上轮 fire-and-forget),在安全点 flush 一行 dim 摘要:
    // 不在 RUNNING 态写——防与正在跑的 agent 争屏(contentWrite / 状态行)。
    const reflectRes = getLastReflectResult();
    if (reflectRes) {
      layout.contentWrite(`  ${ui.gray}↳ ${formatReflectResult(reflectRes)}${ui.reset}\n`);
      clearLastReflectResult();
    }
    // 所有斜杠命令和 Agent 轮次共用同一个输出→输入边界，避免某条命令漏写第二个 \n
    // 后下一条 ❯ 气泡紧贴确认文案；已有多余空行也会收敛为恰好一行。
    if (hasSubmittedInput) layout.normalizeInputBoundary();
    layout.enterInputMode(t('repl.idle'));

    let input: string[] | null = null;
    try {
      input = await promptWithSlashMenu({
        prompt: PROMPT,
        commands: buildSlashCommands(),
        onCycleMode: cycleMode,
        // Ctrl+R / Ctrl+P 历史搜索候选源:惰性工厂——当前会话内存 queryHistory + 最近落盘会话,
        // 聚合要读盘,只有面板真正打开(Ctrl+R/P)才求值,平常轮次零开销
        history: () => collectQueryHistory(queryHistory).map((e) => e.text),
        // /rollback 预填优先;否则上一轮运行中 typeahead 打的字 → 预填进输入框,用户可改可发
        ...(pendingPrefill
          ? { initialLines: pendingPrefill }
          : getRunningInput()
            ? { initialLines: [getRunningInput()] }
            : {}),
      });
    } catch {
      break; // Ctrl+C(SIGINT)/ 异常 → 退出
    }
    pendingPrefill = null; // 预填已消费,清空
    clearRunningInput(); // 预填已消费,清空(下轮运行态从空开始)
    if (input === null) break; // 空 prompt Ctrl+D

    let joined = input.join('\n');
    const line = joined.trim();
    if (!line) continue;
    hasSubmittedInput = true;
    if (line === '/exit' || line === '/quit') break;

    // 首次提交任何输入(消息或斜杠命令)→ 撤掉欢迎引导块,不让它出现在工作画面里。
    layout.dismissWelcomeBlock();

    // RUNNING 态:回显输入 → 底栏改 dim 占位、光标回内容续写位
    const cmd = line.split(/\s+/)[0];
    // 命令被刻意改写成别的内容后转发给 agent(如 /init)。这类不算"未知命令"。
    let forwardToAgent = false;
    // 语言命令把视觉分隔放在确认文案之后；避免回显后先空一行、下一条命令却紧贴确认。
    echoInput(input, cmd !== '/language');
    const state = runningStateFor(cmd);
    const placeholder = state.placeholder;
    refreshStatusBase(history);
    layout.enterRunningMode(state.status, placeholder);

    // ── 斜杠命令分发(repl/commands/)──
    // 迁移期间:已搬到 commands/ 的命令由 dispatchCommand 处理并返回结果;
    // 未搬的返回 unhandled,直接落到下面的遗留 if 链——两条路径语义一致。
    // 全部搬完后,遗留 if 链整块删除,unhandled 即等价于"未知命令"。
    {
      const outcome = await dispatchCommand({
        line,
        cmd,
        inputLines: input,
        history,
        contextState,
        // 访问器暴露闭包 `let`:命令会写它们(/clear 换 session id、/resume 换整个会话),传值会丢写回。
        state: {
          get currentSessionId() {
            return currentSessionId;
          },
          set currentSessionId(v) {
            currentSessionId = v;
          },
          get lastTurnUsage() {
            return lastTurnUsage;
          },
          set lastTurnUsage(v) {
            lastTurnUsage = v;
          },
          get turnCount() {
            return turnCount;
          },
          set turnCount(v) {
            turnCount = v;
          },
          get queryHistory() {
            return queryHistory;
          },
          set queryHistory(v) {
            queryHistory = v;
          },
        },
        attachments: {
          list: () => pendingAttachments,
          clear: () => {
            pendingAttachments = [];
          },
          push: (att) => {
            pendingAttachments.push(att);
          },
        },
        buildSystemMessage,
        banner,
        welcomeLines,
        refreshStatusBase,
        applyMode,
        cycleMode,
        runTurn,
        resumeFromPick,
        rollbackFlow,
      });
      switch (outcome.kind) {
        case 'next':
          continue;
        case 'exit':
          break;
        case 'forward':
          // 改写输入后当普通消息发给 agent(/init)。不 continue:fall through 到发送路径。
          joined = outcome.input;
          forwardToAgent = true; // 不是"没匹配上",别被下方未知命令兜底拦掉
          break;
        case 'unhandled':
          break; // 遗留 if 链接手
      }
      // switch 的 break 只跳出 switch;'exit' 需要跳出 while,用显式二次判断。
      if (outcome.kind === 'exit') break;
    }

    // /help /language /init /upgrade 已搬到 repl/commands/system.ts
    // /plan /auto /mode /pet quit /pet skin /pet 已搬到 repl/commands/{mode,pet}.ts
    // /clear /sessions /resume /rollback 已搬到 repl/commands/session.ts
    // /image(list/clear/<path>)已搬到 repl/commands/image.ts;/context 搬到 repl/commands/context.ts
    // /memory /reflect 已搬到 repl/commands/memory.ts;/skills /skill 搬到 repl/commands/skill.ts
    // /compact 已搬到 repl/commands/compact.ts

    // /sessions /resume 已搬到 repl/commands/session.ts
    // /theme 已搬到 repl/commands/appearance.ts
    if (line === '/model' || line.startsWith('/model ')) {
      // /model:运行时配置大模型(baseURL/apiKey/model/contextWindowTokens)。
      // 即时生效(updateModelConfig 改内存 + env,reconfigureClient 重建 OpenAI 实例)+ 持久化(writeConfigKeys 写 ~/.mocode/config)。
      // 仿 /theme:promptIntervention 弹菜单/输入 → 改 config → refreshStatusBase 刷底栏 → clearContent+banner 重显横幅 → dim 警告(shell env 覆盖)。
      const arg = line.startsWith('/model ') ? line.slice('/model '.length).trim() : '';

      // ── /model 子命令(use/save/list/delete/rename)优先派发,免得被无参向导路径吞掉。

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
        refreshStatusBase(history);
        layout.clearContent();
        if (history.some((m) => m.role === 'user')) {
          renderHistory(history);
        } else {
          layout.writeBanner(bannerLines(banner()));
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

      // 决定自动存的预设名:协议、缓存配置和连接四元组都一致时不重复存。
      const uniquePresetName = (
        desired: string,
        provider: 'openai' | 'anthropic',
        baseURL: string,
        apiKey: string,
        model: string,
        contextWindow: number,
        anthropicPromptCache: boolean,
      ): string | null => {
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
      };

      // /model switch:弹 ↑↓·Enter 菜单挑预设切换。无预设时给一行引导。
      if (arg === 'switch') {
        const presets = listPresets();
        if (presets.length === 0) {
          layout.contentWrite(`${ui.dim}(还没有预设;先跑 /model 添加一个)${ui.reset}\n`);
          continue;
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
        continue;
      }

      // /model list:列已配置的预设(★ 标当前);无预设给一行引导。
      // /model presets 是同义别名(老用户习惯)。
      if (arg === 'list' || arg === 'presets') {
        const ps = listPresets();
        if (ps.length === 0) {
          layout.contentWrite(`${ui.dim}(还没有预设;先跑 /model 添加一个)${ui.reset}\n`);
          continue;
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
        continue;
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
        continue;
      }


      // /model use <name>:一键把预设应用到 config + 持久化 + 重建 client。
      if (arg.startsWith('use ')) {
        const name = arg.slice(4).trim();
        if (!name) {
          layout.contentWrite(`${ui.yellow}用法: /model use <name>${ui.reset}\n`);
          continue;
        }
        if (!isValidPresetName(name)) {
          layout.contentWrite(`${ui.yellow}非法名字: ${name}(仅允许 [a-zA-Z0-9_-]{1,32})${ui.reset}\n`);
          continue;
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
          continue;
        }
        applyPresetAndPersist(preset);
        continue;
      }

      // /model delete <name>:删一个预设。无参 / 重名 / 非法名字分别给不同提示。
      if (arg.startsWith('delete ')) {
        const name = arg.slice(7).trim();
        if (!name) {
          layout.contentWrite(`${ui.yellow}用法: /model delete <name>${ui.reset}\n`);
          continue;
        }
        if (!isValidPresetName(name)) {
          layout.contentWrite(`${ui.yellow}非法名字: ${name}(仅允许 [a-zA-Z0-9_-]{1,32})${ui.reset}\n`);
          continue;
        }
        if (deletePreset(name)) {
          layout.contentWrite(`${ui.dim}已删除预设 “${name}”${ui.reset}\n`);
        } else {
          layout.contentWrite(`${ui.yellow}没有预设 “${name}”${ui.reset}\n`);
        }
        continue;
      }

      // /model 后跟了未知子命令 → 给一行简短用法提示,免得静默吞用户输入。
      // arg === '' → 直接进向导(下方 4 步链);这里只兜底非法子命令。
      if (arg !== '') {
        layout.contentWrite(
          `${ui.yellow}未知子命令: ${arg}${ui.reset}\n` +
            `${ui.dim}用法: /model(配置新模型向导) · /model switch · /model list · /model delete <name>${ui.reset}\n`,
        );
        continue;
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
        if (res.action === 'cancelled') { continue; }
        const idx = MODEL_PRESETS.findIndex((p) => p.label === res.value);
        if (idx === -1) { continue; }
        preset = MODEL_PRESETS[idx];
      } catch {
        continue; // Ctrl+C
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
          if (res.action === 'cancelled') { continue; }
          if (res.action === 'selected' && res.value === '直接应用') {
            quickApply = true;
          }
          // 其余(逐项修改 / 自定义输入 submitted)→ quickApply 保持 false,走下方逐项链
        } catch {
          continue; // Ctrl+C
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
          if (res.action === 'cancelled') { continue; }
          baseURL = (res.value ?? '').trim() || preset.baseURL || config.baseURL;
        }
        if (!baseURL) {
          layout.contentWrite(`${ui.yellow}baseURL 不能为空,已取消。${ui.reset}\n`);
          continue;
        }

        // apiKey(不预填明文:回车=保留旧值,输入新值=覆盖)
        {
          const res = await promptIntervention({
            type: 'input',
            title: 'LLM_API_KEY',
            detail: `回车保留当前 ${maskKey(config.apiKey)};输入新值则覆盖。`,
            seed: '',
          });
          if (res.action === 'cancelled') { continue; }
          const v = (res.value ?? '').trim();
          apiKey = v || config.apiKey;
        }
        if (!apiKey) {
          layout.contentWrite(`${ui.yellow}apiKey 不能为空,已取消。${ui.reset}\n`);
          continue;
        }

        // model
        {
          const res = await promptIntervention({
            type: 'input',
            title: 'LLM_MODEL',
            detail: '模型名(须支持 function calling)。回车采纳预填值。',
            seed: preset.model || config.model,
          });
          if (res.action === 'cancelled') { continue; }
          model = (res.value ?? '').trim() || preset.model || config.model;
        }
        if (!model) {
          layout.contentWrite(`${ui.yellow}model 不能为空,已取消。${ui.reset}\n`);
          continue;
        }

        // contextWindowTokens
        {
          const res = await promptIntervention({
            type: 'input',
            title: 'CONTEXT_WINDOW_TOKENS',
            detail: '模型上下文窗口，全局默认 256k；如需不同窗口可手动覆盖。回车采纳预填值。',
            seed: String(preset.window || config.contextWindowTokens),
          });
          if (res.action === 'cancelled') { continue; }
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
      refreshStatusBase(history);
      layout.clearContent();
      if (history.some((m) => m.role === 'user')) {
        renderHistory(history);
      } else {
        layout.writeBanner(bannerLines(banner()));
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
          `${ui.dim}(shell 环境变量已设 ${config.llmKeysFromShell.join(' / ')},文件写入下次启动被其覆盖;取消该 shell 设置后生效)${ui.reset}\n`
        );
      }
      continue;
    }

    // /rollback 已搬到 repl/commands/session.ts

    // /subagent /fe /frontend /mcp /memory_switch /memory_status 已搬到 repl/commands/tool-group.ts

    // 未知斜杠命令兜底:命令分派是一串独立的 if(…){ …continue },没有 else,
    // 拼错的 /hepl 会一路走到这里被当成普通 prompt 送给模型——白烧一轮还拿不到任何提示。
    // 只拦「长得像命令」的输入:单个前导 / + 词字符。像 /tmp/foo/bar、/src/index.ts:12:5 这类
    // 路径(在编码 agent 里很常见,且同样以 / 开头)必须放行,不能当成拼错的命令。
    if (isCommandShape(cmd) && !forwardToAgent) {
      const suggestion = suggestCommand(cmd);
      layout.contentWrite(`${ui.yellow}${t('repl.unknownCommand', { value: cmd })}${ui.reset}\n`);
      if (suggestion) {
        layout.contentWrite(`${ui.dim}${t('repl.didYouMean', { value: suggestion })}${ui.reset}\n`);
      }
      layout.contentWrite(`${ui.dim}${t('repl.unknownCommandHint')}${ui.reset}\n`);
      continue; // 与其他命令一致:回 INPUT 态由循环顶部的 normalizeInputBoundary + enterInputMode 负责
    }

    const bubbleRows = input.length + 2 + pendingAttachments.length; // N 行 message + 2 行尾随空(含 \n\n 留下的 open current 行) + 每附件 1 行
    const shouldCommit = await awaitPendingRecall(input);
    if (!shouldCommit) {
      // 撤回:气泡从内容区擦掉 + 行放回输入框(下轮 promptWithSlashMenu 经 initialLines 消费)+ 切回 INPUT 视觉。
      // pendingAttachments **保留** —— 撤回的是输入文本不是意图,再发时随消息一起带走
      // (runTurn 入口的 pendingAttachments.flush 仍按现有逻辑把附件塞进 userInput)。
      layout.rewindContent(bubbleRows);
      pendingPrefill = input;
      layout.enterInputMode(t('repl.idle'));
      continue;
    }
    // 只记录已过撤回窗口的真实用户 query；slash 命令和合成执行轮不会走到这里。
    queryHistory.push(joined);
    const initialPlan = getAgentMode() === 'plan'; // 轮首模式(在 runTurn 之前读)
    const ok = await runTurn(joined, initialPlan, placeholder);
    // plan 轮正常结束(未中断 / 未抛错)→ 看轮末模式决定:
    //  - 仍 plan:模型只产计划就 STOP(模型已无 switch_mode 工具)→ 弹审批面板(原行为)。
    //  - 已 auto:本轮被切到 auto 模式(用户用 /auto 触发的合成执行轮)→ 跳过审批,不重复打扰。
    if (initialPlan && ok && getAgentMode() === 'plan') {
      // 桌宠:计划审批面板弹出期间广播 waiting_human(红灯闪烁);面板不在 runAgent/hooks 体系内,
      // 需在此单独广播——用户响应后由下一次 /pet 状态事件(或 idle 兜底)覆盖。
      sendState('waiting_human');
      const executePlanOption = t('plan.execute');
      const res = await promptIntervention({
        type: 'choice',
        title: t('plan.ready'),
        detail: t('plan.approvalDetail'),
        options: [executePlanOption, t('plan.refine')],
      });
      sendState('idle');
      if (res.action === 'selected' && res.value === executePlanOption) {
        // setAgentMode('auto') 由 runTurn 入口做(listener 重写 history[0] 回 auto);这里只切运行态 + 合成执行轮。
        layout.enterRunningMode(t('plan.running'), t('plan.executing'));
        await runTurn(t('plan.executePrompt'), false, t('plan.executing'));
      }
    }
  }

  // 退出前等在飞反思收尾(Ctrl+C 走 SIGINT 直退不等;fire-and-forget 不承诺中断时完成)。
  await drainMemoryBackground();
  await closeAllMcp();
  layout.exitAltScreen();
}
