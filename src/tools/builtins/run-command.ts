import { spawn, spawnSync } from 'node:child_process';
import { MAX_OUTPUT } from '../constants.js';
import { getSandboxRoot, filterEnv, isCommandDenied } from '../../sandbox/index.js';
import type { Tool } from '../types.js';

const OUTPUT_HEAD_LIMIT = Math.floor(MAX_OUTPUT * 0.4);
const OUTPUT_TAIL_LIMIT = MAX_OUTPUT - OUTPUT_HEAD_LIMIT;

/** 有界采集：短输出逐字保留；超限后保留 head+tail，避免构建/测试错误只出现在尾部时被丢弃。 */
class BoundedCommandOutput {
  private head = '';
  private tail = '';
  private total = 0;

  append(text: string): void {
    this.total += text.length;
    const headRoom = OUTPUT_HEAD_LIMIT - this.head.length;
    const headPart = headRoom > 0 ? text.slice(0, headRoom) : '';
    this.head += headPart;
    const rest = text.slice(headPart.length);
    if (rest) this.tail = (this.tail + rest).slice(-OUTPUT_TAIL_LIMIT);
  }

  render(): string {
    if (this.total <= MAX_OUTPUT) return this.head + this.tail;
    const removed = this.total - MAX_OUTPUT;
    return `${this.head}\n...(输出已截断 ${removed} 字符,保留开头与结尾)...\n${this.tail}`;
  }
}

// ---------- run_command ----------
export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command, merging stdout+stderr. Default timeout 120s. For tests, builds, git, etc.',
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute (single line)' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds, default 120000' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = String(args.command);
    const timeout = Number(args.timeout ?? 120000);
    // 沙箱 best-effort:灾难性文件操作 denylist(非安全边界,只挡误操作;真隔离需 OS jailer)。
    const deny = isCommandDenied(command);
    if (deny) return `错误:${deny}`;
    return new Promise<string>((done) => {
      const isWin = process.platform === 'win32';
      // 沙箱 best-effort:cwd 钉死 sandbox root(相对路径写落在牢内)+ env 脱敏(剥 *KEY/*TOKEN 等,防 LLM_API_KEY 泄子进程)
      const child = spawn(
        isWin ? 'cmd.exe' : 'bash',
        isWin ? ['/c', command] : ['-c', command],
        { cwd: getSandboxRoot() ?? process.cwd(), env: filterEnv(process.env) }
      );
      const output = new BoundedCommandOutput();
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      // 杀整棵进程树。child.kill() 在 Windows 只杀 cmd.exe、npm 等子进程会孤儿继续跑(占锁、污染下一步),
      // 故 Win 用 taskkill /T /F 树杀;Unix child.kill('SIGTERM')(bash -c 通常转发给前台子进程,best-effort)。
      const killTree = (): void => {
        try {
          if (isWin) {
            if (child.pid != null) {
              spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
              });
            }
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          // 进程已退出 / kill 失败:忽略(close 事件会兜底 finish)
        }
      };
      // abort(用户 Ctrl+C,经 executeTool ctx.signal 透传)→ 杀子进程树 + 返[已中断]
      const onAbort = (): void => {
        killTree();
        finish(`[已中断]\n${output.render().trim()}`);
      };
      const finish = (s: string): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ctx?.signal?.removeEventListener('abort', onAbort);
        done(s);
      };
      const onChunk = (chunk: Buffer): void => {
        output.append(chunk.toString('utf8'));
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (e) => finish(`执行失败: ${e.message}`));
      child.on('close', (code) => {
        const result = output.render().trim();
        finish(`[退出码 ${code}]\n${result || '(无输出)'}`);
      });
      timer = setTimeout(() => {
        killTree();
        finish(`[超时,已终止]\n${output.render().trim()}`);
      }, timeout);
      // 外部 abort signal:已 aborted 即时杀(防御;agent 循环顶检查通常会先拦),否则挂监听
      if (ctx?.signal) {
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  },
};
