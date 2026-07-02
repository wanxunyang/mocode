import readline from 'node:readline/promises';
import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config, PLAN_MODE_SUFFIX } from '../config/index.js';
import { updateConfigKey } from '../config/file.js';
import { runAgent } from '../agent/index.js';
import { getAgentMode, setAgentMode, onModeChange } from '../agent/mode.js';
import { setSandboxRoot } from '../sandbox/root.js';
import { ui, setTheme, getTheme, listThemes, themeExists } from '../ui/theme.js';
import { bannerString, displayWidth, padEndDisplay, summarizeToolCall, summarizeToolResult } from '../ui/render.js';
import * as layout from '../ui/layout.js';
import * as mouse from '../ui/mouse.js';
import {
  promptWithSlashMenu,
  promptTurnPicker,
  promptSessionPicker,
  promptThemePicker,
  promptRevertChoice,
  type SessionPickerItem,
} from '../ui/prompt.js';
import { promptIntervention } from '../ui/intervention.js';
import { tools } from '../tools/registry.js';
import {
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  type ChatMessage,
} from '../llm/index.js';
import {
  compactHistory,
  contextState,
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
} from '../session/index.js';
import {
  listTurns,
  planRollback,
  applyRollback,
  persistSnapshots,
  loadSnapshots,
  rebuildFromHistory,
  resetState,
} from '../rollback/index.js';
import { listSkills, effectiveSystemPrompt } from '../skills/index.js';
import {
  buildMemorySection,
  buildMemoryIndexSection,
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
  loadAll,
} from '../memory/index.js';

/**
 * readline 的 prompt 必须是纯文本(无 ANSI):readline 按字符数算光标位置,
 * 颜色码会让光标错位、编辑时漂移。颜色只用在直接 stdout.write 的横幅 / 工具行 / 回复。
 */
const PROMPT = '❯ ';

/** 斜杠命令菜单(仅用于输入时下拉显示与过滤;分发仍走下方 if 链)。 */
const SLASH_COMMANDS: { name: string; desc: string }[] = [
  { name: '/exit', desc: '退出 mocode(同 /quit)' },
  { name: '/clear', desc: '清空历史(保留系统提示)' },
  { name: '/context', desc: '显示上下文用量条' },
  { name: '/skills', desc: '列出已发现的 skill' },
  { name: '/compact', desc: '压缩历史(可带焦点 /compact …)' },
  { name: '/resume', desc: '续接已保存的会话' },
  { name: '/rollback', desc: '菜单选轮次回滚(↑↓·Enter)' },
  { name: '/memory', desc: '记忆库:条目计数与近期索引' },
  { name: '/reflect', desc: '手动触发后台记忆反思 pass' },
  { name: '/init', desc: '扫描项目生成 MOCODE.md 项目记忆' },
  { name: '/theme', desc: '切换颜色主题(↑↓·Enter)' },
  { name: '/plan', desc: '切到 plan 模式(只读探查+产出计划)' },
  { name: '/auto', desc: '切回 auto 模式(全工具执行)' },
];

/** 主题名 → 一句描述(供 /theme 菜单 / 列表显示)。新增主题时在 src/ui/theme.ts THEMES 加键后于此补一句。 */
const THEME_DESCRIPTIONS: Record<string, string> = {
  default: '16 色原版(深底)',
  light: '浅底终端',
  solarized: 'Solarized 强调色',
  gruvbox: 'Gruvbox 暖色',
  nord: 'Nord 冷色',
};

/**
 * /init 指令:发给 agent 扫描项目并生成 MOCODE.md(对标 Claude Code /init 生成 CLAUDE.md,
 * 但 mocode 读 MOCODE.md)。已存在则让 agent 读后更新(不丢失事实)。写完供 memory 子系统下轮加载。
 */
