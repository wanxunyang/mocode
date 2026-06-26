import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from './config.js';
import { runAgent } from './agent.js';
import { ui, clearScreen } from './ui.js';
import type { ChatMessage } from './llm.js';

/** 启动横幅:模型 / 后端 / 工作目录 / 内置命令。 */
function printBanner(): void {
  const { dim, bold, cyan, reset } = ui;
  stdout.write(`${bold}${cyan}终端编码 Agent${reset}\n`);
  stdout.write(`${dim}模型  ${config.model}  ·  后端  ${config.baseURL}${reset}\n`);
  stdout.write(`${dim}工作目录  ${process.cwd()}${reset}\n`);
  stdout.write(`${dim}/exit 退出  ·  /clear 清空历史${reset}\n`);
  stdout.write(`${dim}${'─'.repeat(48)}${reset}\n`);
}

async function main(): Promise<void> {
  clearScreen(); // 进入即清屏:抹掉之前的终端输出,只留本次会话

  const history: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
  ];
  const rl = readline.createInterface({ input: stdin, output: stdout });

  printBanner();

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
      printBanner();
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
  process.exit(0); // OpenAI 客户端 keep-alive 会卡住事件循环,显式退出
}

main();
