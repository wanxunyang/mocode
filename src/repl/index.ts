import readline from 'node:readline/promises';
import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { runAgent } from '../agent/index.js';
import { ui } from '../ui/theme.js';
import { bannerString, displayWidth } from '../ui/render.js';
import * as layout from '../ui/layout.js';
import { promptWithSlashMenu } from '../ui/prompt.js';
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
  { name: '/compact', desc: '压缩历史(可带焦点 /compact …)' },
  { name: '/resume', desc: '续接已保存的会话' },
  { name: '/think', desc: '展开折叠思考段(/think N)' },
  { name: '/rollback', desc: '回滚到第 N 轮(/rollback N)' },
];

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
    case '/clear':
      return { status: '清空', placeholder: '…' };
    default:
      return { status: '处理', placeholder: '思考中… Ctrl+C 中断' };
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

/** 把多行提交输入回显进内容区(❯ 首行,续行按 prompt 宽度缩进)。仅 TUI 态回显(非 TTY 由 readline 自带回显)。 */
function echoInput(lines: string[]): void {
  if (!layout.isActive()) return;
  const indent = ' '.repeat(displayWidth(PROMPT));
  const echo =
    lines.map((l, i) => (i === 0 ? `${PROMPT}${l}` : `${indent}${l}`)).join('\n') +
    '\n';
  layout.contentWrite(echo);
}

/**
 * 交互式 REPL:全屏 TUI(alt screen + 固定底栏)。INPUT 态底栏=状态行+输入框(raw mode 等按键);
 * 提交后 enterRunningMode(底栏改 dim 占位、光标回内容续写位),命令分发与 runAgent 的流式输出经
 * contentWrite 落入内容区(滚动区域内自动滚动,底栏不动)。history 由本模块持有,在轮次间持久;
 * agent 只读取并追加(+ 经 session/ 压缩)。每轮成功结束后自动落盘,退出后可用 --resume / /resume 续接。
 */
