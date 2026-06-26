import { startRepl } from './repl/index.js';

/**
 * 入口:装配并启动 REPL。
 * 显式 process.exit(0)——OpenAI 客户端的 keep-alive 会卡住事件循环。
 */
async function main(): Promise<void> {
  await startRepl();
  process.exit(0);
}

main();