const INIT_PROMPT = `分析当前项目(process.cwd()),生成 MOCODE.md 项目记忆文件,供 mocode 后续会话自动加载——目标是让后续会话无需重新摸索就能上手。

先探查(尽量少调用拿全貌):
- 若有 .codegraph/:用 codegraph 工具(explore "<架构或入口符号>")一次拿相关源码+调用路径,别逐文件读！！！
- read_file package.json(或 Cargo.toml/pyproject.toml/go.mod 等):scripts、依赖、入口、模块类型。
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
- 总长 ≤ 1500 字;只写后续会话有用的稳定事实,不写易变项(当前 bug、临时文件、未决 TODO)。
- 用 write_file 写入项目根 MOCODE.md。
- 写完简述:写了哪几节 + 从代码里发现的 2-3 条非显然关键约定(供用户校验)。`;

/** 临时 readline 读一行(cooked,用于子提问;主输入走 promptWithSlashMenu)。 */
async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** /context 的用量条(详情版,进内容区):优先用上次 chat() 返回的实测 usage,否则用启发式估算。 */
function renderContextBar(history: ChatMessage[]): string {
  const schema = estimateToolSchemaTokens();
  const est =
    contextState.lastUsage?.totalTokens ??
    estimateMessagesTokens(history) + schema;
  const win = config.contextWindowTokens;
  const pct = Math.min(1, est / win);
  const W = 10;
  const filled = Math.round(pct * W);
  const bar =
    filled === 0 ? ' '.repeat(W) : '█'.repeat(filled) + '░'.repeat(W - filled);
  const src = contextState.lastUsage ? '实测' : '估算';
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= config.compactThreshold ? ui.yellow : ui.cyan;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${Math.round(pct * 100)}%  ${k(est)}/${k(win)} tokens · ${history.length} 条消息 (${src})${ui.reset}`;
}

/** 状态行用量条(精简版,进底栏):[bar] pct% k/k。 */
function renderContextBarInline(history: ChatMessage[]): string {
  const schema = estimateToolSchemaTokens();
  const est =
    contextState.lastUsage?.totalTokens ??
    estimateMessagesTokens(history) + schema;
  const win = config.contextWindowTokens;
  const pct = Math.min(1, est / win);
  const W = 10;
  const filled = Math.round(pct * W);
  const bar =
    filled === 0 ? ' '.repeat(W) : '█'.repeat(filled) + '░'.repeat(W - filled);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= config.compactThreshold ? ui.yellow : ui.cyan;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${pctCol}${Math.round(pct * 100)}%${ui.reset} ${ui.dim}${k(est)}/${k(win)}${ui.reset}`;
}

/** 状态行基线:模型 / context / cwd / 模式标识。repl 在轮次边界与切模式时调,刷新 context 用量与 mode chip。 */
function refreshStatusBase(history: ChatMessage[]): void {
  layout.setStatusBase({
    model: config.model,
    contextBar: renderContextBarInline(history),
    cwd: process.cwd(),
    modeTag: getAgentMode() === 'plan' ? 'plan' : 'auto',
  });
}

