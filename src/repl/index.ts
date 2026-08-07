import readline from 'node:readline/promises';
import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin, stdout } from 'node:process';
import {
  config,
  updateModelConfig,
  isModelConfigured,
  updateMemoryConfig,
  isMemoryEnabled,
  isSubAgentEnabled,
  updateSubAgentConfig,
  isFrontendToolsEnabled,
  updateFrontendToolsConfig,
  updateLanguageConfig,
  languageFromShell,
  buildBasePrompt,
  getPlanModeSuffix,
  hasCodegraphIndex,
  reinjectActivePlanIntoSystem,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from '../config/index.js';
import {
  getLanguage,
  normalizeLanguage,
  t,
  type TranslationKey,
} from '../i18n/index.js';
import { DEFAULT_BUDGET_POLICY } from '../context/budget.js';
import { updateConfigKey, writeConfigKeys, CONFIG_PATH } from '../config/file.js';
import {
  deletePreset,
  getPreset,
  isValidPresetName,
  listPresets,
  migrateCurrentToPreset,
  savePreset,
} from '../config/presets.js';
import { runAgent } from '../agent/index.js';
import { getAgentMode, setAgentMode, onModeChange } from '../agent/mode.js';
import { togglePet, killPetProcess, listSkins, setSkin, sendState } from '../pet/bridge.js';
import { setSandboxRoot } from '../sandbox/root.js';
import { ui, setTheme, getTheme, listThemes, themeExists, applyTerminalBackground } from '../ui/theme.js';
import { bannerString, bannerLines, displayWidth, padEndDisplay, summarizeToolCall, summarizeToolResult } from '../ui/render.js';
import * as layout from '../ui/layout.js';
import * as mouse from '../ui/mouse.js';
import * as batch from '../ui/batch.js';
import {
  promptWithSlashMenu,
  promptTurnPicker,
  promptSessionPicker,
  promptThemePicker,
  promptRevertChoice,
  type SessionPickerItem,
  type SlashCommand,
} from '../ui/prompt.js';
import { promptIntervention } from '../ui/intervention.js';
import { registerToolsExtension } from '../tools/registry.js';
import { initializeAllMcp, getMcpTools, closeAllMcp } from '../mcp/index.js';
import {
  estimateMessagesTokens,
  reconfigureClient,
  refreshChatTools,
  chatTools,
  type ChatMessage,
  type ChatUsage,
} from '../llm/index.js';
import {
  loadImageAttachment,
  renderChip,
  MAX_INLINE_BYTES_DEFAULT,
  type ImageAttachment,
} from '../attachments/image.js';
import { modelSupportsVision } from '../llm/capabilities.js';
import { computePruneStats } from '../context/relevance.js';
import { formatArtifactTokenSources } from '../context/artifacts.js';
import type { ContentPart } from '../agent/core.js';
import {
  manualCompact,
  contextState,
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  appendCurrentSessionRuntimeEvent,
  hashTraceValue,
} from '../session/index.js';
import {
  listTurns,
  planRollback,
  applyRollback,
  persistSnapshots,
  loadSnapshots,
  rebuildFromHistory,
  resetState,
  getCurrentTurnId,
} from '../rollback/index.js';
import {
  listSkills,
  effectiveSystemPrompt,
} from '../skills/index.js';
import {
  buildMemoryIndexSection,
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
  loadAll,
} from '../memory/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';

import { setCurrentSessionId, getCurrentSessionId } from '../session/state.js';
import {
  checkVersion,
  fetchLatestVersion,
  getCurrentVersion,
  runUpgradeForeground,
} from '../commands/upgrade.js';

/**
 * readline 的 prompt 必须是纯文本(无 ANSI):readline 按字符数算光标位置,
 * 颜色码会让光标错位、编辑时漂移。颜色只用在直接 stdout.write 的横幅 / 工具行 / 回复。
 */
const PROMPT = '❯ ';

/**
 * 斜杠命令树(仅用于输入菜单；分发仍走下方 if 链)。
 * 分支节点只负责导航，叶子的 value 保持现有命令文本，因此不破坏命令兼容性。
 */
function buildSlashCommands(): SlashCommand[] {
  const d = (key: TranslationKey): string => t(key);
  return [
    { name: '/help', desc: d('commands.help') },
    { name: '/exit', desc: d('commands.exit') },
    { name: '/clear', desc: d('commands.clear') },
    { name: '/context', desc: d('commands.context') },
    { name: '/skills', desc: d('commands.skills') },
    { name: '/compact', desc: d('commands.compact') },
    { name: '/resume', desc: d('commands.sessionResume') },
    { name: '/sessions', desc: d('commands.sessionBrowse') },
    { name: '/rollback', desc: d('commands.sessionRollback') },
    {
      name: '/memory', desc: d('commands.memory'), children: [
        { name: 'overview', value: '/memory', desc: d('commands.memoryOverview') },
        { name: 'toggle', value: '/memory_switch', desc: d('commands.memoryToggle') },
        { name: 'on', value: '/memory_switch on', desc: d('commands.memoryOn') },
        { name: 'off', value: '/memory_switch off', desc: d('commands.memoryOff') },
        { name: 'status', value: '/memory_status', desc: d('commands.memoryStatus') },
        { name: 'reflect', value: '/reflect', desc: d('commands.memoryReflect') },
        { name: 'init', value: '/init', desc: d('commands.memoryInit') },
      ],
    },
    {
      name: '/subagent', desc: d('commands.subagent'), children: [
        { name: 'on', value: '/subagent on', desc: d('commands.subagentOn') },
        { name: 'off', value: '/subagent off', desc: d('commands.subagentOff') },
        { name: 'status', value: '/subagent status', desc: d('commands.subagentStatus') },
      ],
    },
    {
      name: '/fe', desc: d('commands.fe'), children: [
        { name: 'on', value: '/fe on', desc: d('commands.feOn') },
        { name: 'off', value: '/fe off', desc: d('commands.feOff') },
        { name: 'status', value: '/fe status', desc: d('commands.feStatus') },
      ],
    },
    { name: '/theme', desc: d('commands.theme') },
    {
      name: '/model', desc: d('commands.model'), children: [
        { name: 'configure', value: '/model', desc: d('commands.modelConfigure') },
        { name: 'switch', value: '/model switch', desc: d('commands.modelSwitch') },
        { name: 'list', value: '/model list', desc: d('commands.modelList') },
        { name: 'show', value: '/model show', desc: d('commands.modelShow') },
        { name: 'use <name>', value: '/model use ', submit: false, desc: d('commands.modelUse') },
        { name: 'delete <name>', value: '/model delete ', submit: false, desc: d('commands.modelDelete') },
      ],
    },
    {
      name: '/mode', desc: d('commands.mode'), children: [
        { name: 'plan', value: '/plan', desc: d('commands.modePlan') },
        { name: 'auto', value: '/auto', desc: d('commands.modeAuto') },
      ],
    },
    {
      name: '/pet', desc: d('commands.pet'), children: [
        { name: 'toggle', value: '/pet', desc: d('commands.petToggle') },
        { name: 'skin', value: '/pet skin', desc: d('commands.petSkin') },
        { name: 'quit', value: '/pet quit', desc: d('commands.petQuit') },
      ],
    },
    {
      name: '/image', desc: d('commands.image'), children: [
        { name: 'attach <path>', value: '/image ', submit: false, desc: d('commands.imageAttach') },
        { name: 'list', value: '/image list', desc: d('commands.imageList') },
        { name: 'clear', value: '/image clear', desc: d('commands.imageClear') },
      ],
    },
    {
      name: '/language', desc: d('commands.language'), children: [
        { name: 'zh-CN', value: '/language zh-CN', desc: d('commands.languageZh') },
        { name: 'en', value: '/language en', desc: d('commands.languageEn') },
      ],
    },
    {
      name: '/upgrade', desc: d('commands.upgrade'), children: [
        { name: 'now', value: '/upgrade', desc: d('commands.upgradeNow') },
        { name: 'check', value: '/upgrade check', desc: d('commands.upgradeCheck') },
        { name: 'status', value: '/upgrade status', desc: d('commands.upgradeStatus') },
      ],
    },
  ];
}

/** 从菜单树递归生成 /help 内容；叶子 value 与菜单路径不同则同时展示真实命令。 */
function slashHelpLines(
  nodes: SlashCommand[] = buildSlashCommands(),
  parentPath = '',
  depth = 0,
): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const menuPath = parentPath ? `${parentPath} ${node.name}` : node.name;
    const isBranch = Boolean(node.children?.length);
    const actual = node.value?.trimEnd();
    const mapping = actual && actual !== menuPath ? ` ${ui.dim}→ ${actual}${ui.reset}` : '';
    const marker = isBranch ? ` ${ui.dim}›${ui.reset}` : '';
    lines.push(
      `${'  '.repeat(depth)}${ui.accent}${menuPath}${ui.reset}${marker}${mapping}  ${ui.dim}${node.desc}${ui.reset}`,
    );
    if (node.children?.length) lines.push(...slashHelpLines(node.children, menuPath, depth + 1));
  }
  return lines;
}

/** 主题名 → 本地化描述。 */
function themeDescription(name: string): string {
  const key = `theme.${name}` as TranslationKey;
  return name in {
    default: 1, light: 1, solarized: 1, gruvbox: 1, nord: 1, orange: 1,
    rose: 1, emerald: 1, amber: 1, lavender: 1, sunset: 1,
  } ? t(key) : '';
}

