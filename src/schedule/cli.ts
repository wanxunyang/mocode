// `mocode schedule …` 命令行管理：
//   add --name <n> (--cron "<5段>" | --webhook | 两者) --prompt "<任务>" [--worktree]
//   list | rm <id前缀> | enable <id前缀> | disable <id前缀>
//   start | stop | status | tick
// add 成功后打印触发方式（cron / webhook URL）；cron 类需 start 拉起守护进程才生效。

import { createSchedule, listSchedules, deleteSchedule, updateSchedule } from './store.js';
import { startDaemon, stopDaemon, isDaemonRunning, getDaemonState, runTick } from './daemon.js';

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('-') ? v : undefined;
}

function findByPrefix(prefix: string | undefined) {
  const all = listSchedules();
  if (!prefix) return all.length === 1 ? all[0] : undefined;
  const m = all.filter((s) => (prefix ? s.id.startsWith(prefix) || s.name === prefix : false));
  return m.length === 1 ? m[0] : undefined;
}

export async function runScheduleCli(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0] ?? 'list';
  const args = rawArgs.slice(1);

  switch (sub) {
    case 'add': {
      const name = flagValue(args, '--name');
      const prompt = flagValue(args, '--prompt');
      const cron = flagValue(args, '--cron');
      const webhook = args.includes('--webhook');
      const worktree = args.includes('--worktree');
      if (!name || !prompt) {
        process.stderr.write(
          'usage: mocode schedule add --name <n> --prompt "<task>" (--cron "<5 fields>" and/or --webhook) [--worktree]\n',
        );
        return 1;
      }
      try {
        const rec = createSchedule({ name, prompt, cron, webhook, worktree });
        process.stdout.write(`Schedule created: ${rec.id}\n  name: ${rec.name}\n`);
        if (rec.cron) process.stdout.write(`  cron: ${rec.cron}（需 mocode schedule start）\n`);
        if (rec.webhookToken) {
          const port = getDaemonState()?.port ?? 8788;
          process.stdout.write(
            `  webhook: POST http://127.0.0.1:${port}/trigger/${rec.webhookToken}（需 schedule start）\n`,
          );
        }
        return 0;
      } catch (e) {
        process.stderr.write(`mocode: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }

    case 'rm':
    case 'remove': {
      const rec = findByPrefix(args[0]);
      if (!rec) {
        process.stderr.write('mocode: no unique matching schedule\n');
        return 1;
      }
      deleteSchedule(rec.id);
      process.stdout.write(`Removed ${rec.id} (${rec.name})\n`);
      return 0;
    }

    case 'enable':
    case 'disable': {
      const rec = findByPrefix(args[0]);
      if (!rec) {
        process.stderr.write('mocode: no unique matching schedule\n');
        return 1;
      }
      updateSchedule(rec.id, { enabled: sub === 'enable' });
      process.stdout.write(`${rec.name} ${sub}d\n`);
      return 0;
    }

    case 'start': {
      const r = startDaemon();
      if (r.started && r.state) {
        process.stdout.write(`Scheduler started (pid ${r.state.pid}, port ${r.state.port})\n`);
      } else {
        process.stdout.write(`Scheduler not started: ${r.reason ?? 'unknown'}\n`);
      }
      return 0;
    }

    case 'stop':
      process.stdout.write(stopDaemon() ? 'Scheduler stopped\n' : 'Scheduler was not running\n');
      return 0;

    case 'status': {
      const state = getDaemonState();
      process.stdout.write(
        isDaemonRunning() && state
          ? `running (pid ${state.pid}, port ${state.port}, since ${state.startedAt})\n`
          : 'stopped\n',
      );
      return 0;
    }

    case 'tick': {
      const fired = await runTick();
      process.stdout.write(`tick done: ${fired} fired\n`);
      return 0;
    }

    case 'list':
    default: {
      const all = listSchedules();
      if (all.length === 0) {
        process.stdout.write('(no schedules; add one with `mocode schedule add …`)\n');
        return 0;
      }
      for (const s of all) {
        const trigger = s.cron ? s.cron : s.webhookToken ? `webhook:${s.webhookToken}` : '?';
        process.stdout.write(
          `${s.enabled ? '●' : '○'} ${s.id}  ${s.name}\n    ${trigger}\n    ${s.prompt.split('\n')[0]}\n`,
        );
      }
      return 0;
    }
  }
}