export async function startRepl(
  initialHistory?: ChatMessage[],
  sessionId?: string
): Promise<void> {
  // 有预加载(--resume)则用它,并把 history[0] 刷成当前 system prompt(config 可能已变);
  // 否则新会话只塞 system 提示。
  const history: ChatMessage[] =
    initialHistory && initialHistory.length
      ? initialHistory
      : [{ role: 'system', content: config.systemPrompt }];
  if (
    initialHistory &&
    initialHistory.length &&
    history[0]?.role === 'system'
  ) {
    history[0] = { role: 'system', content: config.systemPrompt };
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

  // 开场:进 alt screen + 状态基线 + 清内容区 + 横幅进内容区
  layout.enterAltScreen();
  refreshStatusBase(history);
  layout.clearContent();
  layout.contentMode();
  layout.contentWrite(bannerString(banner()));

  /**
   * 回滚子流程(由 /rollback 命令触发;仿 /resume 用 rl.question 子提问)。
   * rl.question 的 prompt 必须纯文本(无 ANSI)。运行态下光标已在内容续写位,readline 在此写提问 + 回显。
   * preselect 给定时(/rollback N)跳过选轮提问,直接进文件保留/撤销。
   */
  const rollbackFlow = async (preselect?: number): Promise<void> => {
    const turnList = listTurns();
    if (turnList.length < 2) {
      layout.contentWrite(`${ui.dim}(没有可回滚的轮次,至少需 2 轮)${ui.reset}\n`);
      return;
    }
    let n = 0;
    if (
      preselect !== undefined &&
      Number.isInteger(preselect) &&
      preselect >= 1 &&
      preselect < turnList.length
    ) {
      n = preselect;
    } else {
      layout.contentWrite(`${ui.brightCyan}回滚到第几轮?(之后对话将被删除)${ui.reset}\n`);
      turnList.forEach((t, i) => {
        layout.contentWrite(
          `  ${ui.dim}${i + 1}${ui.reset}  ${t.firstLine}\n`
        );
      });
      let pick = '';
      try {
        pick = (await askLine('序号(回车取消): ')).trim();
      } catch {
        return;
      }
      const nn = Number(pick);
      if (!pick || !Number.isInteger(nn) || nn < 1 || nn >= turnList.length) return;
      n = nn;
    }
    const plan = planRollback(n, history);
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
    const r = applyRollback(plan, history, revertPaths);
    if (!currentSessionId) currentSessionId = newSessionId();
    try {
      saveSession(history, currentSessionId);
    } catch {
      // 落盘失败不阻断
    }
    persistSnapshots(currentSessionId);
    layout.clearContent();
    layout.contentWrite(bannerString(banner()));
    layout.contentWrite(
      `${ui.dim}(已回滚到第 ${n} 轮,之后 ${r.deletedMsgs} 条消息已删除${r.revertedFiles.length ? `,${r.revertedFiles.length} 个文件已撤销` : ''})${ui.reset}\n`
    );
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
        // 上一轮运行中 typeahead 打的字 → 预填进输入框,用户可改可发
        ...(runningInput ? { initialLines: [runningInput] } : {}),
      });
    } catch {
      break; // Ctrl+C(SIGINT)/ 异常 → 退出
    }
    runningInput = ''; // 预填已消费,清空(下轮运行态从空开始)
    if (input === null) break; // 空 prompt Ctrl+D

    const joined = input.join('\n');
    const line = joined.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;

    // RUNNING 态:回显输入 → 底栏改 dim 占位、光标回内容续写位
    echoInput(input);
    const cmd = line.split(/\s+/)[0];
    const { status, placeholder } = runningStateFor(cmd);
    refreshStatusBase(history);
    layout.enterRunningMode(status, placeholder);

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
      const sessions = listSessions();
      if (sessions.length === 0) {
        layout.contentWrite(`${ui.dim}(没有已保存的会话)${ui.reset}\n`);
        continue;
      }
      sessions.forEach((s, i) => {
        layout.contentWrite(
          `  ${ui.dim}${i + 1}${ui.reset}  ${s.id}  ${ui.cyan}${s.firstUser || '(无)'}${ui.reset}  ${ui.dim}${s.model}${ui.reset}\n`
        );
      });
      let pick = '';
      try {
        pick = (await askLine('序号(回车取消): ')).trim();
      } catch {
        continue;
      }
      const idx = Number(pick);
      if (!pick || !Number.isInteger(idx) || idx < 1 || idx > sessions.length)
        continue;
      const loaded = loadSession(sessions[idx - 1].id);
      if (!loaded || !loaded.history.length) {
        layout.contentWrite(`${ui.yellow}(加载失败)${ui.reset}\n`);
        continue;
      }
      if (loaded.history[0]?.role === 'system') {
        loaded.history[0] = { role: 'system', content: config.systemPrompt };
      }
      history.length = 0;
      history.push(...loaded.history);
      currentSessionId = loaded.id;
      // 读回该会话的轮次/快照;无文件则从 history 重建 turns(无快照→旧轮次文件改动不可撤销)
      if (!loadSnapshots(loaded.id)) rebuildFromHistory(history);
      contextState.lastUsage = undefined;
      collapsedThinkings.length = 0;
      layout.clearContent();
      layout.contentWrite(bannerString(banner()));
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
      // /rollback [N]:回滚到第 N 轮(删其后对话 + 逐项保留/撤销被删轮次的文件改动)。
      // 给 N 则跳过选轮提问;不给或非法则交互选。无快照的旧轮次(/resume 重建)文件改动不可撤销。
      const arg = line.slice('/rollback'.length).trim();
      const pre = arg ? Number(arg) : NaN;
      await rollbackFlow(Number.isInteger(pre) ? pre : undefined);
      continue;
    }

    try {
      const signal = startRunningListener(placeholder);
      await runAgent(history, joined, collapsedThinkings, signal);
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