/** /model 预设后端:选一个预填 baseURL,仍可逐项改。base_url 取自 README 常见表。 */
const MODEL_PRESETS: { label: string; baseURL: string; model: string; window: number }[] = [
  { label: 'GLM(智谱)', baseURL: 'https://open.bigmodel.cn/api/v3', model: 'glm-4.6', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
  { label: 'Qwen(阿里)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
  // MiniMax OpenAI 兼容端点(https://platform.minimax.io/docs/api-reference/text-openai-api)。
  // MiniMax-M3 为唯一支持图片/视频输入的模型;M2 系列纯文本(见 llm/capabilities.ts KNOWN_TEXT_ONLY_PREFIXES)。
  { label: 'MiniMax', baseURL: 'https://api.minimax.io/v1', model: 'MiniMax-M3', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
  { label: '本地 Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
  { label: '本地 vLLM', baseURL: 'http://localhost:8000/v1', model: 'default', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
  { label: '自定义 base_url', baseURL: '', model: '', window: DEFAULT_CONTEXT_WINDOW_TOKENS },
];

/** apiKey 脱敏:只露末 4 位,前面打星号(显示用,绝不把明文 key 写进内容区)。 */
function maskKey(k: string): string {
  if (!k) return '(未设置)';
  if (k.length <= 8) return '****';
  return `${'='.repeat(Math.min(k.length - 4, 20))}${k.slice(-4)}`;
}

/**
 * /init 指令:发给 agent 扫描项目并生成 MOCODE.md。已存在则让 agent 读后更新(不丢失事实)。写完供 memory 子系统下轮加载。
 *
 * 函数化(非 const):.codegraph/ 索引是否存在的探测放在调用瞬间,没索引时不提 codegraph,
 * 避免 LLM 调出失败。/init 是冷启动动作,IO 开销可忽略。
 */
function buildInitPrompt(): string {
  const cg = hasCodegraphIndex()
    ? '- 若有 .codegraph/:用 use_skill 加载 codegraph skill 后用 run_command 调 codegraph explore "<架构或入口符号>" 一次拿相关源码+调用路径,别逐文件读！！！\n'
    : '';
  return `分析当前项目(process.cwd()),生成 MOCODE.md 项目记忆文件,供 mocode 后续会话自动加载——目标是让后续会话无需重新摸索就能上手。

先探查(尽量少调用拿全貌):
${cg}- read_file package.json(或 Cargo.toml/pyproject.toml/go.mod 等):scripts、依赖、入口、模块类型。
- glob 顶层目录;read_file 入口文件 + 各子系统 index.ts/README。
- 若 MOCODE.md 已存在:read_file 读它,在其基础上更新(补缺、修正过时),不丢已有准确事实。

MOCODE.md 按以下结构写(每节简短,只写稳定、非显然的事实):
## 项目
一两句:是什么、技术栈、运行环境。
## 命令
install / dev / build / test / typecheck / lint 等——从 package.json scripts 提炼,写原样命令行(如 \`npm run typecheck\`);没有的注明"无测试"/"无 lint"。
## 目录结构
顶层各目录与子系统职责,一句话/个;不逐文件列。
## 约定
从代码与现有文档提炼的硬约定:模块系统(ESM?)、命名、错误处理、工具/函数契约、易踩坑点。只写非显然、会让人踩坑的;不写"保持简洁"这种正确废话。
## 扩展点
加工具/命令/provider/模块的接缝(改哪个文件、加在哪)。

硬要求:
- 从实际代码提炼,引用具体文件名/命令/符号;不编造、不泛泛。
- 总长 ≤ 3000 字;只写后续会话有用的稳定事实,不写易变项(当前 bug、临时文件、未决 TODO)。
- 用 write_file 写入项目根 MOCODE.md。
- 写完简述:写了哪几节 + 从代码里发现的 2-3 条非显然关键约定(供用户校验)。`;
}

/** 临时 readline 读一行(cooked,用于子提问;主输入走 promptWithSlashMenu)。 */
async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** /context 的用量条(详情版,进内容区):只算对话内容(不含 system prompt),方便用户感知自己发了多少、agent 回复了多少。 */
function renderContextBar(history: ChatMessage[]): string {
  // 过滤掉 system 消息,只算对话内容
  const dialog = history.filter(m => m.role !== 'system');
  const est = estimateMessagesTokens(dialog);
  const win = config.contextWindowTokens;
  const pct = Math.min(1, est / win);
  const W = 10;
  const filled = Math.round(pct * W);
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
  const src = contextState.lastUsage ? t('status.measured') : t('status.estimated');
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio ? ui.yellow : ui.accent;
  const lifecycle = contextState.lifecycleStats;
  const archived = computePruneStats(history);
  const artifactStats = contextState.artifactStats;
  const artifactLine = artifactStats
    ? `\n  artifacts · fresh ${artifactStats.fresh} · stale ${artifactStats.stale} · stubbed ${archived.stubbed} · tokens ${formatArtifactTokenSources(artifactStats)}`
    : '\n  artifacts · no file-backed facts recorded';
  const lifecycleLine = lifecycle
    ? `\n  lifecycle · live ${lifecycle.live} · referenced ${lifecycle.referenced} · digested ${lifecycle.digested} · stubbed ${lifecycle.stubbed}`
    : '\n  lifecycle · no active snapshot (run a tool-enabled turn first)';
  const archiveLine = `\n  archived tool results · ${archived.stubbed}`;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${Math.round(pct * 100)}%  ${k(est)}/${k(win)} tokens · ${t('status.messages', { count: history.length })} (${src})${ui.reset}${artifactLine}${lifecycleLine}${archiveLine}`;
}

/** 状态行用量条(精简版,进底栏):[bar] pct% k/k。
 * 只计算对话内容(不含 system prompt),让用户感知"我发了多少、agent 回复了多少"占用 context。 */
function renderContextBarInline(history: ChatMessage[]): string {
  // 过滤掉 system 消息,只算对话内容
  const dialog = history.filter(m => m.role !== 'system');
  const est = estimateMessagesTokens(dialog);
  const win = config.contextWindowTokens;
  const pct = Math.min(1, est / win);
  const W = 10;
  const filled = Math.round(pct * W);
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio ? ui.yellow : ui.accent;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${pctCol}${Math.round(pct * 100)}%${ui.reset} ${ui.dim}${k(est)}/${k(win)}${ui.reset}`;
}

interface NotesPlanStatus {
  fingerprint: string;
  summary: string;
}

// 宿主侧记录已结束轮次最后看到的 plan。notes.md 仍完整保留，只抑制未变化的旧 plan 状态栏，
// 避免 agent 忘记把 `## Plan:` 改成 `## Done:` 时输入框上方永久悬挂。
let settledPlanFingerprint: string | undefined;

/** 读取 notes.md 中唯一活跃的 `## Plan:` 段。进度只统计该段，避免其他笔记 checkbox 污染计数。 */
function readPlanStatusFromNotes(): NotesPlanStatus | null {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return null;

  const root = getSandboxRoot() ?? process.cwd();
  const p = path.join(root, '.mocode', 'sessions', sessionId, 'notes.md');
  try {
    const normalized = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const start = lines.findIndex((line) => /^## Plan:\s*.+$/.test(line));
    if (start < 0) return null;
    const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s/.test(line));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    const section = lines.slice(start, end).join('\n').trimEnd();
    const title = lines[start].match(/^## Plan:\s*(.+)$/)?.[1].trim();
    if (!title) return null;

    const total = (section.match(/^\s*-\s*\[[ xX]\]\s*\d+\./gm) || []).length;
    const currentMatch = section.match(/^\s*-\s*\[ \]\s*(\d+)\.\s*(.+)$/m);
    const current = currentMatch?.[2].trim();
    // 括号进度 = 「当前执行到的步骤序号/总数」(执行第 1 步显示 1/3),与 `▸ 当前步` 后缀自洽;
    // 旧语义 done/total 会永远慢一拍(执行第 2 步显示 1/3)。全勾选时显示 total/total(通常已自动结算为 Done,chip 消失)。
    const activeNo = currentMatch ? Number(currentMatch[1]) : total;
    const summary = `plan: ${title} (${activeNo}/${total})`;
    // mtime 让“相同内容被重写为一项新计划”也能重新出现，而不被旧轮次误抑制。
    const fingerprint = `${sessionId}\0${fs.statSync(p).mtimeMs}\0${section}`;
    return { fingerprint, summary: current ? `${summary} ▸ ${current}` : summary };
  } catch {
    return null;
  }
}

/** 将当前 plan 标记为已结算。只影响状态栏，不修改 agent 的工作笔记。 */
function settlePlanStatus(): void {
  settledPlanFingerprint = readPlanStatusFromNotes()?.fingerprint;
}

/** 从 notes.md 读取活跃 plan 摘要；已结算且未变化的旧 plan 不再显示。 */
function readPlanFromNotes(): string {
  const plan = readPlanStatusFromNotes();
  if (!plan || plan.fingerprint === settledPlanFingerprint) return '';
  return plan.summary;
}

/** 状态行基线:模型 / context / cwd / 模式标识 / 活跃 plan chip / 本轮 token。repl 在轮次边界、切模式、plan 变更时调。 */
function refreshStatusBase(history: ChatMessage[], lastTurnUsage?: ChatUsage): void {
  layout.setStatusBase({
    model: config.model,
    contextBar: renderContextBarInline(history),
    cwd: process.cwd(),
    modeTag: getAgentMode() === 'plan' ? 'Plan' : 'Auto',
    planSummary: readPlanFromNotes(),
    lastTurnUsage,
  });
}

/** 命令 → 运行态状态文字 + 底栏 dim 占位。 */
function runningStateFor(
  cmd: string
): { status: string; placeholder: string } {
  switch (cmd) {
    case '/compact':
      return { status: t('running.compact'), placeholder: t('running.compacting') };
    case '/resume':
      return { status: t('running.resume'), placeholder: t('running.chooseSession') };
    case '/rollback':
      return { status: t('running.rollback'), placeholder: t('running.chooseTurn') };
    case '/init':
      return { status: t('running.init'), placeholder: t('running.generateMemory') };
    case '/plan':
      return { status: t('running.plan'), placeholder: '…' };
    case '/auto':
      return { status: t('running.auto'), placeholder: '…' };
    case '/clear':
      return { status: t('running.clear'), placeholder: '…' };
    case '/theme':
      return { status: t('running.theme'), placeholder: t('running.chooseTheme') };
    case '/model':
      return { status: t('running.model'), placeholder: t('running.configuring') };
    case '/pet':
      return { status: t('running.pet'), placeholder: t('running.processing') };
    case '/memory_switch':
      return { status: t('running.memory'), placeholder: t('running.switching') };
    case '/memory_status':
      return { status: t('running.memoryStatus'), placeholder: '…' };
    case '/subagent':
      return { status: t('running.subagent'), placeholder: t('running.switching') };
    case '/language':
      return { status: t('running.language'), placeholder: t('running.chooseLanguage') };
    case '/upgrade':
      return { status: t('running.upgrade'), placeholder: t('running.upgrading') };
    default:
      return { status: '', placeholder: '' };
  }
}

/** stdin 的 keypress 事件接口(emitKeypressEvents 后发,不在 ReadStream 类型里)。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  off(event: 'keypress', listener: (str: string, key: Key) => void): this;
}
const emitter = stdin as unknown as KeypressEmitter;

// ── 运行态交互(typeahead 输入 + 滚动回看 + Ctrl+C 中断)──
// 只在 await runAgent() 期间挂载;/resume /rollback /compact 等走 askLine(cooked readline)的分支不挂(避免抢 stdin)。
let runningInput = ''; // 运行中已打字缓冲(单行;agent 结束后预填下一轮 INPUT 态)
let runningCursor = 0; // 缓冲内光标字符索引(0..len);运行态支持任意位置编辑,与空闲态一致
let runningPlaceholder = '';
let currentAbort: AbortController | null = null;
let pendingPrefill: string[] | null = null; // /rollback 选中后预填的 user 输入(下轮 INPUT 态消费)

// ── pending send 撤回窗口(用户按 Enter 后、agent 真发请求前)──
// 500ms 内 Ctrl+C / Esc → 整条用户气泡从内容区擦掉 + 原行 prefilled 回输入框(可改可再发);
// 期间再按 Enter 立即推进 / 时间到自然推进 → 走原流程 enterRunningMode + runTurn。
// attachmentsCount 记 pendingAttachments 当时长度——撤回时 attachments 保留(用户意图未变,只是改字)。
const PENDING_RECALL_MS = 500;
let pendingRecall: {
  lines: string[];
  attachmentsCount: number;
  placeholder: string;
} | null = null;
let pendingTimer: NodeJS.Timeout | null = null;
// agent 模式状态已提到 src/agent/mode.ts(共享叶子:switch_mode 工具可写、agent 每步读、repl 注册 onModeChange 监听器)。

/** 多模态 user 输入的附件状态。pending = 本轮尚未提交的待发图片;messageAttachments = 已 push 进 history 的图片元数据
 *  (供 renderHistory 复显文件名——base64 不可逆地塞进 history 后,只能从侧 channel 拿原文件名)。 */
let pendingAttachments: ImageAttachment[] = [];
const messageAttachments = new Map<number, ImageAttachment[]>();

/** 运行态按键:滚动优先,再 Ctrl+C 中断,再 typeahead 编辑(单行,Enter=无操作)。 */
function onRunningKey(_str: string, key?: Key): void {
  if (!key) return;
  // 鼠标 fragment:重组 + 派发给 layout.handleMouseEvent(滚轮/框选/复制)。
  if (mouse.swallow(key.sequence ?? '')) return;
  // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页,↑/↓ 每次 5 行(键盘)。
  // 运行态无输入光标,↑/↓ 无其他用途,直接作滚动。
  if (
    key.name === 'pageup' ||
    key.name === 'pagedown' ||
    key.name === 'up' ||
    key.name === 'down'
  ) {
    const pageH = layout.getGeo().contentBottom;
    if (key.name === 'pageup') layout.scrollBy(pageH);
    else if (key.name === 'pagedown') layout.scrollBy(-pageH);
    else if (key.name === 'up') layout.scrollBy(5);
    else layout.scrollBy(-5);
    return;
  }
  // 用户在交互(非滚动键)→ 暂停流式物理写,避免光标去 contentRow 扰动 IME 候选窗(停手后自动 flush)
  layout.setUserActive();
  // 滚动回看时打字 / 编辑(typeahead)不回尾——保持历史视图,便于运行中边看历史边预输入;
  // 回尾时机:Enter 在运行态是 no-op,真正回尾发生在 agent 结束后 INPUT 态按 Enter 提交(见 prompt.ts submit 前)。
  // Ctrl+C 4 层语义(RUNNING 态):有 typeahead → 清空(层 1,不中断);空 → abort(层 2,中断 agent)。
  // 两次 Ctrl+C 才中断(先清 typeahead 再 abort),与 INPUT 态 onCtrlC 的 fish 式一致。
  // raw 模式下 Ctrl+C 是按键不触发 SIGINT;signal 经 executeTool 串进工具,run_command/web_fetch 即时被杀。
  if (key.ctrl && key.name === 'c') {
    if (runningInput.length > 0) {
      runningInput = '';
      runningCursor = 0;
      layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder);
    } else if (currentAbort && !currentAbort.signal.aborted) {
      appendCurrentSessionRuntimeEvent('abort', { phase: 'requested', source: 'keyboard' });
      currentAbort.abort();
    }
    return;
  }
  const s = key.sequence ?? '';
  // 光标移动(单行 typeahead,光标可任意位置,与空闲态一致)
  if (key.name === 'left') { runningCursor = Math.max(0, runningCursor - 1); layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder); return; }
  if (key.name === 'right') { runningCursor = Math.min(runningInput.length, runningCursor + 1); layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder); return; }
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) { runningCursor = 0; layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder); return; }
  if (key.name === 'end' || (key.ctrl && key.name === 'e')) { runningCursor = runningInput.length; layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder); return; }
  if (key.name === 'backspace') {
    if (runningCursor > 0) {
      runningInput = runningInput.slice(0, runningCursor - 1) + runningInput.slice(runningCursor);
      runningCursor--;
      layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder);
    }
    return;
  }
  if (key.name === 'delete') {
    if (runningCursor < runningInput.length) {
      runningInput = runningInput.slice(0, runningCursor) + runningInput.slice(runningCursor + 1);
      layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder);
    }
    return;
  }
  if (key.name === 'escape') {
    runningInput = '';
    runningCursor = 0;
    layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder);
    return;
  }
  // Enter / Ctrl+J:运行中 no-op(单行 typeahead;agent 结束后预填,用户在 INPUT 态按 Enter 提交)
  if (
    key.name === 'return' ||
    key.name === 'enter' ||
    (key.ctrl && key.name === 'j')
  ) {
    return;
  }
  // 可打印字符(>= 空格,非 ctrl/meta)→ 光标处插入 + 非 dim 回显(与空闲态一致)
  if (s && s >= ' ' && !key.ctrl && !key.meta) {
    runningInput = runningInput.slice(0, runningCursor) + s + runningInput.slice(runningCursor);
    runningCursor += s.length;
    layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder);
  }
}

