import readline from 'node:readline/promises';
import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { runAgent } from '../agent/index.js';
import { ui } from '../ui/theme.js';
import { bannerString, displayWidth, padEndDisplay, summarizeToolCall, summarizeToolResult } from '../ui/render.js';
import * as layout from '../ui/layout.js';
import {
  promptWithSlashMenu,
  promptTurnPicker,
  promptSessionPicker,
  type SessionPickerItem,
} from '../ui/prompt.js';
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
import { buildMemorySection } from '../memory/index.js';

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
  { name: '/think', desc: '展开折叠思考段(/think N)' },
  { name: '/rollback', desc: '菜单选轮次回滚(↑↓·Enter)' },
  { name: '/init', desc: '扫描项目生成 MOCODE.md 项目记忆' },
];

/**
 * /init 指令:发给 agent 扫描项目并生成 MOCODE.md(对标 Claude Code /init 生成 CLAUDE.md,
 * 但 mocode 读 MOCODE.md)。已存在则让 agent 读后更新(不丢失事实)。写完供 memory 子系统下轮加载。
 */
const INIT_PROMPT = `分析当前项目(process.cwd()),生成 MOCODE.md 项目记忆文件,供 mocode 后续会话自动加载——目标是让后续会话无需重新摸索就能上手。

先探查(尽量少调用拿全貌):
- read_file package.json(或 Cargo.toml/pyproject.toml/go.mod 等):scripts、依赖、入口、模块类型。
- glob 顶层目录;read_file 入口文件 + 各子系统 index.ts/README。
- 若有 .codegraph/:run_command codegraph explore "<架构或入口符号>" 一次拿相关源码+调用路径,别逐文件读。
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
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
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
  const bar = '█'.repeat(filled) + '░'.repeat(W - filled);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const pctCol = pct >= config.compactThreshold ? ui.yellow : ui.cyan;
  return `${ui.gray}[${pctCol}${bar}${ui.reset}] ${pctCol}${Math.round(pct * 100)}%${ui.reset} ${ui.dim}${k(est)}/${k(win)}${ui.reset}`;
}

/** 状态行基线:模型 / context / cwd。repl 在轮次边界调,刷新 context 用量。 */
function refreshStatusBase(history: ChatMessage[]): void {
  layout.setStatusBase({
    model: config.model,
    contextBar: renderContextBarInline(history),
    cwd: process.cwd(),
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
    case '/clear':
      return { status: '清空', placeholder: '…' };
    default:
      // 输入框留空(运行中可 typeahead 打字,dim 回显);运行状态由状态行 spinner 承载,
      // 不再把「思考中… Ctrl+C 中断」塞进输入框占位——避免看起来像已有输入、妨碍正常输入。
      return { status: '处理', placeholder: '' };
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

/** 运行态按键:滚动优先,再 Ctrl+C 中断,再 typeahead 编辑(单行,Enter=无操作)。 */
function onRunningKey(_str: string, key?: Key): void {
  if (!key) return;
  // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页,↑/↓ 单行(含鼠标滚轮——alt 屏滚轮转发↑↓)。
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
    else if (key.name === 'up') layout.scrollBy(1);
    else layout.scrollBy(-1);
    return;
  }
  // 其他键:若处于滚动回看,先回尾再处理(打字即回底)
  if (layout.isScrolled()) layout.resetScroll();
  // Ctrl+C 中断当前 agent 轮次(不退进程;raw 模式下 Ctrl+C 是按键,不触发 SIGINT)
  if (key.ctrl && key.name === 'c') {
    currentAbort?.abort();
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
      .join('\n') + '\n'
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
        layout.contentWrite(text);
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
  updateNotice: string | null = null
): Promise<void> {
  // 有预加载(--resume)则用它,并把 history[0] 刷成当前 system prompt(config 可能已变);
  // 否则新会话只塞 system 提示。
  const systemPrompt = effectiveSystemPrompt(config.systemPrompt + buildMemorySection());
  const history: ChatMessage[] =
    initialHistory && initialHistory.length
      ? initialHistory
      : [{ role: 'system', content: systemPrompt }];
  if (
    initialHistory &&
    initialHistory.length &&
    history[0]?.role === 'system'
  ) {
    history[0] = { role: 'system', content: systemPrompt };
  }
  // --resume:读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
  if (sessionId && initialHistory && initialHistory.length) {
    if (!loadSnapshots(sessionId)) rebuildFromHistory(history);
  }
  let currentSessionId: string | undefined = sessionId;

  // 本会话累积的折叠思考段,供 /think N 重打原文。
  const collapsedThinkings: string[] = [];

  const toolsLine = tools.map((t) => t.name).join(' · ');
  const banner = () => ({
    model: config.model,
    baseURL: config.baseURL,
    cwd: process.cwd(),
    tools: toolsLine,
  });

  // 开场:进 alt screen + 状态基线 + 清内容区。--resume 有历史则渲染对话(仿 Claude Code),否则横幅。
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

  /**
   * 回滚子流程(由 /rollback 触发):菜单(↑/↓)选轮次 → 选中第 X 轮 = 删第 X 轮及之后 + 预填第 X 轮 user 输入
   * (仿 Claude Code rewind,Enter 重新跑该轮);被删轮次的文件改动仍逐个「保留/撤销」询问(cooked readline)。
   * 选轮菜单走 promptTurnPicker(raw mode);文件询问走 askLine(cooked)。预填经 pendingPrefill 注入下轮 INPUT。
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
    for (const c of plan.changes) {
      layout.contentWrite(
        `  ${ui.cyan}${c.path}${ui.reset} ${ui.dim}(${c.ops.join(', ')})${ui.reset}\n`
      );
      let ans = '';
      try {
        ans = (await askLine('  保留/撤销 [k/u](回车=保留): ')).trim();
      } catch {
        continue;
      }
      if (ans.startsWith('u') || ans.startsWith('U')) {
        if (c.snapshotAvailable) {
          revertPaths.add(c.path);
        } else {
          layout.contentWrite(`${ui.dim}  (无快照,无法撤销——保留)${ui.reset}\n`);
        }
      }
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

  while (true) {
    // INPUT 态:画底栏输入框 + 状态行,光标入输入框
    refreshStatusBase(history);
    layout.enterInputMode('空闲');

    let input: string[] | null = null;
    try {
      input = await promptWithSlashMenu({
        prompt: PROMPT,
        commands: SLASH_COMMANDS,
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

    if (line === '/clear') {
      history.length = 1; // 保留 system 提示
      collapsedThinkings.length = 0; // 同步清空折叠的思考段
      resetState(); // 同步清空回滚轮次/快照
      currentSessionId = undefined; // 下轮起新会话文件
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
        loaded.history[0] = { role: 'system', content: systemPrompt };
      }
      history.length = 0;
      history.push(...loaded.history);
      currentSessionId = loaded.id;
      // 读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
      if (!loadSnapshots(loaded.id)) rebuildFromHistory(history);
      contextState.lastUsage = undefined;
      collapsedThinkings.length = 0;
      layout.clearContent();
      renderHistory(history);
      layout.contentWrite(`${ui.dim}(已续接会话 ${loaded.id})${ui.reset}\n`);
      continue;
    }
    if (line === '/think' || line.startsWith('/think ')) {
      const arg = line.split(/\s+/)[1];
      if (!arg) {
        layout.contentWrite(
          `${ui.dim}折叠思考段: ${collapsedThinkings.length} 段  ·  用法: /think N (展开第 N 段)${ui.reset}\n`
        );
        continue;
      }
      const idx = Number(arg);
      if (!Number.isInteger(idx) || idx < 1 || idx > collapsedThinkings.length) {
        layout.contentWrite(
          `${ui.yellow}无第 ${arg} 段(共 ${collapsedThinkings.length})${ui.reset}\n`
        );
        continue;
      }
      const content = collapsedThinkings[idx - 1];
      layout.contentWrite(`${ui.dim}▎ 思考 ▾ (第 ${idx} 段)${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}${content}${ui.reset}\n`);
      if (!content.endsWith('\n')) layout.contentWrite('\n');
      continue;
    }
    if (line === '/rollback' || line.startsWith('/rollback ')) {
      // /rollback:打开轮次菜单(↑/↓ 选,Enter 回滚到该轮并预填其输入,再 Enter 重新跑)。
      // 忽略任何数字参数(原「输数字选回滚」已删,统一走菜单)。无快照的旧轮次(/resume 重建)文件改动不可撤销。
      await rollbackFlow();
      continue;
    }

    try {
      const signal = startRunningListener(placeholder);
      // 运行中每步 chat() 返回后刷新状态行 context 用量条(用 fresh lastUsage / 估算),
      // 否则整轮冻结在轮首 refreshStatusBase 的值,「执行 grep」时 2k/1000k 不动。
      await runAgent(history, joined, collapsedThinkings, signal, () => {
        refreshStatusBase(history);
        layout.drawStatusBar();
      });
      // 成功轮次自动落盘(崩溃也保住上一轮);新会话首轮分配 id
      if (!currentSessionId) currentSessionId = newSessionId();
      try {
        saveSession(history, currentSessionId);
      } catch {
        // 落盘失败不阻断 REPL
      }
      persistSnapshots(currentSessionId); // 随会话落盘回滚快照(/resume 后仍可撤销)
    } catch (e) {
      layout.contentWrite(
        `${ui.red}[错误]${ui.reset} ${e instanceof Error ? e.message : String(e)}\n`
      );
    } finally {
      stopRunningListener();
    }
    layout.contentWrite('\n'); // 轮次之间空行
  }

  layout.exitAltScreen();
}
