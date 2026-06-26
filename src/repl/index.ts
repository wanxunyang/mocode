import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { runAgent } from '../agent/index.js';
import { ui } from '../ui/theme.js';
import { clearScreen, printBanner } from '../ui/render.js';
import { tools } from '../tools/registry.js';
import type { ChatMessage } from '../llm/index.js';

/**
 * readline 的 prompt 必须是纯文本(无 ANSI):readline 按字符数算光标位置,
 * 颜色码会让光标错位、编辑时漂移。颜色只用在直接 stdout.write 的横幅 / 工具行 / 回复。
 */
const PROMPT = '❯ ';

/**
 * 交互式 REPL:readline 循环 + /exit /clear。
 * history 由本模块持有,在轮次间持久;agent 只读取并追加。
 */
export async function startRepl(): Promise<void> {
  clearScreen(); // 进入即清屏:抹掉之前的终端输出,只留本次会话

  const history: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
  ];
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
      clearScreen();
      printBanner(banner());
      stdout.write(`${ui.dim}(历史已清空,保留系统提示)${ui.reset}\n`);
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
    } catch (e) {
      stdout.write(
        `${ui.red}[错误]${ui.reset} ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
    stdout.write('\n'); // 轮次之间空一行
  }

  rl.close();
}
