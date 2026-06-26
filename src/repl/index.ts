import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { runAgent } from '../agent/index.js';
import { ui } from '../ui/theme.js';
import { clearScreen, printBanner } from '../ui/render.js';
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

/**
 * readline 的 prompt 必须是纯文本(无 ANSI):readline 按字符数算光标位置,
 * 颜色码会让光标错位、编辑时漂移。颜色只用在直接 stdout.write 的横幅 / 工具行 / 回复。
 */
const PROMPT = '❯ ';

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
 * 交互式 REPL:readline 循环 + /exit /clear /think /compact /context /resume。
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
  let currentSessionId: string | undefined = sessionId;

  // 本会话累积的折叠思考段,供 /think N 重打原文。
  const collapsedThinkings: string[] = [];
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const toolsLine = tools.map((t) => t.name).join(' · ');
  const banner = () => ({
    model: config.model,
    baseURL: config.baseURL,
    cwd: process.cwd(),
    tools: toolsLine,
  });

  printBanner(banner());

  while (true) {
    let input = '';
    try {
      input = await rl.question(PROMPT);
    } catch {
      break; // Ctrl+D / 异常 → 退出
    }
    const line = input.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/clear') {
      history.length = 1; // 保留 system 提示
      collapsedThinkings.length = 0; // 同步清空折叠的思考段
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
        pick = (await rl.question('序号(回车取消): ')).trim();
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

    try {
      await runAgent(history, line, collapsedThinkings);
      // 成功轮次自动落盘(崩溃也保住上一轮);新会话首轮分配 id
      if (!currentSessionId) currentSessionId = newSessionId();
      try {
        saveSession(history, currentSessionId);
      } catch {
        // 落盘失败不阻断 REPL
      }
    } catch (e) {
      stdout.write(
        `${ui.red}[错误]${ui.reset} ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
    stdout.write('\n'); // 轮次之间空一行
  }

  rl.close();
}
