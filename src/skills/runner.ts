// skill 执行内核(L2-①/②/③):占位符渲染 + 动态命令注入 + fork 子 agent 执行。
// 被 use_skill(inline 渲染 / fork 引导)与 run_skill(fork 执行)共用。
//
// 设计要点(对齐 docs/skill-system-design.md §3.3–3.5):
//  - 不为 scripts/ 做任何新机制:作者用 ${SKILL_DIR} 拼出绝对路径,模型自行 run_command。
//  - 不为参数做 shell 插值:参数渲染进 prompt 文本,落到命令行时是模型写 run_command,
//    走既有 denylist + 权限确认。转义器本身就是注入面,不写它比写对它更安全。
//  - !`cmd` 注入仅在非 project 或已信任 skill 上允许;单 skill 最多 4 处,单处输出截 4KB。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getSkillBody, findSkill } from './index.js';
import { isSkillTrusted, ensureSkillTrust } from './trust.js';
import { mapSkillTools } from './toolmap.js';
import { spawnAgent, type SpawnResult } from '../agent/spawn.js';
import { runCommandRaw } from '../tools/builtins/run-command.js';
import type { Skill } from './discover.js';
import type { ToolOutcome, ToolContext } from '../tools/types.js';
import type { ChangeSet, ChangeSetSummary } from '../changeset/types.js';

/** 把 raw ChangeSet 折成 ToolOutcome 需要的 ChangeSetSummary(哈希缺失位填 null,仅用于展示)。 */
function toChangeSetSummary(cs: ChangeSet): ChangeSetSummary {
  return {
    id: cs.id,
    changedFiles: cs.changes.map((c) => c.path),
    changes: cs.changes.map((c) => ({
      path: c.path,
      operation: c.operation,
      beforeHash: null,
      afterHash: null,
    })),
  };
}

const MAX_INJECTIONS = 4;
const MAX_INJECTION_OUTPUT = 4096;
const INJECT_TIMEOUT = 10_000;

/** fork 子 agent 收到的协议头:明确它是「执行某个 skill」,并要求最终给一句话摘要。 */
const SKILL_PROTOCOL_HEADER = `You are executing a packaged skill workflow. Follow the instructions below literally and completely. When done, end your reply with a concise summary of what you did, the files changed, and any issues. Do not ask the user questions unless blocked.`;

/** 把 $ARGUMENTS / $1..$9 / ${SKILL_DIR} 渲染进正文。 */
function substituteArgs(body: string, args: Record<string, unknown> | undefined, skillDir: string): string {
  const values = args && typeof args === 'object' ? Object.values(args) : [];
  return body.replace(/\$(?:ARGUMENTS|(\d)|\{SKILL_DIR\})/g, (_m, digit) => {
    if (digit != null) {
      const idx = Number(digit) - 1;
      const v = values[idx];
      return v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }
    return skillDir;
  });
}

/** 执行 !`cmd` 注入:逐个跑命令,用 fenced 输出替换;失败降级为提示而非中断。 */
async function injectCommands(body: string, skillDir: string, signal?: AbortSignal): Promise<string> {
  const re = /!`([^`]+)`/g;
  let count = 0;
  const out: Array<{ full: string; replacement: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null && count < MAX_INJECTIONS) {
    count++;
    const cmd = m[1];
    let replacement: string;
    try {
      const res = await runCommandRaw(cmd, INJECT_TIMEOUT, signal, skillDir);
      if (res.status === 'denied') {
        replacement = `(command denied: ${res.output})`;
      } else if (res.status === 'timed_out') {
        replacement = '(command timed out)';
      } else if (res.status === 'aborted') {
        replacement = '(command aborted)';
      } else {
        const text =
          res.output.length > MAX_INJECTION_OUTPUT
            ? res.output.slice(0, MAX_INJECTION_OUTPUT) + '\n…(truncated)'
            : res.output;
        replacement = text.trim() || '(no output)';
      }
    } catch (e) {
      replacement = `(command failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    out.push({ full: m[0], replacement: '```\n' + replacement + '\n```' });
  }
  let result = body;
  for (const { full, replacement } of out) {
    result = result.replace(full, replacement);
  }
  return result;
}

/**
 * 渲染 skill 正文(占位符 + 可选命令注入)。
 * 非 project 或已信任的 project skill 才执行注入;否则先尝试一次性确认,未通过则跳过注入。
 * 返回 null 表示正文缺失(调用方生成「未找到」错误)。
 */