/** 鼠标右键单击输入框(未拖动)时 layout 读剪贴板后回调:在光标处插入 typeahead 缓冲(单行,换行折为空格)。 */
function onRunningMousePaste(text: string): void {
  const flat = text.replace(/[\r\n]+/g, ' ');
  runningInput = runningInput.slice(0, runningCursor) + flat + runningInput.slice(runningCursor);
  runningCursor += flat.length;
  layout.paintRunningInput(runningInput, runningCursor, runningPlaceholder);
}

/** 进入运行态:挂 keypress 监听 + raw mode + 新建 abort 控制器,返回其 signal。在 await runAgent 前、enterRunningMode 后调。 */
function startRunningListener(placeholder: string): AbortSignal {
  runningPlaceholder = placeholder;
  runningInput = '';
  runningCursor = 0;
  emitKeypressEvents(stdin); // 幂等:首轮 prompt 已永久挂解析器,这里防御性再调
  try {
    stdin.setRawMode(true);
  } catch {
    // 非 TTY / 不支持 raw:监听器仍挂(按键可能不来,不影响 agent)
  }
  stdin.resume();
  emitter.on('keypress', onRunningKey);
  layout.setPasteHandler(onRunningMousePaste); // 鼠标右键单击输入框(未拖动)→ 读剪贴板贴入
  const ac = new AbortController();
  currentAbort = ac;
  return ac.signal;
}

/** 退出运行态:摘监听 + 清 abort。不 pause / 不 setRawMode(false)——紧接着 promptWithSlashMenu 自己接管 raw。 */
function stopRunningListener(): void {
  emitter.off('keypress', onRunningKey);
  layout.setPasteHandler(null);
  currentAbort = null;
}

/**
 * 把用户消息格式化为带满宽背景色的文本(上滑时易辨认用户消息)。
 * 每行用 padEndDisplay 填充到终端宽度(含 ❯ / 缩进),背景色 SGR 包裹整行 + 行末 reset。
 * 满宽 pad 使终端背景色覆盖整行(含行尾空单元格),上滑滚动时用户消息呈连续色块、与 assistant 正文区分。
 * 末尾多留一空行(\n\n 收尾):用户消息与后续(agent 流式输出 / 下条消息)之间空一行。
 */
