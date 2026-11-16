/**
 * 子 agent 卡片里「它做过什么」的解析层（纯函数，主进程与渲染层共用）。
 *
 * 数据来源：`src/agent/spawn.ts` 在有宿主 progress 通道（无 TUI）时，对每次内部工具调用
 * 往宿主 output 里写两类行：
 *   · `▸ 工具名  对象`         —— 人类可读一行，老宿主只能拿到这个；
 *   · `[sub-tool]{json}`       —— 机器行，start/end 两条成对，带**完整入参**与**该次调用的输出**。
 *
 * 为什么单独成模块：渲染层（浏览器）与恢复日志（主进程）都要判断「哪些行属于子 agent 进度」
 * —— 收尾时 `tool_completed` 的最终结论绝不能把进度行覆盖掉，回放旧会话时也要能还原同样的
 * 可展开条目。两处各写一份正则，格式一改就漂。渲染层无打包器，不能 import 根 src，所以这里的
 * 前缀常量与 spawn.ts 是**同值拷贝**（两边都写了注释互相指认）。
 */

/** 机器行前缀（与 `src/agent/spawn.ts` 的 SUB_TOOL_PREFIX 同值）。 */
export const SUB_TOOL_PREFIX = '[sub-tool]';

/** 一次内部工具调用。start 建立、end 回填；缺 end 时 done=false（子 agent 还在跑或被打断）。 */
export interface SubAgentStep {
  /** 工具名（run_command / read_file …）。 */
  name: string;
  /** 一行摘要：命令、路径或模式（spawn 侧 summarizeToolCall 的结果）。 */
  summary: string;
  /** 完整入参 JSON 原文（已按上限截断）。 */
  args: string;
  /** 该次调用的输出（已按上限截断）；未结束时为空串。 */
  output: string;
  /** 输出被判为错误。 */
  failed: boolean;
  /** 已拿到 end。 */
  done: boolean;
}

/** 子 agent output 拆解结果：结构化步骤 + 只能原样展示的进度行 + 其余正文。 */
export interface SubAgentProgressSplit {
  steps: SubAgentStep[];
  /** 旧的 `▸ …` 文本行（无结构化数据，只能原样铺一篇）。 */
  lines: string[];
  /** 既不是进度也不是结论之外的所有行，按原顺序拼回。 */
  rest: string[];
}

/** 一行是不是子 agent 的进度行（含机器行）——用于收尾合并与回放时保留进度。 */
export function isSubAgentProgressLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith(SUB_TOOL_PREFIX)) return true;
  return /^[▸●↳]\s/.test(trimmed);
}

/** 多行文本里是否含任意一行进度行。 */
export function hasSubAgentProgressLine(text: string): boolean {
  return text.split('\n').some(isSubAgentProgressLine);
}

/** 解析 `[sub-tool]{…}`；坏数据返回 null（宁可当普通文本行，也不能让整张卡片渲染失败）。 */
function parseSubToolLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line.slice(SUB_TOOL_PREFIX.length)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * start/end 配对：从尾部找同工具名且未收尾的那条。
 *
 * 不按 tool_call id 精确匹配，是因为早期/缺 id 的机器行（id 为 ''）与同一步并行调用会让精确匹配
 * 落空；而 spawn 侧的 start/end 严格按同一顺序成对发出，按「最近的同名未收尾」配对是安全且
 * 不会串到别的步骤上的。
 */
function findOpenStep(steps: SubAgentStep[], name: string): SubAgentStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.done) continue;
    if (step.name === name) return step;
  }
  return undefined;
}

/**
 * 把子 agent 的 output 拆成「可展开步骤 / 旧式进度行 / 其余正文」。
 *
 * 兼容两种历史数据：只有 `▸` 行的老会话、带机器行的新会话。解析不出结构的机器行退化成
 * 普通进度行文本，绝不吞内容。
 */
export function splitSubAgentProgress(output: string): SubAgentProgressSplit {
  const split: SubAgentProgressSplit = { steps: [], lines: [], rest: [] };
  let lastStep: SubAgentStep | null = null;
  for (const raw of output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      split.rest.push(raw);
      continue;
    }
    if (line.startsWith(SUB_TOOL_PREFIX)) {
      const payload = parseSubToolLine(line);
      if (!payload) {
        split.lines.push(line);
        continue;
      }
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      const phase = payload.phase === 'end' ? 'end' : 'start';
      if (phase === 'start') {
        const step: SubAgentStep = { name, summary, args: typeof payload.args === 'string' ? payload.args : '', output: '', failed: false, done: false };
        split.steps.push(step);
        lastStep = step;
      } else {
        const target = findOpenStep(split.steps, name) ?? lastStep ?? undefined;
        if (target && !target.done) {
          target.done = true;
          target.failed = payload.failed === true;
          target.output = typeof payload.output === 'string' ? payload.output : '';
          if (!target.summary) target.summary = summary;
        } else {
          // 没配到 start（老版本只发 end / 被截断）：仍然给一条完整条目，不丢信息。
          const step: SubAgentStep = {
            name,
            summary,
            args: '',
            output: typeof payload.output === 'string' ? payload.output : '',
            failed: payload.failed === true,
            done: true,
          };
          split.steps.push(step);
          lastStep = step;
        }
      }
      continue;
    }
    if (/^[▸●↳]\s/.test(line)) {
      split.lines.push(line);
      continue;
    }
    split.rest.push(raw);
  }
  return split;
}