/** 命令 → 运行态状态文字 + 底栏 dim 占位。 */
function runningStateFor(
  cmd: string
): { status: string; placeholder: string } {
  switch (cmd) {
    case '/compact':
      return { status: '压缩', placeholder: '压缩中…' };
    case '/resume':
      return { status: '续接', placeholder: '选择会话…' };
    case '/rollback':
      return { status: '回滚', placeholder: '选择轮次…' };
    case '/init':
      return { status: '初始化', placeholder: '生成 MOCODE.md…' };
    case '/plan':
      return { status: '切 plan', placeholder: '…' };
    case '/auto':
      return { status: '切 auto', placeholder: '…' };
    case '/clear':
      return { status: '清空', placeholder: '…' };
    case '/theme':
      return { status: '切主题', placeholder: '选择主题…' };
    default:
      // 输入框留空(运行中可 typeahead 打字,dim 回显);运行状态由内联 spinner 承载(思考中/执行…),
      // 状态行只显走时——故常态 status 留空,不塞「处理」这种与内联重复的泛标签。
      // 不把「思考中… Ctrl+C 中断」塞进输入框占位——避免看起来像已有输入、妨碍正常输入。
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
let runningPlaceholder = '';
let currentAbort: AbortController | null = null;
let pendingPrefill: string[] | null = null; // /rollback 选中后预填的 user 输入(下轮 INPUT 态消费)
// agent 模式状态已提到 src/agent/mode.ts(共享叶子:switch_mode 工具可写、agent 每步读、repl 注册 onModeChange 监听器)。

/** 运行态按键:滚动优先,再 Ctrl+C 中断,再 typeahead 编辑(单行,Enter=无操作)。 */
function onRunningKey(_str: string, key?: Key): void {
  if (!key) return;
  // SGR 鼠标滚轮:readline 把 \x1B[<btn;col;rowM 拆成多 fragment,经 mouse.consumeMouse 重组;
  // 滚轮 → scrollBy(±5)(不调 setUserActive——与键盘滚动一致;流式 flushTimer 在 scrollOffset>0 时不重画,安全)。
  const _m = mouse.consumeMouse(key.sequence ?? '');
  if (_m.suppress) {
    if (_m.wheel) layout.scrollBy(_m.wheel * 5);
    return;
  }
  // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页,↑/↓ 每次 5 行(键盘;鼠标滚轮已由上方守卫处理)。
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
      layout.paintRunningInputEcho(runningInput, runningPlaceholder);
    } else {
      currentAbort?.abort();
    }
    return;
  }
  const s = key.sequence ?? '';
  if (key.name === 'backspace') {
    if (runningInput.length > 0) {
      runningInput = runningInput.slice(0, -1);
      layout.paintRunningInputEcho(runningInput, runningPlaceholder);
    }
    return;
  }
  if (key.name === 'escape') {
    runningInput = '';
    layout.paintRunningInputEcho(runningInput, runningPlaceholder);
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
  // 可打印字符(>= 空格,非 ctrl/meta)→ 追加 + dim 回显
  if (s && s >= ' ' && !key.ctrl && !key.meta) {
    runningInput += s;
    layout.paintRunningInputEcho(runningInput, runningPlaceholder);
  }
}

/** 进入运行态:挂 keypress 监听 + raw mode + 新建 abort 控制器,返回其 signal。在 await runAgent 前、enterRunningMode 后调。 */
function startRunningListener(placeholder: string): AbortSignal {
  runningPlaceholder = placeholder;
  runningInput = '';
  emitKeypressEvents(stdin); // 幂等:首轮 prompt 已永久挂解析器,这里防御性再调
  try {
    stdin.setRawMode(true);
  } catch {
    // 非 TTY / 不支持 raw:监听器仍挂(按键可能不来,不影响 agent)
  }
  stdin.resume();
  emitter.on('keypress', onRunningKey);
  const ac = new AbortController();
  currentAbort = ac;
  return ac.signal;
}

/** 退出运行态:摘监听 + 清 abort。不 pause / 不 setRawMode(false)——紧接着 promptWithSlashMenu 自己接管 raw。 */
function stopRunningListener(): void {
  emitter.off('keypress', onRunningKey);
  currentAbort = null;
}

/**
 * 把用户消息格式化为带满宽背景色的文本(上滑时易辨认用户消息)。
 * 每行用 padEndDisplay 填充到终端宽度(含 ❯ / 缩进),背景色 SGR 包裹整行 + 行末 reset。
 * 满宽 pad 使终端背景色覆盖整行(含行尾空单元格),上滑滚动时用户消息呈连续色块、与 assistant 正文区分。
 * 末尾多留一空行(\n\n 收尾):用户消息与后续(agent 流式输出 / 下条消息)之间空一行,仿 Claude Code。
 */
function formatUserMessage(lines: string[]): string {
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
      .join('\n') + '\n\n'
  );
}

