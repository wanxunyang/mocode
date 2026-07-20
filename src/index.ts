import { exitAltScreen } from './ui/layout.js';
import { readConfigFile } from './config/file.js';
import { detectLanguage, setLanguage, t } from './i18n/index.js';

// 终端恢复兜底:任一退出 / 中断 / 未捕获异常路径都要恢复 alt screen,避免残留备用屏 + 滚动区域。
// exitAltScreen 幂等(未激活时空操作),故全局注册安全——进 alt screen 前的路径(如 --resume 列表、缺环境变量、`mocode config`)调用它无副作用。
// 仅 layout 是叶子(不依赖 config),故静态导入安全;repl / session 依赖 config(模块加载触发 loadEnvFiles + config 单例初始化),
// 改动态按需加载——`mocode config` 向导只需读写文件(走 config/file.ts 叶子),不经 config 单例初始化,零配置也能跑。
process.on('exit', () => exitAltScreen());
process.on('SIGINT', () => {
  exitAltScreen();
  process.exit(130);
});
process.on('uncaughtException', (e) => {
  try {
    process.stderr.write(`\n[uncaught] ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  } catch {
    // 忽略
  }
  exitAltScreen();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  try {
    process.stderr.write(`\n[unhandled] ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  } catch {
    // 忽略
  }
  exitAltScreen();
  process.exit(1);
});

/**
 * 入口:装配并启动 REPL。支持 --resume <id> 续接历史会话(裸 --resume 列出会话)。
 * `mocode config` 走首跑配置向导(动态加载 commands/config,不引入 REPL/config 图,故缺配置也能跑)。
 * REPL / session 用动态 import 按需加载——只在真正启动时才拉入 config 依赖图。
 * 显式 process.exit(0)——OpenAI 客户端的 keep-alive 会卡住事件循环。
 */
async function main(): Promise<void> {
  const savedLanguage = readConfigFile().MOCODE_LANGUAGE;
  setLanguage(detectLanguage(process.env.MOCODE_LANGUAGE ?? savedLanguage));
  const args = process.argv.slice(2);

  // --sandbox-root <path>:覆盖沙箱根(文件操作边界)。缺值或以 -- 开头报错退出。
  const sr = args.indexOf('--sandbox-root');
  let sandboxRootOverride: string | undefined;
  if (sr !== -1) {
    sandboxRootOverride = args[sr + 1];
    if (!sandboxRootOverride || sandboxRootOverride.startsWith('--')) {
      console.error(t('cli.sandboxPath'));
      process.exit(1);
    }
  }

  // 首跑配置向导:写 ~/.mocode/config。独立模块,不触发 config 校验,故零配置也能跑。
  if (args[0] === 'config') {
    const { runConfigWizard } = await import('./commands/config.js');
    await runConfigWizard();
    process.exit(0);
  }

  const i = args.indexOf('--resume');
  if (i !== -1) {
    const { listSessions, loadSession } = await import('./session/index.js');
    const id = args[i + 1];
    if (!id) {
      // 裸 --resume:列出会话后退出
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log(t('cli.noSessions'));
      } else {
        for (const s of sessions) {
          console.log(`${s.id}  ${s.firstUser || t('cli.noValue')}  ${s.model}`);
        }
      }
      process.exit(0);
    }
    const loaded = loadSession(id);
    if (!loaded || !loaded.history.length) {
      console.error(t('cli.sessionMissing', { id }));
      process.exit(1);
    }
    const { startRepl } = await import('./repl/index.js');
    await startRepl(
      loaded.history,
      loaded.id,
      sandboxRootOverride,
      loaded.queryHistory,
    );
  } else {
    const { startRepl } = await import('./repl/index.js');
    await startRepl(undefined, undefined, sandboxRootOverride);
  }
  process.exit(0);
}

main();