function formatUserMessage(lines: string[], trailingBlank = true): string {
  const cols = layout.getGeo().cols;
  const promptW = displayWidth(PROMPT);
  const indent = ' '.repeat(promptW);
  const { userBg, reset } = ui;
  return (
    lines
      .map((l, i) => {
        const prefix = i === 0 ? PROMPT : indent;
        const full = prefix + l;
        const padded = padEndDisplay(full, cols);
        return `${userBg}${padded}${reset}`;
      })
      .join('\n') + (trailingBlank ? '\n\n' : '\n')
  );
}

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
function awaitPendingRecall(
  input: string[],
  attachmentsCount: number,
  placeholder: string,
): Promise<boolean> {
  pendingRecall = { lines: input, attachmentsCount, placeholder };
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
    pendingRecall = null;
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
      pendingRecall = null;
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
      // 立即 commit
      if (key.name === 'enter' || key.name === 'return') {
        finalize(true);
        return;
      }
      // 其他键忽略
    };
    emitter.on('keypress', onPendingKey);
    pendingTimer = setTimeout(() => finalize(true), PENDING_RECALL_MS);
    pendingTimer.unref?.();
  });
}

/** 把任意消息 content 拍平成字符串(OpenAI 可能 string / null / 多模态数组)。 */
function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c == null) return '';
  if (Array.isArray(c)) {
    return c
      .map((p) =>
        typeof p === 'string' ? p : (p as { text?: string })?.text ?? ''
      )
      .join('');
  }
  return String(c);
}

/** 从旧 session 的消息历史回填输入历史；新 session 使用独立 queryHistory，避免混入合成 user 消息。 */
function queryHistoryFromMessages(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => textOf((message as { content?: unknown }).content))
    .filter((query) => query.trim().length > 0);
}

/**
 * 把会话历史渲染成静态文本进内容区(回滚 / 续接 / --resume 后复显上下文):
 * user→❯ 回显、assistant→正文(+ tool_calls 折叠成 ● 摘要行)、tool→↳ 结果预览;system 跳过。
 * 思考段不持久(history 只存正文),故无思考折叠。渲染后续写位在末尾,紧接 enterInputMode 画输入框。
 * 内容长于屏时 viewport 显尾(最近轮次),PgUp 可看更早——与流式态一致。
 * user 多模态:用 textOf 取 text parts;若侧 channel messageAttachments 有原文件名则追加 chip 行
 * (避免 base64 解码不可逆,旧 session 没侧 channel 时只显文本,文件名 fallback 到 image/* mime)。
 *
 * 折叠策略:遇到 assistant + tool_calls 不立即打 ● 行,而是累积到 batchEntries;
 * 跟随的连续 tool 消息按 tool_call_id 反查填 resultSummary;遇下一个非 tool 消息(或末尾)时,
 * 用 batch.writeSummaryOnly 出单行摘要(与实时 runAgent 同一渲染器,UI 一致)。
 * 回放默认全折叠;用户可鼠标点击摘要行展开(由 BatchRenderer 接管,见 ui/batch.ts)。
 */
