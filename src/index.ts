import { exitAltScreen } from './ui/layout.js';
import { readConfigFile } from './config/file.js';
import { detectLanguage, setLanguage, t } from './i18n/index.js';
import { shutdownRuntime, shutdownRuntimeSync } from './runtime/shutdown.js';

// 终端恢复兜底:任一退出 / 中断 / 未捕获异常路径都要恢复 alt screen,避免残留备用屏 + 滚动区域。
// exitAltScreen 幂等(未激活时空操作),故全局注册安全——进 alt screen 前的路径(如 --resume 列表、缺环境变量、`mocode config`)调用它无副作用。
// 仅 layout 是叶子(不依赖 config),故静态导入安全;repl / session 依赖 config(模块加载触发 loadEnvFiles + config 单例初始化),
// 改动态按需加载——`mocode config` 向导只需读写文件(走 config/file.ts 叶子),不经 config 单例初始化,零配置也能跑。
// dev_server 拉起的后台进程不随父进程退出而消失(Windows 无 job object),故每条退出路径
// 都同步树杀一次;shutdownRuntimeSync 幂等。
process.on('exit', () => {
  shutdownRuntimeSync();
  exitAltScreen();
});
process.on('SIGINT', () => {
  shutdownRuntimeSync();
  exitAltScreen();
  process.exit(130);
});
process.on('uncaughtException', (e) => {
  shutdownRuntimeSync();
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

/** 取 args 中任意位置的非 flag 参数；排除带值 flag（--sandbox-root）的下一个值。 */
function firstPositional(args: string[], options: { valueFlags?: string[] } = {}): string | undefined {
  const valueFlags = options.valueFlags ?? [];
  return args.find((a, idx) => {
    if (a.startsWith('-')) return false;
    if (valueFlags.includes(args[idx - 1] ?? '')) return false;
    return true;
  });
}

/**
 * 入口:
 * - 后台任务:`mocode run --bg "任务"`（detached 子进程，状态落 .mocode/jobs/）。
 * - Job runner 内部模式:`mocode --job-runner <id>`（由 run --bg 派生，用户不直接用）。
 * - Headless（一次性 / 非交互）:`mocode -p "任务"` 或 `echo "任务" | mocode`，
 *   可选 --json / --verbose / --dangerously-skip-permissions。
 * - 交互 REPL（默认）;支持 --resume <id> 续接历史会话(裸 --resume 列出会话)。
 * `mocode config` 走首跑配置向导(动态加载 commands/config,不引入 REPL/config 图,故缺配置也能跑)。
 * REPL / session / headless / jobs 用动态 import 按需加载——只在真正启动时才拉入 config 依赖图。
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

  // --session-dir <path>:会话独立落盘目录(不写主 .mocode/sessions)。
  const sd = args.indexOf('--session-dir');
  let sessionDirOverride: string | undefined;
  if (sd !== -1) {
    sessionDirOverride = args[sd + 1];
    if (!sessionDirOverride || sessionDirOverride.startsWith('--')) {
      console.error('mocode: --session-dir requires a path');
      process.exit(1);
    }
  }
  const useWorktree = args.includes('--worktree');

  // 首跑配置向导:写 ~/.mocode/config。独立模块,不触发 config 校验,故零配置也能跑。
  if (args[0] === 'schedule') {
    const { runScheduleCli } = await import('./schedule/cli.js');
    const code = await runScheduleCli(args.slice(1));
    process.exit(code);
  }

  if (args[0] === 'config') {
    const { runConfigWizard } = await import('./commands/config.js');
    await runConfigWizard();
    process.exit(0);
  }

  // Job runner 内部模式：detached 子进程入口。
  const runnerIdx = args.indexOf('--job-runner');
  if (runnerIdx !== -1) {
    const jobId = args[runnerIdx + 1];
    if (!jobId) {
      process.stderr.write('mocode: --job-runner requires a job id\n');
      process.exit(1);
    }
    const { isModelConfigured } = await import('./config/index.js');
    if (!isModelConfigured()) {
      process.stderr.write('mocode: model not configured; cannot run background job.\n');
      process.exit(1);
    }
    const { runJobRunner } = await import('./jobs/runner.js');
    const code = await runJobRunner(jobId);
    process.exit(code);
  }

  // 调度守护进程内部模式：detached 进程入口。
  const schedDaemonIdx = args.indexOf('--schedule-daemon');
  if (schedDaemonIdx !== -1) {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? Number(args[portIdx + 1]) : undefined;
    const { runDaemon } = await import('./schedule/daemon.js');
    runDaemon(port);
    return; // 常驻：不显式 exit，detached 进程靠事件循环存活
  }
  // 后台任务：mocode run [--bg] "任务"。
  if (args[0] === 'run') {
    const rest = args.slice(1);
    const background = rest.includes('--bg');
    const prompt = firstPositional(rest, { valueFlags: ['--sandbox-root'] });
    const { isModelConfigured } = await import('./config/index.js');
    if (!isModelConfigured()) {
      process.stderr.write(
        'mocode: model not configured. Set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL ' +
          '(or run `mocode config`) first.\n',
      );
      process.exit(1);
    }
    if (background) {
      const { launchBackgroundJob } = await import('./jobs/launch.js');
      const { resolvePrompt } = await import('./headless.js');
      const resolved = await resolvePrompt(prompt);
      if (!resolved) {
        process.stderr.write('mocode: empty task (use `mocode run --bg "task"` or pipe via stdin)\n');
        process.exit(1);
      }
      const { record } = launchBackgroundJob(resolved, {
        ...(sessionDirOverride ? { sessionDir: sessionDirOverride } : {}),
        ...(useWorktree ? { worktree: true } : {}),
      });
      process.stdout.write(
        `Job started: ${record.id}\n  pid: ${record.pid ?? '?'}\n  log: ${record.logPath}\n` +
          `  track with: mocode /jobs (in TUI) or read the log file\n`,
      );
      process.exit(0);
    }
    // 前台 run：等价 -p，走 headless。
    const { runHeadless, resolvePrompt } = await import('./headless.js');
    const resolved = await resolvePrompt(prompt);
    if (!resolved) {
      process.stderr.write('mocode: empty task\n');
      process.exit(1);
    }
    const code = await runHeadless({
      prompt: resolved,
      json: rest.includes('--json'),
      verbose: rest.includes('--verbose'),
      skipPermissions: rest.includes('--dangerously-skip-permissions'),
      sandboxRootOverride,
      sessionDir: sessionDirOverride,
      worktree: useWorktree,
    });
    await shutdownRuntime();
    process.exit(code);
  }

  // Headless：-p / --print [prompt]。prompt 缺省时从 stdin（管道）读取。
  const printIdx = args.findIndex((a) => a === '-p' || a === '--print');
  if (printIdx !== -1) {
    // 任意位置的非 flag 参数都作为 prompt（不要求紧跟 -p）；排除 --sandbox-root 的值。
    const inlinePrompt = firstPositional(
      args.filter((_, idx) => idx !== printIdx),
      { valueFlags: ['--sandbox-root'] },
    );
    const { runHeadless, resolvePrompt } = await import('./headless.js');
    const { isModelConfigured } = await import('./config/index.js');
    const prompt = await resolvePrompt(inlinePrompt);
    if (!prompt) {
      process.stderr.write('mocode: empty prompt (use -p "..." or pipe via stdin)\n');
      process.exit(1);
    }
    if (!isModelConfigured()) {
      process.stderr.write(
        'mocode: model not configured. Set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL ' +
          '(or run `mocode config`) before using -p.\n',
      );
      process.exit(1);
    }
    const exitCode = await runHeadless({
      prompt,
      json: args.includes('--json'),
      verbose: args.includes('--verbose'),
      skipPermissions: args.includes('--dangerously-skip-permissions'),
      sandboxRootOverride,
      sessionDir: sessionDirOverride,
      worktree: useWorktree,
    });
    await shutdownRuntime();
    process.exit(exitCode);
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
    await startRepl(loaded.history, loaded.id, sandboxRootOverride, loaded.queryHistory, loaded.lastToolGroups);
  } else {
    const { startRepl } = await import('./repl/index.js');
    await startRepl(undefined, undefined, sandboxRootOverride);
  }
  // 正常退出:优雅关闭浏览器与后台进程(同步兜底仍在 exit 钩子里)。
  await shutdownRuntime();
  process.exit(0);
}

main().catch((e) => {
  exitAltScreen();
  process.stderr.write(`${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  process.exit(1);
});
