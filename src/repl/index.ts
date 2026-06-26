import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { runAgent } from '../agent/index.js';
import { ui } from '../ui/theme.js';
import { clearScreen, printBanner } from '../ui/render.js';
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

/** /context 的用量条:优先用上次 chat() 返回的实测 usage,否则用启发式估算。 */
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

/**
 * 交互式 REPL:readline 循环 + /exit /clear /think /compact /context /resume /rollback。
 * history 由本模块持有,在轮次间持久;agent 只读取并追加(+ 经 session/ 压缩)。
 * 每轮成功结束后自动落盘,退出后可用 --resume / /resume 续接。
 */
export async function startRepl(
  initialHistory?: ChatMessage[],
  sessionId?: string
): Promise<void> {
  clearScreen(); // 进入即清屏:抹掉之前的终端输出,只留本次会话

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

  printBanner(banner());

  /**
   * 回滚子流程(由 /rollback 命令触发;仿 /resume 用 rl.question 子提问)。
   * rl.question 的 prompt 必须纯文本(无 ANSI):readline 按字符数算光标,颜色码会让
   * 光标错位漂移。故文件信息先 stdout.write 嵌入颜色打一行,prompt 只留纯文本问句。
   * preselect 给定时(/rollback N)跳过选轮提问,直接进文件保留/撤销。
   */
  const rollbackFlow = async (preselect?: number): Promise<void> => {
    const turnList = listTurns();
    if (turnList.length < 2) {
      stdout.write(`${ui.dim}(没有可回滚的轮次,至少需 2 轮)${ui.reset}\n`);
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
      stdout.write(`${ui.brightCyan}回滚到第几轮?(之后对话将被删除)${ui.reset}\n`);
      turnList.forEach((t, i) => {
        stdout.write(`  ${ui.dim}${i + 1}${ui.reset}  ${t.firstLine}\n`);
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
      stdout.write(
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
          stdout.write(`${ui.dim}  (无快照,无法撤销——保留)${ui.reset}\n`);
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
    clearScreen();
    printBanner(banner());
    stdout.write(
      `${ui.dim}(已回滚到第 ${n} 轮,之后 ${r.deletedMsgs} 条消息已删除${r.revertedFiles.length ? `,${r.revertedFiles.length} 个文件已撤销` : ''})${ui.reset}\n`
    );
  };

  while (true) {
    let input: string | null = null;
    try {
      input = await promptWithSlashMenu({
        prompt: PROMPT,
        commands: SLASH_COMMANDS,
      });
    } catch {
      break; // Ctrl+C(SIGINT)/ 异常 → 退出
    }
    if (input === null) break; // 空 prompt Ctrl+D
    const line = input.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/clear') {
      history.length = 1; // 保留 system 提示
      collapsedThinkings.length = 0; // 同步清空折叠的思考段
      resetState(); // 同步清空回滚轮次/快照
      currentSessionId = undefined; // 下轮起新会话文件
      contextState.lastUsage = undefined;
      clearScreen();
      printBanner(banner());
      stdout.write(`${ui.dim}(历史已清空,保留系统提示)${ui.reset}\n`);
      continue;
    }
    if (line === '/context') {
      stdout.write(`  ${renderContextBar(history)}\n`);
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
        stdout.write(`${ui.dim}(无需压缩:没有可压缩的旧消息)${ui.reset}\n`);
      }
      continue;
    }
    if (line === '/resume') {
      const sessions = listSessions();
      if (sessions.length === 0) {
        stdout.write(`${ui.dim}(没有已保存的会话)${ui.reset}\n`);
        continue;
      }
      sessions.forEach((s, i) => {
        stdout.write(
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
        stdout.write(`${ui.yellow}(加载失败)${ui.reset}\n`);
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
      clearScreen();
      printBanner(banner());
      stdout.write(`${ui.dim}(已续接会话 ${loaded.id})${ui.reset}\n`);
      continue;
    }
    if (line === '/think' || line.startsWith('/think ')) {
      const arg = line.split(/\s+/)[1];
      if (!arg) {
        stdout.write(
          `${ui.dim}折叠思考段: ${collapsedThinkings.length} 段  ·  用法: /think N (展开第 N 段)${ui.reset}\n`
        );
        continue;
      }
      const idx = Number(arg);
      if (!Number.isInteger(idx) || idx < 1 || idx > collapsedThinkings.length) {
        stdout.write(
          `${ui.yellow}无第 ${arg} 段(共 ${collapsedThinkings.length})${ui.reset}\n`
        );
        continue;
      }
      const content = collapsedThinkings[idx - 1];
      stdout.write(`${ui.dim}▎ 思考 ▾ (第 ${idx} 段)${ui.reset}\n`);
      stdout.write(`${ui.dim}${content}${ui.reset}\n`);
      if (!content.endsWith('\n')) stdout.write('\n');
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
      await runAgent(history, line, collapsedThinkings);
      // 成功轮次自动落盘(崩溃也保住上一轮);新会话首轮分配 id
      if (!currentSessionId) currentSessionId = newSessionId();
      try {
        saveSession(history, currentSessionId);
      } catch {
        // 落盘失败不阻断 REPL
      }
      persistSnapshots(currentSessionId); // 随会话落盘回滚快照(/resume 后仍可撤销)
    } catch (e) {
      stdout.write(
        `${ui.red}[错误]${ui.reset} ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
    stdout.write('\n'); // 轮次之间空一行
  }
}