export function renderHistory(history: ChatMessage[]): void {
  const idToEntry = new Map<string, batch.BatchEntry>();
  // 普通工具可跨 assistant 步聚合；mutation 各自占一个 group，并切断前后普通工具。
  let pendingBatches: batch.BatchEntry[][] = [];
  let normalBatch: batch.BatchEntry[] | null = null;
  const flushBatch = (): void => {
    for (const entries of pendingBatches) batch.writeSummaryOnly(entries, layout);
    pendingBatches = [];
    normalBatch = null;
  };
  for (let idx = 0; idx < history.length; idx++) {
    const m = history[idx];
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      flushBatch(); // 上一轮 batch(若有)收尾
      const lines = textOf((m as { content?: unknown }).content).split('\n');
      layout.contentWrite(formatUserMessage(lines));
      const atts = messageAttachments.get(idx);
      if (atts && atts.length > 0) {
        for (const a of atts) {
          layout.contentWrite(`  ${ui.dim}${renderChip(a)}${ui.reset}\n`);
        }
      } else if (Array.isArray((m as { content?: unknown }).content)) {
        // 旧 session 没侧 channel:从 data URL 头抽 mime,显一个通用 chip
        const c = (m as { content?: unknown }).content as unknown[];
        for (const p of c) {
          if (p && typeof p === 'object' && (p as { type?: string }).type === 'image_url') {
            const url = (p as { image_url?: { url?: string } }).image_url?.url ?? '';
            const mime = url.startsWith('data:') ? url.slice(5, url.indexOf(';')) : 'image';
            layout.contentWrite(`  ${ui.dim}📷 ${mime}${ui.reset}\n`);
          }
        }
      }
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf((m as { content?: unknown }).content);
      if (text) {
        flushBatch(); // 文本前若有累积 batch 先收尾(罕见:连续两个 assistant tool_calls 文本间)
        layout.contentWriteMdOnce(text);
        if (!text.endsWith('\n')) layout.contentWrite('\n');
      }
      const tcs = (m as {
        tool_calls?: {
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      }).tool_calls;
      if (Array.isArray(tcs) && tcs.length > 0) {
        if (text) {
          // contentWriteMdOnce 会裁掉 markdown 尾部空行，而 history 中的原始 text 是否以 \n
          // 结尾并不能代表当前物理布局。按缓冲中的视觉行归一化，和实时“正文 → 工具”
          // 边界一致地保留一条空行，避免 /resume 回放时工具摘要紧贴正文。
          layout.normalizeMutationBoundary();
        }
        // 累积到 pendingBatch,顺序 = tool_calls 序
        for (const tc of tcs) {
          const name = tc?.function?.name ?? '';
          const args = tc?.function?.arguments ?? '';
          const entry: batch.BatchEntry = {
            name,
            callSummary: summarizeToolCall(name, args),
            resultSummary: '',
            diffBlock: null,
          };
          if (batch.isMutationToolName(name)) {
            normalBatch = null;
            pendingBatches.push([entry]);
          } else {
            if (!normalBatch) {
              normalBatch = [];
              pendingBatches.push(normalBatch);
            }
            normalBatch.push(entry);
          }
          if (tc?.id) idToEntry.set(tc.id, entry);
        }
        continue; // 跳过后续 tool 消息处理循环(由下一分支填 result)
      }
      // 无 tool_calls:若有 pending batch(文本+无 tool_calls 的 assistant),不常见,先收尾
      flushBatch();
      continue;
    }
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
      const target = idToEntry.get(id);
      const name = target?.name ?? '';
      const output = textOf((m as { content?: unknown }).content);
      const preview = summarizeToolResult(name, output);
      if (target) {
        target.resultSummary = preview;
        target.fullOutput = output;
      }
      // 不直接写屏——等 flushBatch 时出单行摘要
      continue;
    }
  }
  flushBatch(); // 末尾兜底
}

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
  // ③ MOCODE.md 只在 base 中提示按需 read_file，不注入正文；④ Memory Index 按开关注入。
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

  // 开场:按 config.theme 切主题(横幅 / 状态行 / 后续渲染皆用新色),再进 alt screen + 状态基线 + 清内容区。
  // --resume 有历史则渲染对话,否则横幅。
  setTheme(config.theme);
  layout.enterAltScreen();
  refreshStatusBase(history);
  layout.clearContent();
  layout.contentMode();
  if (history.some((m) => m.role === 'user')) {
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
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          model: config.model,
          contextWindow: config.contextWindowTokens,
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
  /**
   * 切换 agent 模式(Shift+Tab 触发,经 prompt.ts 的 onCycleMode 回调)。
   * cycleMode 翻 agentMode + applyMode 重写 history[0] + refreshStatusBase 设状态行 modeTag;
   * 随后 prompt.ts 自调 redraw() 经 paintInput 把 chip 画出来(光标留输入框,不调 drawStatusBar)。
   */
  const applyMode = (planMode: boolean): void => {
    history[0] = { role: 'system', content: buildSystemMessage(planMode) };
  };
  const cycleMode = (): void => {
    setAgentMode(getAgentMode() === 'plan' ? 'auto' : 'plan'); // listener 接手 applyMode + refreshStatusBase
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
        layout.contentWrite(`${ui.red}${t('repl.errorLabel')}${ui.reset} ${msg}\n`);
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
    lastTurnUsage = undefined; // 续接:旧会话的 token 累计已无意义,清空等下轮覆写
    layout.clearContent();
    renderHistory(history);
    // 末尾 \n\n:与后续用户消息(❯ bubble)之间空一行。
    layout.contentWrite(`${ui.dim}${t('repl.resumed', { id: loaded.id })}${ui.reset}\n\n`);
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
        queryHistory,
        onCycleMode: cycleMode,
        // /rollback 预填优先;否则上一轮运行中 typeahead 打的字 → 预填进输入框,用户可改可发
        ...(pendingPrefill
          ? { initialLines: pendingPrefill }
          : runningInput
            ? { initialLines: [runningInput] }
            : {}),
      });
    } catch {
      break; // Ctrl+C(SIGINT)/ 异常 → 退出
    }
    pendingPrefill = null; // 预填已消费,清空
    runningInput = ''; // 预填已消费,清空(下轮运行态从空开始)
    if (input === null) break; // 空 prompt Ctrl+D

    let joined = input.join('\n');
    const line = joined.trim();
    if (!line) continue;
    hasSubmittedInput = true;
    if (line === '/exit' || line === '/quit') break;

    // RUNNING 态:回显输入 → 底栏改 dim 占位、光标回内容续写位
    const cmd = line.split(/\s+/)[0];
    // 语言命令把视觉分隔放在确认文案之后；避免回显后先空一行、下一条命令却紧贴确认。
    echoInput(input, cmd !== '/language');
    const state = runningStateFor(cmd);
    const placeholder = state.placeholder;
    refreshStatusBase(history);
    layout.enterRunningMode(state.status, placeholder);

    if (line === '/help') {
      layout.contentWrite(`${ui.bold}${t('help.title')}${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}${t('help.hint')}${ui.reset}\n`);
      layout.contentWrite(`${slashHelpLines().join('\n')}\n`);
      continue;
    }
    if (line === '/language' || line.startsWith('/language ')) {
      const arg = line === '/language' ? '' : line.slice('/language '.length).trim();
      if (!arg) {
        const currentName = getLanguage() === 'zh-CN' ? t('language.zh') : t('language.en');
        layout.contentWrite(`${ui.dim}${t('language.current', { language: currentName })}${ui.reset}\n`);
        layout.contentWrite(`${ui.dim}${t('language.usage')}${ui.reset}\n\n`);
        continue;
      }
      const next = normalizeLanguage(arg);
      if (!next) {
        layout.contentWrite(`${ui.yellow}${t('language.invalid', { value: arg })}${ui.reset}\n\n`);
        continue;
      }
      updateLanguageConfig(next);
      updateConfigKey('MOCODE_LANGUAGE', next);
      history[0] = { role: 'system', content: buildSystemMessage(getAgentMode() === 'plan') };
      refreshStatusBase(history);
      // 横幅是内容缓冲顶部的固定区域；语言切换后等长原地替换，不移动后续对话。
      layout.rewriteBanner(bannerLines(banner()));
      layout.contentWrite(`${ui.cyan}${t('language.changed')}${ui.reset}\n`);
      if (languageFromShell) {
        layout.contentWrite(`${ui.dim}${t('language.shellOverride')}${ui.reset}\n`);
      }
      layout.contentWrite('\n');
      continue;
    }
    if (line === '/init') {
      // /init:把 init 指令当 user 输入发给 agent(扫描项目 + 生成 MOCODE.md),fall through 走 runAgent
      joined = buildInitPrompt();
    }
    if (line === '/upgrade' || line.startsWith('/upgrade ')) {
      const arg = line === '/upgrade' ? '' : line.slice('/upgrade '.length).trim().toLowerCase();

      // /upgrade check — 联网检查当前版本与最新版本差异
      if (arg === 'check') {
        const signal = startRunningListener(t('running.upgrading'));
        try {
          const info = await checkVersion();
          if (!info.latest) {
            layout.contentWrite(`${ui.yellow}⚠ ${t('upgrade.fetchFailed')}${ui.reset}\n`);
          } else if (info.hasUpdate) {
            layout.contentWrite(`${ui.cyan}● ${t('upgrade.hasUpdate', { current: info.current, latest: info.latest })}${ui.reset}\n`);
            layout.contentWrite(`${ui.dim}${t('upgrade.checkHint')}${ui.reset}\n`);
          } else {
            layout.contentWrite(`${ui.green}✓ ${t('upgrade.noUpdate', { version: info.current })}${ui.reset}\n`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          layout.contentWrite(`${ui.red}${t('upgrade.failed', { message: msg })}${ui.reset}\n`);
        } finally {
          stopRunningListener();
        }
        continue;
      }

      // /upgrade status — 只显示本地当前版本(不联网)
      if (arg === 'status') {
        const current = getCurrentVersion();
        layout.contentWrite(`${ui.dim}${t('upgrade.currentVersion', { version: `v${current}` })}${ui.reset}\n`);
        layout.contentWrite(`${ui.dim}${t('upgrade.pkgName')}${ui.reset}\n`);
        continue;
      }

      // /upgrade 或 /upgrade now — 前台执行升级,实时显示 npm 输出
      if (arg === '' || arg === 'now') {
        const signal = startRunningListener(t('running.upgrading'));
        try {
          const latest = await fetchLatestVersion();
          const current = getCurrentVersion();
          if (latest && latest === current) {
            layout.contentWrite(`${ui.green}✓ ${t('upgrade.noUpdate', { version: current })}${ui.reset}\n`);
            continue;
          }
          const target = latest ?? 'latest';
          layout.contentWrite(`${ui.cyan}● ${t('upgrade.begin', { version: target })}${ui.reset}\n`);

          const result = await runUpgradeForeground((chunk) => {
            layout.contentWrite(chunk);
          });

          if (result.ok) {
            layout.contentWrite(`\n${ui.green}${ui.bold}✓ ${t('upgrade.completed')}${ui.reset}\n`);
            // 给用户 2.5 秒看清提示,然后自动退出,下次启动即使用新版本。
            await new Promise((resolve) => setTimeout(resolve, 2500));
            break;
          } else {
            layout.contentWrite(`${ui.red}✗ ${t('upgrade.failedWithCode', { code: String(result.exitCode ?? 'unknown') })}${ui.reset}\n`);
            if (result.output.includes('ETARGET') || result.output.includes('No matching version found')) {
              layout.contentWrite(`${ui.yellow}${t('upgrade.etargetHint')}${ui.reset}\n`);
            } else {
              layout.contentWrite(`${ui.dim}${t('upgrade.manualHint')}${ui.reset}\n`);
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          layout.contentWrite(`${ui.red}${t('upgrade.failed', { message: msg })}${ui.reset}\n`);
        } finally {
          stopRunningListener();
        }
        continue;
      }

      // 未知子命令
      layout.contentWrite(`${ui.yellow}${t('upgrade.usage')}${ui.reset}\n`);
      continue;
    }
    if (line === '/plan') {
      // /plan:切到 plan 模式(只读探查 + 产出计划)。
      if (getAgentMode() === 'plan') {
        layout.contentWrite(`${ui.dim}${t('repl.planAlready')}${ui.reset}\n`);
      } else {
        setAgentMode('plan');
        layout.contentWrite(`${ui.dim}${t('repl.planChanged')}${ui.reset}\n`);
      }
      continue;
    }
    if (line === '/auto') {
      if (getAgentMode() === 'auto') {
        layout.contentWrite(`${ui.dim}${t('repl.autoAlready')}${ui.reset}\n`);
      } else {
        setAgentMode('auto');
        layout.contentWrite(`${ui.dim}${t('repl.autoChanged')}${ui.reset}\n`);
      }
      continue;
    }
    if (line === '/pet quit') {
      // /pet quit:完全关闭桌宠进程(区别于 /pet 的仅断开本连接)。方案C的 CLI 侧退出入口,
      // 另一入口是桌宠托盘菜单"退出桌宠"(见 packages/pet-app/src/main.ts)。
      const { ok, reason } = await killPetProcess();
      layout.contentWrite(`${ui.dim}(${ok ? '已关闭桌宠进程' : reason ?? '关闭失败'})${ui.reset}\n`);
      continue;
    }
    if (line === '/pet skin') {
      // /pet skin:菜单选皮(↑↓ 选,Enter 切换,Esc 取消),仿 /theme 的交互。要求桌宠已在运行
      // (未运行则先提示 /pet 打开;不在此处自动 spawn,避免选皮命令产生"顺带开桌宠"的意外副作用)。
      let skinList: { skins: { id: string; name: string }[]; currentSkinId: string };
      try {
        skinList = await listSkins();
      } catch (e) {
        layout.contentWrite(
          `${ui.dim}(${e instanceof Error ? e.message : '获取皮肤列表失败'})${ui.reset}\n`,
        );
        continue;
      }
      const items: SessionPickerItem[] = [
        { id: 'default', title: '默认(mascot)', subtitle: skinList.currentSkinId === 'default' ? '当前' : '' },
        ...skinList.skins.map((s) => ({
          id: s.id,
          title: s.name,
          subtitle: skinList.currentSkinId === s.id ? '当前' : '',
        })),
      ];
      let pick: SessionPickerItem | null;
      try {
        pick = await promptThemePicker(items);
      } catch {
        continue; // Ctrl+C(SIGINT)→ 取消
      }
      if (pick === null) continue; // Esc / Ctrl+D 取消
      setSkin(pick.id);
      layout.contentWrite(`${ui.dim}(已切换桌宠皮肤:${pick.title})${ui.reset}\n`);
      continue;
    }
    if (line === '/pet') {
      // /pet:开关桌宠。已连接→断开;未连接→探测端口(已有实例则直连)或 spawn 拉起 + 退避重试连接。
      // togglePet 不抛异常,所有失败路径转为返回值——桌宠是可选增强,任何异常都不能影响 REPL 主流程。
      const { connected, reason } = await togglePet();
      if (connected) {
        layout.contentWrite(`${ui.dim}(桌宠已连接)${ui.reset}\n`);
      } else {
        layout.contentWrite(`${ui.dim}(${reason ?? '桌宠已断开'})${ui.reset}\n`);
      }
      continue;
    }

    if (line === '/clear') {
      history.length = 1; // 保留 system 提示
      resetState(); // 同步清空回滚轮次/快照
      currentSessionId = undefined; // 下轮起新会话文件
      setCurrentSessionId(undefined, process.cwd()); // 同步清空 session/state
      turnCount = 0; // 反思 cadence 重新计数
      contextState.lastUsage = undefined;
      contextState.lifecycleStats = undefined;
      lastTurnUsage = undefined; // 清空旧轮的 token 累计
      pendingAttachments = []; // 一并清空待发图片
      layout.clearContent();
      layout.writeBanner(bannerLines(banner()));
      layout.contentWrite(`${ui.dim}${t('repl.historyCleared')}${ui.reset}\n`);
      continue;
    }
    // /image:附加本地图片到下一条 user 消息(支持 /image <path> · /image list · /image clear)。
    // dispatch 阶段不调 runTurn:仅 mutate pendingAttachments 状态,提交时(runTurn 入口)才 flush 进 history。
    if (line === '/image' || line === '/image list' || line === '/image clear' || line.startsWith('/image ')) {
      if (line === '/image list' || (line === '/image' && pendingAttachments.length > 0)) {
        // 空 /image 视为 list(无歧义;若用户想加图必须 /image <path>)
        if (pendingAttachments.length === 0) {
          layout.contentWrite(`${ui.dim}(无待发送图片)${ui.reset}\n`);
        } else {
          for (const a of pendingAttachments) {
            layout.contentWrite(`  ${ui.dim}${renderChip(a)}${ui.reset}\n`);
          }
        }
        continue;
      }
      if (line === '/image clear' || (line === '/image' && pendingAttachments.length === 0)) {
        // /image 单独输入 + 无 pending:也走 list(空集)
        if (line === '/image' && pendingAttachments.length === 0) {
          layout.contentWrite(`${ui.dim}(无待发送图片)${ui.reset}\n`);
        } else {
          pendingAttachments = [];
          layout.contentWrite(`${ui.dim}(已清空待发送图片)${ui.reset}\n`);
        }
        continue;
      }
      const arg = line.slice('/image'.length).trim().replace(/^["']|["']$/g, '');
      if (!arg) {
        layout.contentWrite(`${ui.dim}用法: /image <path>${ui.reset}\n`);
        continue;
      }
      const maxBytes = config.maxImageBytes ?? MAX_INLINE_BYTES_DEFAULT;
      const r = await loadImageAttachment(arg, { maxBytes });
      if (!r.ok) {
        layout.contentWrite(`${ui.red}[image] ${r.reason}${ui.reset}\n`);
        continue;
      }
      if (!pendingAttachments.find((a) => a.id === r.att.id)) {
        pendingAttachments.push(r.att);
      }
      layout.contentWrite(`  ${ui.dim}${renderChip(r.att)} — will attach to next message${ui.reset}\n`);
      // 提前警告(不阻断附加):当前模型已知不支持视觉(如 MiniMax M2.x / gpt-3.5 等)时,
      // 附加时就提示,而不是等发送后才在 catch 块里翻译 API 报错——减少一轮无意义请求。
      if (!modelSupportsVision(config.model)) {
        layout.contentWrite(
          `  ${ui.yellow}⚠ 当前模型 ${config.model} 已知不支持视觉输入,发送图片可能会失败。可用 /model 切换。${ui.reset}\n`
        );
      }
      continue;
    }
    if (line === '/context') {
      layout.contentWrite(`  ${renderContextBar(history)}\n`);
      continue;
    }
    if (line === '/memory') {
      // 记忆库概览:计数 + 近期 active 索引(详情用 memory_search)。
      const all = loadAll();
      const active = all.filter((e) => e.status === 'active');
      const archived = all.filter((e) => e.status === 'archived').length;
      const byType: Record<string, number> = {};
      for (const e of active) byType[e.type] = (byType[e.type] || 0) + 1;
      layout.contentWrite(
        `${ui.dim}记忆库:active ${active.length}${archived ? ` · archived ${archived}` : ''}${ui.reset}\n`,
      );
      if (Object.keys(byType).length) {
        layout.contentWrite(
          `${ui.dim}按类:${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join('  ')}${ui.reset}\n`,
        );
      }
      const recent = [...active]
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, 10);
      for (const e of recent) {
        layout.contentWrite(
          `  ${ui.accent}${e.id}${ui.reset}  ${ui.dim}${e.name} — ${e.summary}${ui.reset}\n`,
        );
      }
      if (active.length === 0)
        layout.contentWrite(`${ui.dim}(无 active 记忆;用 memory_save 存,或 /init 生成 MOCODE.md)${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}(详情用 memory_search;启动索引已注入 systemPrompt)${ui.reset}\n`);
      continue;
    }
    if (line === '/reflect') {
      // 记忆子系统总开关关闭时反思无意义(kickoffReflection 内部也会短路),直接提示,不误导用户"已触发"。
      if (!isMemoryEnabled()) {
        layout.contentWrite(
          `${ui.dim}(记忆子系统已关闭,/reflect 无效。用 /memory_switch 打开后再试)${ui.reset}\n`,
        );
        continue;
      }
      // 手动触发后台反思 pass(不等;完成后下次 INPUT 态显摘要)。
      kickoffReflection(snapshotTranscript(history, 20));
      layout.contentWrite(
        `${ui.dim}(反思已触发,后台进行;完成后下次输入态显示摘要。日志见 .mocode/memory.log)${ui.reset}\n`,
      );
      continue;
    }
    if (line === '/skills') {
      const skills = listSkills();
      if (skills.length === 0) {
        layout.contentWrite(`${ui.dim}(没有已发现的 skill)${ui.reset}\n`);
      } else {
        layout.contentWrite(
          `${ui.dim}已发现 ${skills.length} 个 skill:${ui.reset}\n`
        );
        for (const s of skills) {
          layout.contentWrite(
            `  ${ui.accent}${s.name}${ui.reset}  ${ui.dim}${s.description}${ui.reset}\n`
          );
        }
        layout.contentWrite(
          `${ui.dim}(用 use_skill 工具加载某 skill 的完整指令)${ui.reset}\n`
        );
      }
      continue;
    }
    if (line === '/compact' || line.startsWith('/compact ')) {
      // /compact 默认强制压缩(force=true)，不受阈值/保护区限制
      // 语法:/compact [focus] 或 /compact --no-force [focus] (显式关闭强制)
      const rest = line.slice('/compact'.length).trim();
      let force = true; // 默认强制
      let focus: string | undefined;
      if (rest === '--no-force') force = false;
      else if (rest.startsWith('--no-force ')) {
        force = false;
        focus = rest.slice('--no-force '.length).trim() || undefined;
      } else if (rest) focus = rest;
      // 走调度器路径:与自动每步压缩完全一致——五区按 ROI 压(cold tools 优先 → history 摘要最后)。
      // focus 透传到 compact_history action 的 LLM 摘要 prompt。
      // 返回 SchedulerRunLog 给 UI 显示决策;退化路径(开关关时)在 manualCompact 内部走 compactHistory。
      const log = await manualCompact(history, focus, { force });
      // ② compact 后把活跃 plan 重注入系统提示（history[0]），避免 agent 因上下文压缩丢失执行计划。
      if (log.compactHistoryCalled) reinjectActivePlanIntoSystem(history);
      const d = log.compactDetail;
      appendCurrentSessionRuntimeEvent('compact', {
        source: 'manual',
        force,
        called: log.compactHistoryCalled,
        reason: d?.reason ?? 'unknown',
        estimateBefore: d?.estimateBefore,
        estimateAfter: d?.estimateAfter,
        focusHash: focus ? hashTraceValue(focus) : undefined,
      });
      if (!d) {
        // 兜底(旧调用):只显示 old 文案
        if (!log.compactHistoryCalled) {
          layout.contentWrite(`${ui.dim}(无需压缩:没有可压缩的旧消息)${ui.reset}\n`);
        } else if (focus) {
          layout.contentWrite(`${ui.dim}(带焦点压缩:${focus})${ui.reset}\n`);
        }
        continue;
      }
      // 详细文案:按 reason 分类
      const reason = d.reason;
      const before = d.estimateBefore;
      const after = d.estimateAfter;
      const proto = d.protectedRatio !== undefined ? `保护区占比 ${(d.protectedRatio * 100).toFixed(0)}%` : '';
      const oldCt = d.oldGroupCount !== undefined ? `旧区组数 ${d.oldGroupCount}` : '';
      const focusNote = focus ? `焦点:${focus}` : '';
      const stats = [proto, oldCt].filter(Boolean).join(' · ');

      if (reason === 'microcompact') {
        layout.contentWrite(`${ui.cyan}✓ 微压缩:${ui.reset} ${before} → ${after} tokens${stats ? `  (${ui.dim}${stats}${ui.reset})` : ''}\n`);
      } else if (reason === 'summarize') {
        layout.contentWrite(`${ui.cyan}✓ LLM 摘要:${ui.reset} ${before} → ${after} tokens${focusNote ? `  (${ui.dim}${focusNote}${ui.reset})` : ''}\n`);
      } else if (reason === 'noop-empty') {
        layout.contentWrite(`${ui.dim}(history 太短,只有 system 提示,无可压旧区)${ui.reset}\n`);
      } else if (reason === 'noop-protected') {
        layout.contentWrite(`${ui.dim}(无可压旧区:全部在保护区 system + 当前轮)${ui.reset}${stats ? `  ${ui.dim}(${stats})${ui.reset}` : ''}\n`);
        layout.contentWrite(`${ui.dim}提示:/compact --force 强行把早期对话压成摘要${ui.reset}\n`);
      } else if (reason === 'noop-ml-only') {
        layout.contentWrite(`${ui.dim}(LLM 摘要失败,且无超大单条可微压;可能是后端不可用)${ui.reset}\n`);
        layout.contentWrite(`${ui.dim}回退:只跑了 keep-current 结构,history 未变${ui.reset}\n`);
      } else if (reason === 'noop-shrunk-too-large') {
        layout.contentWrite(`${ui.yellow}● 上下文已超阈但无可压缩项(全在保护区),建议 /clear 或缩短输入。${ui.reset}\n`);
        if (stats) layout.contentWrite(`${ui.dim}(${stats})${ui.reset}\n`);
      } else if (reason === 'noop-noold-noop') {
        layout.contentWrite(`${ui.dim}(无需压缩:没有可压缩的旧消息,且不在手动触发)${ui.reset}\n`);
      } else {
        layout.contentWrite(`${ui.dim}(reason=${reason},${before} → ${after} tokens)${ui.reset}\n`);
      }
      continue;
    }
    if (line === '/sessions') {
      // /sessions:浏览全部已保存会话(慢路径,readdir+全量 JSON.parse,目录 N 大时会有可感知卡顿)。
      // 默认走 /resume(仅最近 10 条,瞬开);要翻历史续接更早的会话才用这条。
      // picker 走全显(cap=items.length,无 a 展开提示),靠 picker 自身开窗(以选中为中心分屏)。
      const sessions = listSessions(); // 不传 limit = 全量
      if (sessions.length === 0) {
        layout.contentWrite(`${ui.dim}(没有已保存的会话)${ui.reset}\n`);
        continue;
      }
      const items: SessionPickerItem[] = sessions.map((s) => ({
        id: s.id,
        title: s.firstUser || '(无)',
        subtitle: `${s.id}  ${s.model}`,
      }));
      let pick: SessionPickerItem | null;
      try {
        pick = await promptSessionPicker(items, items.length);
      } catch {
        continue; // Ctrl+C(SIGINT)→ 取消
      }
      await resumeFromPick(pick);
      continue;
    }
    if (line === '/resume') {
      // /resume:打开会话菜单(↑/↓ 选,Enter 续接,Esc 取消)。只加载最近 10 条,
      // 避免 sessions 目录堆了几百个会话时 readdir+全量 JSON.parse 卡顿。
      // 仿 /rollback 菜单化(promptSessionPicker);选中项 cyan+bold + ▸ 高亮。
      // 要续接更早的会话请用 /sessions 翻全表,或 CLI `mocode --resume <id>`。
      const sessions = listSessions(10);
      if (sessions.length === 0) {
        layout.contentWrite(`${ui.dim}(没有已保存的会话)${ui.reset}\n`);
        continue;
      }
      const items: SessionPickerItem[] = sessions.map((s) => ({
        id: s.id,
        title: s.firstUser || '(无)',
        subtitle: `${s.id}  ${s.model}`,
      }));
      let pick: SessionPickerItem | null;
      try {
        pick = await promptSessionPicker(items);
      } catch {
        continue; // Ctrl+C(SIGINT)→ 取消
      }
      await resumeFromPick(pick);
      continue;
    }
    if (line === '/theme' || line.startsWith('/theme ')) {
      // /theme:无参开菜单(↑↓ 选,Enter 切换,Esc 取消);/theme <name> 直切;/theme list 或未知名 → 列出。
      const arg = line.startsWith('/theme ') ? line.slice('/theme '.length).trim() : '';
      let name: string | null;
      if (arg === '') {
        // 无参:菜单选(仿 /resume /rollback 的 picker)
        const items: SessionPickerItem[] = listThemes().map((t) => ({
          id: t,
          title: t,
          subtitle: themeDescription(t),
        }));
        let pick: SessionPickerItem | null;
        try {
          pick = await promptThemePicker(items);
        } catch {
          continue; // Ctrl+C(SIGINT)→ 取消
        }
        name = pick?.id ?? null;
      } else if (arg === 'list' || !themeExists(arg)) {
        layout.contentWrite(`${ui.dim}${t('repl.themeList')}${ui.reset}\n`);
        for (const theme of listThemes()) {
          layout.contentWrite(
            `  ${ui.accent}${theme}${ui.reset}  ${ui.dim}${themeDescription(theme)}${ui.reset}\n`
          );
        }
        layout.contentWrite(
          `${ui.dim}${t('repl.themeCurrent', { theme: getTheme() })}${ui.reset}\n`
        );
        continue;
      } else {
        name = arg;
      }
      if (name === null) continue; // Esc / Ctrl+D 取消
      // 切:setTheme → 重算状态行(新色)→ 清内容重绘(历史 / 横幅,镜像启动 + /resume)→ 确认 → 持久化。
      // markdown MEMO 按 themeVersion 自动失效,故 renderHistory 取新色;状态栏 / 输入框由 continue 回 INPUT 态时读 getter 刷。
      setTheme(name);
      applyTerminalBackground();
      refreshStatusBase(history);
      layout.clearContent();
      if (history.some((m) => m.role === 'user')) {
        renderHistory(history);
      } else {
        layout.writeBanner(bannerLines(banner()));
      }
      layout.contentWrite(`${ui.dim}${t('repl.themeChanged', { theme: name })}${ui.reset}\n`);
      updateConfigKey('MOCODE_THEME', name);
      if (config.themeFromShell) {
        layout.contentWrite(
          `${ui.dim}(shell 环境变量 MOCODE_THEME 已设,文件写入下次启动被其覆盖;取消该 shell 设置后生效)${ui.reset}\n`
        );
      }
      continue;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      // /model:运行时配置大模型(baseURL/apiKey/model/contextWindowTokens)。
      // 即时生效(updateModelConfig 改内存 + env,reconfigureClient 重建 OpenAI 实例)+ 持久化(writeConfigKeys 写 ~/.mocode/config)。
      // 仿 /theme:promptIntervention 弹菜单/输入 → 改 config → refreshStatusBase 刷底栏 → clearContent+banner 重显横幅 → dim 警告(shell env 覆盖)。
      const arg = line.startsWith('/model ') ? line.slice('/model '.length).trim() : '';

      // ── /model 子命令(use/save/list/delete/rename)优先派发,免得被无参向导路径吞掉。

      // 共用:apply 一个预设到 config + 持久化 + 重建 client + 重显横幅。无参 /model 选菜单和 /model use 都走这里。
      const applyPresetAndPersist = (target: { name: string; baseURL: string; apiKey: string; model: string; contextWindow: number }): void => {
        updateModelConfig({
          model: target.model,
          baseURL: target.baseURL,
          apiKey: target.apiKey,
          contextWindowTokens: target.contextWindow,
        });
        writeConfigKeys({
          LLM_BASE_URL: target.baseURL,
          LLM_API_KEY: target.apiKey,
          LLM_MODEL: target.model,
          CONTEXT_WINDOW_TOKENS: String(target.contextWindow),
        });
        reconfigureClient();
        refreshStatusBase(history);
        layout.clearContent();
        if (history.some((m) => m.role === 'user')) {
          renderHistory(history);
        } else {
          layout.writeBanner(bannerLines(banner()));
        }
        layout.contentWrite(`${ui.dim}(已切换到预设 “${target.name}” → ${target.model} @ ${target.baseURL})${ui.reset}\n`);
        if (config.llmKeysFromShell.length > 0) {
          layout.contentWrite(
            `${ui.dim}(shell 环境变量已设 ${config.llmKeysFromShell.join(' / ')},文件写入下次启动被其覆盖)${ui.reset}\n`,
          );
        }
      };

      // 决定自动存的预设名:用 desired(model 字段),若与已有预设四元组完全相同则不重复存(返 null);
      // 否则若 desired 已存在则追加 -2/-3/...。desired 含非法字符(如 glm-4.6 的 '.')时先 sanitize(. → -),
// sanitize 后仍空才退化到 'preset'。
      const uniquePresetName = (
        desired: string,
        baseURL: string,
        apiKey: string,
        model: string,
        contextWindow: number,
      ): string | null => {
        const existing = listPresets();
        const sameEntry = existing.find(
          (p) => p.baseURL === baseURL && p.apiKey === apiKey && p.model === model && p.contextWindow === contextWindow,
        );
        if (sameEntry) return null; // 完全相同,不重复存
        // sanitize:把非 [a-zA-Z0-9_-] 字符(如 glm-4.6 的 '.')替换为 -,压缩两端 -,裁 1-32。
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
          p.baseURL === config.baseURL &&
          p.apiKey === config.apiKey &&
          p.model === config.model &&
          p.contextWindow === config.contextWindowTokens;
        const cols = layout.getGeo().cols;
        const labelFor = (p: typeof presets[number]): string => {
          const tag = isCurrent(p) ? ' ★current' : '';
          const right = `${p.model} @ ${p.baseURL}`;
          const left = `${p.name}${tag}`;
          const sep = left.length + 1 + right.length;
          if (sep <= cols - 2) return `${left} ${ui.dim}${right}${ui.reset}`;
          return left;
        };
        const choice = await promptIntervention({
          type: 'choice',
          title: '切换模型预设',
          detail: `当前: ${config.model} @ ${config.baseURL}(★ = 已匹配)`,
          options: presets.map(labelFor),
          allowCustom: false, // 纯切换,不需要「其他」干扰
        });
        if (choice.action === 'selected' && choice.value) {
          // value 含 ANSI 序列(labelFor 用了 ui.dim);按 preset.name 前缀匹配。
          const idx = presets.findIndex((p) => choice.value!.startsWith(p.name));
          const target = idx >= 0 ? presets[idx] : presets[0];
          applyPresetAndPersist(target);
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
          const star = p.baseURL === config.baseURL && p.apiKey === config.apiKey && p.model === config.model ? ' ★' : '';
          layout.contentWrite(
            `  ${ui.accent}${p.name}${ui.reset}${star}  ${ui.dim}${p.model} @ ${p.baseURL}${ui.reset}\n`,
          );
        }
        layout.contentWrite(`${ui.dim}(★ = 与当前一致;切换用 /model switch)${ui.reset}\n`);
        continue;
      }

      // /model show:显示当前四项配置(apiKey 脱敏)。
      if (arg === 'show') {
        layout.contentWrite(`${ui.dim}当前模型配置:${ui.reset}\n`);
        layout.contentWrite(`  ${ui.accent}baseURL${ui.reset}  ${config.baseURL}\n`);
        layout.contentWrite(`  ${ui.accent}apiKey ${ui.reset}  ${maskKey(config.apiKey)}\n`);
        layout.contentWrite(`  ${ui.accent}model  ${ui.reset}  ${config.model}\n`);
        layout.contentWrite(`  ${ui.accent}窗口   ${ui.reset}  ${config.contextWindowTokens} tokens\n`);
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

      // 3) 应用:内存 config + env(updateModelConfig)→ 持久化(writeConfigKeys)→ 重建 client(reconfigureClient)。
      updateModelConfig({ model, baseURL, apiKey, contextWindowTokens: window });
      writeConfigKeys({
        LLM_BASE_URL: baseURL,
        LLM_API_KEY: apiKey,
        LLM_MODEL: model,
        CONTEXT_WINDOW_TOKENS: String(window),
      });
      reconfigureClient();

      // 3.5) 自动存为命名预设:用 model 字段,重名追加 -2/-3,完全相同的四元组不重复存。
      //     让 /model 跑一次就多一份可切换的预设,/model switch 切回去。
      let savedName: string | null = null;
      try {
        const finalName = uniquePresetName(model, baseURL, apiKey, model, window);
        if (finalName) {
          savePreset({ name: finalName, baseURL, apiKey, model, contextWindow: window });
          savedName = finalName;
        }
        // finalName === null 表示与某个已存在预设完全一致,不再重复保存。
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
      layout.contentWrite(`${ui.dim}(已切换模型 → ${model} @ ${baseURL})${ui.reset}\n`);
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

    if (line === '/rollback' || line.startsWith('/rollback ')) {
      // /rollback:打开轮次菜单(↑/↓ 选,Enter 回滚到该轮并预填其输入,再 Enter 重新跑)。
      // 忽略任何数字参数(原「输数字选回滚」已删,统一走菜单)。无快照的旧轮次(/resume 重建)文件改动不可撤销。
      await rollbackFlow();
      continue;
    }

    if (line === '/subagent' || line.startsWith('/subagent ')) {
      const arg = line.startsWith('/subagent ')
        ? line.slice('/subagent '.length).trim().toLowerCase()
        : 'status';
      if (arg === '' || arg === 'status') {
        const enabled = isSubAgentEnabled();
        const state = t(enabled ? 'subagent.stateOn' : 'subagent.stateOff');
        layout.contentWrite(
          `${ui.accent}${t('subagent.status', { state })}${ui.reset}\n` +
          `${ui.dim}MOCODE_SUBAGENT_ENABLED=${enabled ? 'true' : 'false'} · ${CONFIG_PATH}${ui.reset}\n`,
        );
        continue;
      }
      if (arg !== 'on' && arg !== 'off') {
        layout.contentWrite(`${ui.yellow}${t('subagent.usage')}${ui.reset}\n`);
        continue;
      }

      const enabled = arg === 'on';
      if (enabled !== isSubAgentEnabled()) {
        updateSubAgentConfig(enabled);
        updateConfigKey('MOCODE_SUBAGENT_ENABLED', enabled ? 'true' : 'false');
        refreshChatTools();
        history[0] = { role: 'system', content: buildSystemMessage(getAgentMode() === 'plan') };
        layout.rewriteBanner(bannerLines(banner()));
      }
      layout.contentWrite(
        `${enabled ? ui.green : ui.yellow}${t(enabled ? 'subagent.changedOn' : 'subagent.changedOff')}${ui.reset}\n`,
      );
      continue;
    }

    if (
      line === '/fe' ||
      line.startsWith('/fe ') ||
      line === '/frontend' ||
      line.startsWith('/frontend ')
    ) {
      // /fe — 前端工具簇总开关(browser / dev_server / screenshot / view_image)。
      // 无参切换 on/off;有参 on|off 显式;status 只读。设计同 /subagent:单一来源
      // isFrontendToolsEnabled();关闭时 4 个工具不进模型 schema(refreshChatTools 过滤)、
      // 运行时 getRuntimeDisabledTools 兜底拦截、plan 模式 getPlanDisabledTools 也剔除。默认 false。
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
        continue;
      }
      if (arg !== 'on' && arg !== 'off') {
        layout.contentWrite(`${ui.yellow}${t('fe.usage')}${ui.reset}\n`);
        continue;
      }
      const enabled = arg === 'on';
      if (enabled !== isFrontendToolsEnabled()) {
        updateFrontendToolsConfig(enabled);
        updateConfigKey('MOCODE_FRONTEND_TOOLS_ENABLED', enabled ? 'true' : 'false');
        refreshChatTools();
        history[0] = { role: 'system', content: buildSystemMessage(getAgentMode() === 'plan') };
        layout.rewriteBanner(bannerLines(banner()));
      }
      layout.contentWrite(
        `${enabled ? ui.green : ui.yellow}${t(enabled ? 'fe.changedOn' : 'fe.changedOff')}${ui.reset}\n`,
      );
      continue;
    }

    if (
      line === '/memory_switch' ||
      line.startsWith('/memory_switch ') ||
      line === '/memory_status' ||
      line.startsWith('/memory_status ')
    ) {
      // /memory_switch — 记忆子系统总开关。无参切换 on/off;/memory_switch on 或 /off 显式;
      // /memory_switch true|false|1|0|yes|no 等同义。/memory_status 只读查询(不写盘)。
      //
      // 设计原则:
      //  - 单一来源 isMemoryEnabled():工具表(builtins)、系统提示词(Memory Index 段 + 工具使用说明)、
      //    plan-mode 提示(tools/constants.ts)三处都从这里查。
      //  - 当前会话的 tool list 是模块初始化时的快照(/memory_switch 不重算 builtinTools)——已发出
      //    请求的工具列表不会被回滚。要"完全生效"需要重启 REPL。但 buildSystemMessage 每次 chat 现拼,
      //    所以系统提示词和 plan suffix 会在「下一轮 chat」即时反映新值。
      //  - 持久化字段 MEMORY_ENABLED,默认值 false(新用户零侵入)。
      try {
        if (line === '/memory_status' || line.startsWith('/memory_status ')) {
          const on = isMemoryEnabled();
          layout.contentWrite(`${ui.accent}记忆子系统:${ui.reset} ${on ? `${ui.green}开启` : `${ui.yellow}关闭`}${ui.reset}\n`);
          layout.contentWrite(
            `${ui.dim}  单一来源 isMemoryEnabled()(${config.memoryEnabled});` +
              `持久化 ${ui.accent}MEMORY_ENABLED${ui.dim};` +
              `配置文件 ${CONFIG_PATH}${ui.reset}\n`
          );
          layout.contentWrite(
            `${ui.dim}  关闭时:memory_*_save/_search/_list/_update/_forget 五个工具整体不进工具表;` +
              `buildBasePrompt() 不含「## Memory」段;` +
              `plan-mode 提示词里也不出现 memory_* 工具名。${ui.reset}\n`
          );
          layout.contentWrite(
            `${ui.dim}  切换后下次新建 system message 即时反映;当前会话工具表需重启 REPL 才完整重算。${ui.reset}\n`
          );
          continue;
        }
        // /memory_switch(无参=on/off 切换;有参=按值设)
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
              `  /memory_switch status      等同 /memory_status\n`
          );
          continue;
        }
        const prev = isMemoryEnabled();
        if (nextEnabled === prev) {
          layout.contentWrite(
            `${ui.dim}(已是 ${nextEnabled ? '开启' : '关闭'},未变更 — 持久化字段未写入)${ui.reset}\n`
          );
          continue;
        }
        updateMemoryConfig(nextEnabled);
        // 写盘:mode 文件 values,/~/.mocode/config;writeConfigKeys 不会动其它键(主题 / 模型等)
        updateConfigKey('MEMORY_ENABLED', nextEnabled ? 'true' : 'false');
        const note =
          nextEnabled
            ? `${ui.green}已开启记忆子系统${ui.reset} — memory_save/search/list/update/forget 进入工具表;` +
              `Memory Index 段会在下次拼 system message 时注入。工具表本身的快照需要重启 REPL 才完整刷新。`
            : `${ui.yellow}已关闭记忆子系统${ui.reset} — 五个 memory_* 工具将在下次拼 system message 时从工具表过滤;` +
              `Memory Index 段不再出现;plan-mode 提示词里的 memory_* 字样消失。重启 REPL 后工具表完全不出现。`;
        layout.contentWrite(`${note}\n`);
        layout.contentWrite(
          `${ui.dim}(写入 ${CONFIG_PATH}:MEMORY_ENABLED=${nextEnabled ? 'true' : 'false'};${ui.reset}` +
            (process.env.MEMORY_ENABLED
              ? `${ui.dim}同 session shell 未 export,文件写入即时生效)${ui.reset}\n`
              : `${ui.dim}下次启动仍生效)${ui.reset}\n`)
        );
        // 即时刷 banner(原地替换顶部 bannerH 行,不留副本):banner() 闭包实时读
        // isMemoryEnabled(),无需重启 REPL。buffer 中 bannerH 之下的对话历史位置不动。
        layout.rewriteBanner(bannerLines(banner()));
      } catch (e) {
        layout.contentWrite(`${ui.red}/memory_switch 失败:${ui.reset} ${(e as Error).message}\n`);
      }
      continue;
    }

    const bubbleRows = input.length + 2 + pendingAttachments.length; // N 行 message + 2 行尾随空(含 \n\n 留下的 open current 行) + 每附件 1 行
    const shouldCommit = await awaitPendingRecall(input, pendingAttachments.length, placeholder);
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
