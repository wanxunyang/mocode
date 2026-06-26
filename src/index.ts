import { startRepl } from './repl/index.js';
import { loadSession, listSessions } from './session/index.js';

/**
 * 入口:装配并启动 REPL。支持 --resume <id> 续接历史会话(裸 --resume 列出会话)。
 * 显式 process.exit(0)——OpenAI 客户端的 keep-alive 会卡住事件循环。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--resume');
  if (i !== -1) {
    const id = args[i + 1];
    if (!id) {
      // 裸 --resume:列出会话后退出
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log('(没有已保存的会话)');
      } else {
        for (const s of sessions) {
          console.log(`${s.id}  ${s.firstUser || '(无)'}  ${s.model}`);
        }
      }
      process.exit(0);
    }
    const loaded = loadSession(id);
    if (!loaded || !loaded.history.length) {
      console.error(`[session] 找不到会话 ${id}(用 --resume 查看列表)`);
      process.exit(1);
    }
    await startRepl(loaded.history, loaded.id);
  } else {
    await startRepl();
  }
  process.exit(0);
}

main();
