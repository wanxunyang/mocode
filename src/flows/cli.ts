/**
 * `mocode flow list | show <name> | run <name> [k=v ...] [--window <正则>] [--yes] [--sandbox-root <path>]`
 * (design-notes/computer-use-rpa.md §5.4)。
 *
 * 非交互回放入口:不经过模型、不依赖 REPL。权限语义与 `/flow run` 一致但 fail-closed:
 *   - 受 Computer Use 总开关否决(MOCODE_COMPUTER_USE_ENABLED=false);
 *   - 命中敏感审查(secret 参数、敏感文本、删除/发送/支付类目标)的 flow,没有显式 `--yes` 一律拒绝,
 *     因为这里没有人可以点确认面板;
 *   - 未命中敏感审查的 flow 直接运行(用户亲手敲了命令,等价于 `/flow run`)。
 * 退出码:completed 0;handoff / failed / rejected / 被拒绝 1;用户参数错误 2;aborted 130。
 *
 * 重模块(computer.ts 及其 UIA/抓屏依赖)经 deps 注入,默认实现只在 run 时动态加载。
 */
import { formatFlowRunResult, type FlowRunResult, type RunFlowOptions } from './runner.js';
import { listFlows, loadFlow, summarizeFlow } from './flow.js';
import { reviewFlowRun } from '../permissions/flow-review.js';
import { getSandboxRoot, setSandboxRoot } from '../sandbox/root.js';

export interface FlowCliDeps {
  out(text: string): void;
  err(text: string): void;
  /** Computer Use 总开关是否允许回放。 */
  computerAllowed(): Promise<boolean>;
  /** 真正执行回放(生产接 computer.ts;单测用假实现)。 */
  run(
    flow: Parameters<typeof formatFlowRunResult>[0],
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    options: RunFlowOptions,
  ): Promise<FlowRunResult>;
}

export const FLOW_CLI_USAGE =
  'Usage: mocode flow list | show <name> | run <name> [param=value ...] [--window <regex>] [--yes] [--sandbox-root <path>]';

function defaultDeps(): FlowCliDeps {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    async computerAllowed() {
      const { isComputerUseRouteAllowed } = await import('../config/index.js');
      return isComputerUseRouteAllowed();
    },
    async run(flow, params, signal, options) {
      const { runFlowWithComputer } = await import('../tools/builtins/run-flow.js');
      return runFlowWithComputer(flow, params, signal, options);
    },
  };
}

interface ParsedRun {
  name?: string;
  params: Record<string, string>;
  windowTitleRegex?: string;
  yes: boolean;
  error?: string;
}

/** 解析 run 子命令的参数(纯函数,便于单测)。 */
export function parseRunArgs(tokens: readonly string[]): ParsedRun {
  const out: ParsedRun = { params: {}, yes: false };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--yes' || tok === '-y') {
      out.yes = true;
    } else if (tok === '--window') {
      const re = tokens[++i];
      if (!re || re.startsWith('--')) return { ...out, error: '--window requires a regular expression' };
      try {
        new RegExp(re, 'i');
      } catch {
        return { ...out, error: `--window is not a valid regular expression: ${re}` };
      }
      out.windowTitleRegex = re;
    } else if (tok.startsWith('--')) {
      return { ...out, error: `unknown option ${tok}` };
    } else if (out.name === undefined) {
      out.name = tok;
    } else {
      const eq = tok.indexOf('=');
      if (eq <= 0) return { ...out, error: `parameter "${tok}" must look like name=value` };
      out.params[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
  }
  return out;
}

export async function runFlowCli(rawArgs: readonly string[], deps: FlowCliDeps = defaultDeps()): Promise<number> {
  // 取出 --sandbox-root <path>(与主入口同语义),其余交给子命令。
  const args: string[] = [];
  let sandboxRoot: string | undefined;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--sandbox-root') {
      sandboxRoot = rawArgs[++i];
      if (!sandboxRoot || sandboxRoot.startsWith('--')) {
        deps.err('mocode flow: --sandbox-root requires a path\n');
        return 2;
      }
    } else {
      args.push(rawArgs[i]);
    }
  }
  const prevRoot = sandboxRoot !== undefined ? setSandboxRoot(sandboxRoot) : getSandboxRoot();
  try {
    return await dispatch(args, deps);
  } finally {
    if (sandboxRoot !== undefined) setSandboxRoot(prevRoot);
  }
}

async function dispatch(args: string[], deps: FlowCliDeps): Promise<number> {
  const sub = (args.shift() ?? '').toLowerCase();

  if (sub === 'list') {
    const items = listFlows();
    if (items.length === 0) {
      deps.out('No saved flows (.mocode/flows/).\n');
      return 0;
    }
    for (const it of items) {
      deps.out(`${it.name}  ${it.steps} steps${it.description ? ` · ${it.description}` : ''}\n`);
    }
    return 0;
  }

  if (sub === 'show') {
    const name = args[0];
    if (!name) {
      deps.err(`${FLOW_CLI_USAGE}\n`);
      return 2;
    }
    const loaded = loadFlow(name);
    if (!loaded.ok) {
      deps.err(`mocode flow: ${loaded.error}\n`);
      return 1;
    }
    deps.out(`${summarizeFlow(loaded.flow)}\n${loaded.path}\n`);
    return 0;
  }

  if (sub === 'run') {
    const parsed = parseRunArgs(args);
    if (parsed.error || !parsed.name) {
      deps.err(`mocode flow: ${parsed.error ?? 'missing flow name'}\n${FLOW_CLI_USAGE}\n`);
      return 2;
    }
    if (!(await deps.computerAllowed())) {
      deps.err('mocode flow: Computer Use is disabled (MOCODE_COMPUTER_USE_ENABLED=false); flows will not run.\n');
      return 1;
    }
    const loaded = loadFlow(parsed.name);
    if (!loaded.ok) {
      deps.err(`mocode flow: ${loaded.error}\n`);
      return 1;
    }
    const review = reviewFlowRun({
      name: parsed.name,
      params: parsed.params,
      ...(parsed.windowTitleRegex ? { window_title_regex: parsed.windowTitleRegex } : {}),
    });
    if (review.reasons.length > 0 && !parsed.yes) {
      deps.err(
        `mocode flow: flow "${parsed.name}" needs explicit approval and there is no interactive prompt here:\n` +
          `${review.reasons.map((r) => `  - ${r}`).join('\n')}\n` +
          'Review it with `mocode flow show`, then re-run with --yes to confirm.\n',
      );
      return 1;
    }

    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.once('SIGINT', onSigint);
    let result: FlowRunResult;
    try {
      result = await deps.run(loaded.flow, parsed.params, controller.signal, {
        ...(parsed.windowTitleRegex ? { windowTitleRegex: parsed.windowTitleRegex } : {}),
      });
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
    const text = formatFlowRunResult(loaded.flow, result);
    if (result.status === 'completed') {
      deps.out(`${text}\n`);
      return 0;
    }
    deps.err(`${text}\n`);
    return result.status === 'aborted' ? 130 : 1;
  }

  deps.err(`${FLOW_CLI_USAGE}\n`);
  return 2;
}