/** 把多行提交输入回显进内容区(❯ 首行,续行按 prompt 宽度缩进)。仅 TUI 态回显(非 TTY 由 readline 自带回显)。 */
function echoInput(lines: string[]): void {
  if (!layout.isActive()) return;
  layout.contentWrite(formatUserMessage(lines));
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

/**
 * 把会话历史渲染成静态文本进内容区(回滚 / 续接 / --resume 后复显上下文,仿 Claude Code):
 * user→❯ 回显、assistant→正文(+ tool_calls 作 ● 行)、tool→↳ 结果预览;system 跳过。
 * 思考段不持久(history 只存正文),故无思考折叠。渲染后续写位在末尾,紧接 enterInputMode 画输入框。
 * 内容长于屏时 viewport 显尾(最近轮次),PgUp 可看更早——与流式态一致。
 */
export function renderHistory(history: ChatMessage[]): void {
  const idToName = new Map<string, string>();
  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const lines = textOf((m as { content?: unknown }).content).split('\n');
      layout.contentWrite(formatUserMessage(lines));
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf((m as { content?: unknown }).content);
      if (text) {
        layout.contentWriteMdOnce(text);
        if (!text.endsWith('\n')) layout.contentWrite('\n');
      }
      const tcs = (m as {
        tool_calls?: {
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      }).tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const name = tc?.function?.name ?? '';
          const args = tc?.function?.arguments ?? '';
          if (tc?.id && name) idToName.set(tc.id, name);
          layout.contentWrite(
            `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}${name}${ui.reset}  ${ui.dim}${summarizeToolCall(name, args)}${ui.reset}\n`
          );
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
      const name = idToName.get(id) ?? '';
      const preview = summarizeToolResult(
        name,
        textOf((m as { content?: unknown }).content)
      );
      if (preview) layout.contentWrite(`  ${ui.gray}↳ ${preview}${ui.reset}\n`);
      continue;
    }
  }
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
  updateNotice: string | null = null,
  sandboxRootOverride?: string
): Promise<void> {
  // 模式重置:agentMode 不落盘,每个 REPL 会话从 auto 开始(/resume / --resume 亦重置)。
  setAgentMode('auto');
  // 沙箱根:文件操作边界。优先级 --sandbox-root > SANDBOX_ROOT env > process.cwd()。
  // 纯边界记录(不 chdir),jail.ts 内部 resolve。子 agent 同进程继承全局 root。
  setSandboxRoot(sandboxRootOverride ?? config.sandboxRoot ?? process.cwd());
  // 构造系统提示:auto 用 base;plan 在 config.systemPrompt 后追加 PLAN_MODE_SUFFIX。
  // 切模式时 applyMode 重算 history[0](history[0] 恒 system,compaction 保它,不破坏)。
  const buildSystemMessage = (planMode: boolean): string =>
    effectiveSystemPrompt(
      config.systemPrompt +
        (planMode ? PLAN_MODE_SUFFIX : '') +
        buildMemorySection() +
        buildMemoryIndexSection(),
    );
  // 有预加载(--resume)则用它,并把 history[0] 刷成当前 system prompt(config 可能已变);
  // 否则新会话只塞 system 提示(默认 auto)。
  const history: ChatMessage[] =
    initialHistory && initialHistory.length
      ? initialHistory
      : [{ role: 'system', content: buildSystemMessage(false) }];
  if (
    initialHistory &&
    initialHistory.length &&
    history[0]?.role === 'system'
  ) {
    history[0] = { role: 'system', content: buildSystemMessage(false) };
  }
  // --resume:读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
  if (sessionId && initialHistory && initialHistory.length) {
    if (!loadSnapshots(sessionId)) rebuildFromHistory(history);
  }
  let currentSessionId: string | undefined = sessionId;
  // 反思 cadence 计数:每 reflectEveryN 轮 fire-and-forget 一次后台反思 pass。
  let turnCount = 0;

  const toolsLine = tools.map((t) => t.name).join(' · ');
  const banner = () => ({
    model: config.model,
    baseURL: config.baseURL,
    cwd: process.cwd(),
    tools: toolsLine,
  });

  // 开场:按 config.theme 切主题(横幅 / 状态行 / 后续渲染皆用新色),再进 alt screen + 状态基线 + 清内容区。
  // --resume 有历史则渲染对话(仿 Claude Code),否则横幅。
  setTheme(config.theme);
  layout.enterAltScreen();
  refreshStatusBase(history);
  layout.clearContent();
  layout.contentMode();
  if (history.some((m) => m.role === 'user')) {
    renderHistory(history);
  } else {
    layout.contentWrite(bannerString(banner()));
  }
  if (updateNotice) {
    // 自更新提示:开场静态段(进 INPUT 态前),dim 一行,不与流式 / 输入争用。
    layout.contentWrite(`  ${ui.gray}↳ ${updateNotice}${ui.reset}\n`);
  }
  layout.contentWrite(
    `${ui.dim}  /plan · /auto · Shift+Tab 切换模式(plan:只读探查 + 产出计划,审批后切 auto 执行)${ui.reset}\n`,
  );

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
   * (仿 Claude Code rewind,Enter 重新跑该轮);被删轮次的文件改动走二选一菜单(promptRevertChoice:
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
    applyRollback(plan, history, revertPaths);
    if (!currentSessionId) currentSessionId = newSessionId();
    try {
      saveSession(history, currentSessionId);
    } catch {
      // 落盘失败不阻断
    }
    persistSnapshots(currentSessionId);
    // 复显剩余对话(无提示行),输入框预填该轮 user 输入 → 下轮 Enter 重新跑
    layout.clearContent();
    renderHistory(history);
    pendingPrefill = prefillText.split('\n');
  };

  /**
   * 跑一轮 agent(enterRunningMode 已由调用方完成):startRunningListener → runAgent → autosave / reflect。
   * plan 模式传 planMode=true(runAgent 用 planChatTools 只读子集)。返 ok=正常结束(未中断 / 未抛错),
   * 供调用方决定是否弹审批面板。execute 轮的合成输入也走这里。
   */
  const runTurn = async (
    input: string,
    planMode: boolean,
    placeholder: string,
  ): Promise<boolean> => {
    let ok = false;
    try {
      const signal = startRunningListener(placeholder);
      // 入口设定本轮初始模式(合成执行轮传 false→auto;用户轮传当前 mode)。
      // setAgentMode 触发 listener 重写 history[0];LLM 可在轮中调 switch_mode 切模式,runAgent 每步读实时值。
      setAgentMode(planMode ? 'plan' : 'auto');
      // 运行中每步 chat() 返回后刷新状态行 context 用量条(用 fresh lastUsage / 估算),
      // 否则整轮冻结在轮首 refreshStatusBase 的值,「执行 grep」时 2k/1000k 不动。
      await runAgent(
        history,
        input,
        signal,
        () => {
          refreshStatusBase(history);
          layout.drawStatusBar();
        },
      );
      ok = !signal.aborted; // 中断(Ctrl+C)→ runAgent 已还原 history,ok=false 不弹审批
      // 成功轮次自动落盘(崩溃也保住上一轮);新会话首轮分配 id
      if (!currentSessionId) currentSessionId = newSessionId();
      try {
        saveSession(history, currentSessionId);
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
      layout.contentWrite(
        `${ui.red}[错误]${ui.reset} ${e instanceof Error ? e.message : String(e)}\n`
      );
    } finally {
      stopRunningListener();
    }
    layout.contentWrite('\n'); // 轮次之间空行
    return ok;
  };

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
    layout.enterInputMode('空闲');

    let input: string[] | null = null;
    try {
      input = await promptWithSlashMenu({
        prompt: PROMPT,
        commands: SLASH_COMMANDS,
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
    if (line === '/exit' || line === '/quit') break;

    // RUNNING 态:回显输入 → 底栏改 dim 占位、光标回内容续写位
    echoInput(input);
    const cmd = line.split(/\s+/)[0];
    const { status, placeholder } = runningStateFor(cmd);
    refreshStatusBase(history);
    layout.enterRunningMode(status, placeholder);

    if (line === '/init') {
      // /init:把 init 指令当 user 输入发给 agent(扫描项目 + 生成 MOCODE.md),fall through 走 runAgent
      joined = INIT_PROMPT;
    }
    if (line === '/plan') {
      // /plan:切到 plan 模式(只读探查 + 产出计划)。Shift+Tab 的可靠后备——
      // 中文 IME(微软拼音用 Shift 切中英)与部分终端会吞掉 Shift+Tab 的 \x1b[Z,命令不受影响。
      if (getAgentMode() === 'plan') {
        layout.contentWrite(`${ui.dim}(已在 plan 模式)${ui.reset}\n`);
      } else {
        setAgentMode('plan'); // listener 接手 applyMode + refreshStatusBase
        layout.contentWrite(
          `${ui.dim}(已切到 plan 模式:只读探查 + 产出计划,审批后切 auto 执行。/auto 或 Shift+Tab 切回)${ui.reset}\n`,
        );
      }
      continue;
    }
    if (line === '/auto') {
      if (getAgentMode() === 'auto') {
        layout.contentWrite(`${ui.dim}(已在 auto 模式)${ui.reset}\n`);
      } else {
        setAgentMode('auto'); // listener 接手 applyMode + refreshStatusBase
        layout.contentWrite(`${ui.dim}(已切回 auto 模式:全工具执行)${ui.reset}\n`);
      }
      continue;
    }

    if (line === '/clear') {
      history.length = 1; // 保留 system 提示
      resetState(); // 同步清空回滚轮次/快照
      currentSessionId = undefined; // 下轮起新会话文件
      turnCount = 0; // 反思 cadence 重新计数
      contextState.lastUsage = undefined;
      layout.clearContent();
      layout.contentWrite(bannerString(banner()));
      layout.contentWrite(`${ui.dim}(历史已清空,保留系统提示)${ui.reset}\n`);
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
          `  ${ui.cyan}${e.id}${ui.reset}  ${ui.dim}${e.name} — ${e.summary}${ui.reset}\n`,
        );
      }
      if (active.length === 0)
        layout.contentWrite(`${ui.dim}(无 active 记忆;用 memory_save 存,或 /init 生成 MOCODE.md)${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}(详情用 memory_search;启动索引已注入 systemPrompt)${ui.reset}\n`);
      continue;
    }
    if (line === '/reflect') {
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
            `  ${ui.cyan}${s.name}${ui.reset}  ${ui.dim}${s.description}${ui.reset}\n`
          );
        }
        layout.contentWrite(
          `${ui.dim}(用 use_skill 工具加载某 skill 的完整指令)${ui.reset}\n`
        );
      }
      continue;
    }
    if (line === '/compact' || line.startsWith('/compact ')) {
      const focus = line.startsWith('/compact ')
        ? line.slice('/compact '.length).trim()
        : undefined;
      const r = await compactHistory(history, {
        window: config.contextWindowTokens,
        threshold: config.compactThreshold,
        focus,
      });
      if (r.reason === 'noop') {
        layout.contentWrite(`${ui.dim}(无需压缩:没有可压缩的旧消息)${ui.reset}\n`);
      }
      continue;
    }
    if (line === '/resume') {
      // /resume:打开会话菜单(↑/↓ 选,Enter 续接,Esc 取消)。默认仅最近 10 条,按 a 展开全部。
      // 仿 /rollback 菜单化(promptSessionPicker);选中项 cyan+bold + ▸ 高亮。
      const sessions = listSessions();
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
      if (!pick) continue; // Esc / Ctrl+D 取消
      const loaded = loadSession(pick.id);
      if (!loaded || !loaded.history.length) {
        layout.contentWrite(`${ui.yellow}(加载失败)${ui.reset}\n`);
        continue;
      }
      if (loaded.history[0]?.role === 'system') {
        loaded.history[0] = { role: 'system', content: buildSystemMessage(false) };
      }
      history.length = 0;
      history.push(...loaded.history);
      setAgentMode('auto'); // /resume 重置为 auto(mode 不落盘;listener 重写 history[0] 回 auto,与 loaded 幂等)
      currentSessionId = loaded.id;
      // 读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
      if (!loadSnapshots(loaded.id)) rebuildFromHistory(history);
      contextState.lastUsage = undefined;
      layout.clearContent();
      renderHistory(history);
      layout.contentWrite(`${ui.dim}(已续接会话 ${loaded.id})${ui.reset}\n`);
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
          subtitle: THEME_DESCRIPTIONS[t] ?? '',
        }));
        let pick: SessionPickerItem | null;
        try {
          pick = await promptThemePicker(items);
        } catch {
          continue; // Ctrl+C(SIGINT)→ 取消
        }
        name = pick?.id ?? null;
      } else if (arg === 'list' || !themeExists(arg)) {
        layout.contentWrite(`${ui.dim}可用主题:${ui.reset}\n`);
        for (const t of listThemes()) {
          layout.contentWrite(
            `  ${ui.cyan}${t}${ui.reset}  ${ui.dim}${THEME_DESCRIPTIONS[t] ?? ''}${ui.reset}\n`
          );
        }
        layout.contentWrite(
          `${ui.dim}(当前:${getTheme()};用 /theme <名称> 切换)${ui.reset}\n`
        );
        continue;
      } else {
        name = arg;
      }
      if (name === null) continue; // Esc / Ctrl+D 取消
      // 切:setTheme → 重算状态行(新色)→ 清内容重绘(历史 / 横幅,镜像启动 + /resume)→ 确认 → 持久化。
      // markdown MEMO 按 themeVersion 自动失效,故 renderHistory 取新色;状态栏 / 输入框由 continue 回 INPUT 态时读 getter 刷。
      setTheme(name);
      refreshStatusBase(history);
      layout.clearContent();
      if (history.some((m) => m.role === 'user')) {
        renderHistory(history);
      } else {
        layout.contentWrite(bannerString(banner()));
      }
      layout.contentWrite(`${ui.dim}(已切换主题 ${name})${ui.reset}\n`);
      updateConfigKey('MOCODE_THEME', name);
      if (config.themeFromShell) {
        layout.contentWrite(
          `${ui.dim}(shell 环境变量 MOCODE_THEME 已设,文件写入下次启动被其覆盖;取消该 shell 设置后生效)${ui.reset}\n`
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

    const initialPlan = getAgentMode() === 'plan'; // 轮首模式(在 runTurn 之前读)
    const ok = await runTurn(joined, initialPlan, placeholder);
    // plan 轮正常结束(未中断 / 未抛错)→ 看轮末模式决定:
    //  - 仍 plan:LLM 没自切(只产计划就 STOP)→ 弹审批面板(原行为)。
    //  - 已 auto:LLM 调了 switch_mode('auto') 在同轮自主执行了 → 跳过审批,不重复打扰。
    if (initialPlan && ok && getAgentMode() === 'plan') {
      const res = await promptIntervention({
        type: 'choice',
        title: '计划已就绪',
        detail: '切换到 auto 模式按上述计划执行?(plan 模式只读探查,执行需切 auto)',
        options: ['切 auto 执行', '留 plan 细化'],
      });
      if (res.action === 'selected' && res.value === '切 auto 执行') {
        // setAgentMode('auto') 由 runTurn 入口做(listener 重写 history[0] 回 auto);这里只切运行态 + 合成执行轮。
        layout.enterRunningMode('执行', '按计划执行…');
        await runTurn('请按上述计划执行。', false, '按计划执行…');
      }
    }
  }

  // 退出前等在飞反思收尾(Ctrl+C 走 SIGINT 直退不等;fire-and-forget 不承诺中断时完成)。
  await drainMemoryBackground();
  layout.exitAltScreen();
}
