import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { runAgent } from '../agent/index.js';
import { ui } from '../ui/theme.js';
import { clearScreen, printBanner } from '../ui/render.js';
import type { ChatMessage } from '../llm/index.js';

/**
 * 交互式 REPL:readline 循环 + /exit /clear。
 * history 由本模块持有,在轮次间持久;agent 只读取并追加。
 */
export async function startRepl(): Promise<void> {
  clearScreen(); // 进入即清屏:抹掉之前的终端输出,只留本次会话

  const history: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
  ];
  const rl = readline.createInterface({ input: stdin, output: stdout });

  printBanner({
    model: config.model,
    baseURL: config.baseURL,
    cwd: process.cwd(),
  });

  while (true) {
    let input = '';
    try {
      input = await rl.question('> ');
    } catch {
      break; // Ctrl+D / 异常 → 退出
    }
    const line = input.trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/clear') {
      history.length = 1; // 保留 system 提示
      clearScreen();
      printBanner({
        model: config.model,
        baseURL: config.baseURL,
        cwd: process.cwd(),
      });
      console.log(`${ui.dim}(历史已清空,保留系统提示)${ui.reset}`);
      continue;
    }

    try {
      await runAgent(history, line);
    } catch (e) {
      console.error(
        `${ui.red}[错误]${ui.reset} ${e instanceof Error ? e.message : String(e)}`
      );
    }
    console.log(); // 轮次之间空一行
  }

  rl.close();
}
