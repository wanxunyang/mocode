// `mocode bots …` 管理：
//   add --name <n> (--prompt "<text>" | --prompt-file <path>) [--description <d>]
//       [--tools "a,b,c"] [--sandbox-path <p>] [--global]
//   list | show <name> | rm <name> [--global]
// 作用域默认项目（.mocode/bots）；--global 写 ~/.mocode/bots。

import fs from 'node:fs';
import { saveBot, listBots, getBot, deleteBot } from './store.js';

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('-') ? v : undefined;
}

export async function runBotsCli(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0] ?? 'list';
  const args = rawArgs.slice(1);

  switch (sub) {
    case 'add': {
      const name = flagValue(args, '--name');
      const description = flagValue(args, '--description') ?? '';
      const inline = flagValue(args, '--prompt');
      const promptFile = flagValue(args, '--prompt-file');
      const toolsRaw = flagValue(args, '--tools');
      const sandboxPath = flagValue(args, '--sandbox-path');
      const scope = args.includes('--global') ? 'global' : 'project';

      if (!name) {
        process.stderr.write(
          'usage: mocode bots add --name <n> (--prompt "<text>" | --prompt-file <path>) ' +
            '[--description <d>] [--tools "a,b"] [--sandbox-path <p>] [--global]\n',
        );
        return 1;
      }
      let systemPrompt = inline ?? '';
      if (promptFile) {
        try {
          systemPrompt = fs.readFileSync(promptFile, 'utf8');
        } catch (e) {
          process.stderr.write(`mocode: cannot read prompt file: ${e instanceof Error ? e.message : String(e)}\n`);
          return 1;
        }
      }
      if (!systemPrompt.trim()) {
        process.stderr.write('mocode: bot prompt is empty (use --prompt or --prompt-file)\n');
        return 1;
      }
      const tools = toolsRaw
        ? toolsRaw
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      try {
        const rec = saveBot({ name, description, systemPrompt, tools, sandboxPath, scope });
        process.stdout.write(`Bot saved: ${rec.name} (${rec.scope})\n`);
        return 0;
      } catch (e) {
        process.stderr.write(`mocode: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }

    case 'show': {
      const name = args[0];
      if (!name) {
        process.stderr.write('usage: mocode bots show <name>\n');
        return 1;
      }
      const rec = getBot(name);
      if (!rec) {
        process.stderr.write(`mocode: bot "${name}" not found\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
      return 0;
    }

    case 'rm':
    case 'remove': {
      const name = args[0];
      if (!name) {
        process.stderr.write('usage: mocode bots rm <name> [--global]\n');
        return 1;
      }
      const scope = args.includes('--global') ? 'global' : 'project';
      const ok = deleteBot(name, scope);
      process.stdout.write(ok ? `Removed bot ${name} (${scope})\n` : `mocode: bot ${name} (${scope}) not found\n`);
      return ok ? 0 : 1;
    }

    case 'list':
    default: {
      const all = listBots();
      if (all.length === 0) {
        process.stdout.write('(no bots; create one with `mocode bots add …`)\n');
        return 0;
      }
      for (const b of all) {
        process.stdout.write(
          `${b.scope === 'global' ? 'g' : 'p'} ${b.name}` +
            `${b.tools && b.tools.length ? `  tools:${b.tools.length}` : ''}  ${b.description}\n`,
        );
      }
      return 0;
    }
  }
}