export async function renderSkillBody(
  skill: Skill,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const raw = getSkillBody(skill.name);
  if (raw === null) return null;
  let body = substituteArgs(raw, args, skill.dir);
  if (/!`[^`]+`/.test(body)) {
    // 非 project 恒信任;project 依次查信任记录、再弹一次性确认。
    // ensureSkillTrust 的 true 覆盖 'trusted'(已记录)与 'once'(仅本次)两种,直接据此注入。
    const trusted = skill.origin !== 'project' || isSkillTrusted(skill) || (await ensureSkillTrust(skill));
    if (trusted) {
      body = await injectCommands(body, skill.dir, signal);
    } else {
      // 未信任:清掉注入标记,避免把未授权命令留在提示里。
      body = body.replace(/!`[^`]+`/g, '_(command injection skipped: skill not trusted)_');
    }
  }
  return body;
}

/** 把 SpawnResult 转成 ToolOutcome,汇总/计费/变更集透传,不丢回滚信息。 */
function toOutcome(res: SpawnResult): ToolOutcome {
  const status: ToolOutcome['status'] =
    res.status === 'completed' ? 'success' : res.status === 'aborted' ? 'aborted' : 'error';
  return {
    status,
    code: res.status === 'completed' ? 'OK' : res.status === 'aborted' ? 'ABORTED' : 'EXECUTION_ERROR',
    retryable: false,
    output: res.summary ?? (res.status === 'failed' ? '(skill failed with no output)' : ''),
    changeSet: res.changeSet ? toChangeSetSummary(res.changeSet) : undefined,
    usage: res.usage,
  };
}

export interface RunSkillArgs {
  name: string;
  args?: Record<string, unknown>;
  context?: string;
}

/** 读取 skill 目录内附属文件(L2 渐进式披露);越界 / 不存在 / 过大返 null。 */
export function readSkillFile(skill: Skill, file: string, maxBytes: number): string | null {
  // 归一为绝对路径,并强制留在 skill.dir 内(禁止 ../ 逃逸)。
  const base = resolve(skill.dir);
  const abs = resolve(base, file);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  if (!existsSync(abs)) return null;
  try {
    if (statSync(abs).size > maxBytes) return `(file too large: ${file})`;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** 能产生副作用的 mocode 工具;用于在未显式声明 agent: 时推断 fork 子 agent 的模式。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

/**
 * fork 子 agent 模式:`agent:` 显式声明优先;否则按工具面推断——
 * 未声明 allowed-tools(完整工具集)或白名单含写工具 → 'write',纯只读白名单 → 'read'。
 * 避免写类 skill 因缺省字段被静默降级为只读。
 */
export function resolveSpawnMode(skill: Skill, tools: string[] | null): 'read' | 'write' {
  if (skill.agentMode) return skill.agentMode;
  if (tools === null || tools.some((t) => WRITE_TOOLS.has(t))) return 'write';
  return 'read';
}

/**
 * 执行一个 skill(无论 inline 还是 fork 都走隔离子 agent,保证「可执行」语义统一):
 *  - 找不到 → UNKNOWN_TOOL 语义 error
 *  - 执行面门禁(ensureSkillTrust)未过 → denied
 *  - 渲染正文 → spawnAgent(白名单工具 / mode / maxSteps / signal)
 *  - 子 agent 摘要回灌为 output,usage / changeSet 透传
 */
export async function runSkill(a: RunSkillArgs, ctx?: ToolContext): Promise<ToolOutcome> {
  const name = String(a.name ?? '').trim();
  if (!name) {
    return { status: 'error', code: 'INVALID_ARGUMENTS', retryable: false, output: '错误:缺少 skill 名。' };
  }
  const skill = findSkill(name);
  if (!skill) {
    return { status: 'error', code: 'UNKNOWN_TOOL', retryable: false, output: `错误:未找到 skill "${name}"。` };
  }
  if (!(await ensureSkillTrust(skill))) {
    return {
      status: 'denied',
      code: 'PERMISSION_DENIED',
      retryable: false,
      output: `拒绝:skill "${name}" 未获信任,已取消执行。`,
    };
  }
  let body = await renderSkillBody(skill, a.args, ctx?.signal);
  if (body === null) {
    return { status: 'error', code: 'UNKNOWN_TOOL', retryable: false, output: `错误:未找到 skill "${name}" 的正文。` };
  }
  const { tools, unknown } = mapSkillTools(skill.allowedTools);
  if (unknown.length) {
    // 仅记到正文前导,模型可感知哪些 allowed-tools 被忽略(不阻断执行)。
    body = `> 注意:以下 allowed-tools 无法映射到 mocode 工具,已忽略: ${unknown.join(', ')}\n\n` + body;
  }
  const res = await spawnAgent({
    prompt: SKILL_PROTOCOL_HEADER + '\n\n' + body,
    tools: tools ?? undefined,
    mode: resolveSpawnMode(skill, tools),
    maxSteps: skill.maxSteps,
    signal: ctx?.signal,
    context: a.context,
    systemPromptSuffix: `You are executing the "${skill.name}" skill. SKILL_DIR=${skill.dir}`,
    quiet: true, // fork skill 是 opaque workflow,不产可展开 batch
    quietLabel: `执行 ${skill.name}…`,
  });
  return toOutcome(res);
}
