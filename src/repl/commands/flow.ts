/**
 * 桌面流程命令组:/flow list · show <name> · save <name> [--from N] [--to M] [--force] [描述] · run <name> [参数=值 ...]
 *
 * 数据流(design-notes/computer-use-rpa.md §5):computer 动作被结构化录进会话的 gui-trace.jsonl,
 * `/flow save` 把它导出成 `.mocode/flows/<name>.json`,`/flow run` 不经过模型直接回放。
 * 回放受 Computer Use 总开关否决(/cu off);命中敏感内容(secret 参数、敏感文本、删除/发送/支付类目标)
 * 的 flow 在开跑前强制逐次确认,与 run_flow 工具走同一套审查(permissions/flow-review.ts)。
 *
 * 重模块(computer.ts 及其 UIA/抓屏依赖)只在 run 时动态加载,不拖慢启动。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { t } from '../../i18n/index.js';
import { isComputerUseRouteAllowed } from '../../config/index.js';
import { promptIntervention } from '../../ui/intervention.js';
import { startRunningListener, stopRunningListener } from '../running-input.js';
import { unhandled, next, type CommandHandler } from './types.js';

/** 按空白切词,支持 "双引号"(内部 \" 转义)与 '单引号';key="a b" 视为一个词。 */
export function tokenizeFlowArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && s[i + 1] === '"') cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const warn = (msg: string): void => layout.contentWrite(`${ui.yellow}${msg}${ui.reset}\n`);
const dim = (msg: string): void => layout.contentWrite(`${ui.dim}${msg}${ui.reset}\n`);

async function flowList(): Promise<void> {
  const { listFlows } = await import('../../flows/flow.js');
  const items = listFlows();
  if (items.length === 0) {
    dim(t('flow.noFlows'));
    return;
  }
  for (const it of items) {
    layout.contentWrite(
      `${ui.accent}${it.name}${ui.reset}  ${ui.dim}${it.steps} steps${it.description ? ` · ${it.description}` : ''}${ui.reset}\n`,
    );
  }
}

async function flowShow(name: string | undefined): Promise<void> {
  if (!name) return warn(t('flow.usage'));
  const { loadFlow, summarizeFlow } = await import('../../flows/flow.js');
  const loaded = loadFlow(name);
  if (!loaded.ok) return warn(loaded.error);
  layout.contentWrite(`${summarizeFlow(loaded.flow)}\n${ui.dim}${loaded.path}${ui.reset}\n`);
}

async function flowSave(tokens: string[]): Promise<void> {
  let from: number | undefined;
  let to: number | undefined;
  let force = false;
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--force') force = true;
    else if (tok === '--from' || tok === '--to') {
      const n = Number(tokens[++i]);
      if (!Number.isInteger(n) || n < 1) return warn(t('flow.usage'));
      if (tok === '--from') from = n;
      else to = n;
    } else positional.push(tok);
  }
  const name = positional.shift();
  if (!name) return warn(t('flow.usage'));
  const description = positional.join(' ').trim() || undefined;

  const { exportFlowFromTrace, saveFlow } = await import('../../flows/flow.js');
  const { readTrace } = await import('../../flows/trace.js');
  const exported = exportFlowFromTrace(readTrace(), { name, description, from, to });
  if (!exported.ok) return warn(exported.error);
  const saved = saveFlow(exported.flow, { overwrite: force });
  if (!saved.ok) return warn(saved.error);

  layout.contentWrite(
    `${ui.green}${t('flow.saved', { name, steps: exported.flow.steps.length, path: saved.path })}${ui.reset}\n`,
  );
  const required = Object.entries(exported.flow.params)
    .filter(([, p]) => p.default === undefined)
    .map(([k]) => k);
  if (required.length) dim(t('flow.savedParams', { name, params: required.join(', ') }));
  const fragile = exported.flow.steps.filter((s) => s.fragile).length;
  if (fragile) warn(t('flow.fragile', { count: fragile }));
}

async function flowRun(tokens: string[]): Promise<void> {
  const name = tokens.shift();
  if (!name) return warn(t('flow.usage'));
  if (!isComputerUseRouteAllowed()) return warn(t('flow.gateOff'));

  const params: Record<string, string> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return warn(t('flow.badParam', { token: tok }));
    params[tok.slice(0, eq)] = tok.slice(eq + 1);
  }

  const { loadFlow } = await import('../../flows/flow.js');
  const loaded = loadFlow(name);
  if (!loaded.ok) return warn(loaded.error);

  // 与 run_flow 工具同一套审查:敏感 flow 开跑前必须逐次确认(回放内部的单步不再弹窗)。
  const { reviewFlowRun } = await import('../../permissions/flow-review.js');
  const review = reviewFlowRun({ name, params });
  if (review.reasons.length) {
    const allow = t('permission.allow');
    const deny = t('permission.deny');
    const res = await promptIntervention({
      type: 'choice',
      title: t('permission.dangerTitle', { tool: 'flow run' }),
      detail: `${review.summary}\n\nPer-run approval required:\n${review.reasons.map((r) => `  - ${r}`).join('\n')}`,
      options: [allow, deny],
      allowCustom: false,
      defaultIndex: 1,
    });
    if (res.action === 'cancelled' || res.value !== allow) return dim(t('flow.cancelled'));
  }

  const { runFlowWithComputer } = await import('../../tools/builtins/run-flow.js');
  const { formatFlowRunResult } = await import('../../flows/runner.js');
  const signal = startRunningListener(t('flow.running'));
  let result;
  try {
    result = await runFlowWithComputer(loaded.flow, params, signal);
  } finally {
    stopRunningListener();
  }
  const color = result.status === 'completed' ? ui.green : result.status === 'aborted' ? ui.dim : ui.yellow;
  layout.contentWrite(`${color}${formatFlowRunResult(loaded.flow, result)}${ui.reset}\n`);
}

export const flowCommands: CommandHandler[] = [
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/flow' && !line.startsWith('/flow ')) return unhandled();
    const tokens = tokenizeFlowArgs(line.slice('/flow'.length));
    const sub = (tokens.shift() ?? '').toLowerCase();
    switch (sub) {
      case 'list':
        await flowList();
        break;
      case 'show':
        await flowShow(tokens[0]);
        break;
      case 'save':
        await flowSave(tokens);
        break;
      case 'run':
        await flowRun(tokens);
        break;
      default:
        warn(t('flow.usage'));
    }
    return next();
  },
];
