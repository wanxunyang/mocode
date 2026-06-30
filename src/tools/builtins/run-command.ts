import { spawn } from 'node:child_process';
import { MAX_OUTPUT } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- run_command ----------
export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Execute a shell command, returning combined stdout+stderr. Default timeout 120s. Use for running tests, builds, git, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute (single line)' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds, default 120000' },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = String(args.command);
    const timeout = Number(args.timeout ?? 120000);
    return new Promise<string>((done) => {
      const isWin = process.platform === 'win32';
      const child = spawn(
        isWin ? 'cmd.exe' : 'bash',
        isWin ? ['/c', command] : ['-c', command],
        { cwd: process.cwd() }
      );
      let out = '';
      let finished = false;
      const finish = (s: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done(s);
      };
      const onChunk = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (e) => finish(`执行失败: ${e.message}`));
      child.on('close', (code) => {
        let r = out.trim();
        if (out.length >= MAX_OUTPUT) r += '\n...(输出已截断)';
        finish(`[退出码 ${code}]\n${r || '(无输出)'}`);
      });
      const timer = setTimeout(() => {
        child.kill();
        finish(`[超时,已终止]\n${out.trim()}`);
      }, timeout);
    });
  },
};
