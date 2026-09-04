import type { Tool, ToolOutcome } from '../types.js';
import { appendNoteToSection, NOTE_SECTION_KEYS } from '../../session/notes.js';

/**
 * note_append:往会话笔记 notes.md 的预设笔记段追加一条 finding/decision/
 * open_question/risk。与 plan_update 的边界:
 *  - plan_update 维护执行计划(步骤进度),写 `## Plan:` 段;
 *  - note_append 记发现/决策/问题/风险,写 `## Findings` 等笔记段。
 * 写入的笔记正文会由 reinject 注入 system prompt 并常驻(5k token 预算内),
 * compact 后仍可恢复——构成单会话永久记忆。与 memory_* 的边界:
 *  - note_append 记本会话内、抗 compact 的笔记;
 *  - memory_* 记跨会话稳定事实(另一系统,默认关)。
 *
 * 仿 plan_update:risk=safe,免权限/免 diff/免回滚;capabilities 由 builtins/index.ts
 * 声明为 session-notepad 资源串行(与 plan_update 同款)。
 */
function err(message: string): ToolOutcome {
  return { status: 'error', code: 'INVALID_ARGUMENTS', retryable: false, output: `错误:${message}` };
}

/** 归一化 section:兼容单复数、下划线/空格/连字符、大小写偏差。 */
function normalizeSection(raw: unknown): string | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (NOTE_SECTION_KEYS.includes(s)) return s;
  // 单数/别名归一
  if (['finding', 'find', 'insight', 'insights'].includes(s)) return 'findings';
  if (['decision', 'decide', 'choice', 'choices'].includes(s)) return 'decisions';
  if (['open_question', 'question', 'questions', 'openquestion', 'openquestions'].includes(s)) return 'open_questions';
  if (['risk', 'hazard', 'caveat', 'caveats'].includes(s)) return 'risks';
  return null;
}

export const noteAppendTool: Tool = {
  name: 'note_append',
  description:
    'Append a decision-grade note (a finding, decision, open question, or risk) to the session notepad ' +
    '(`.mocode/sessions/<id>/notes.md`) so it survives context compaction and stays resident in the prompt. ' +
    'Use this for NON-OBVIOUS, lasting-value discoveries — subtle constraints, decisions with downstream impact, ' +
    'open questions that block a choice, or risks that affect later steps. Do NOT use it for routine progress ' +
    '(that is the plan via `plan_update`) or for stable cross-session facts (that is `memory_save`). ' +
    'Notes you write here persist across compaction within this session and are re-injected into the prompt ' +
    'automatically, so the agent keeps remembering what it found/decided. Call it the moment you make the ' +
    'discovery or decision — do not batch to the end.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: NOTE_SECTION_KEYS,
        description:
          'Note category: findings (a non-obvious discovery/constraint), decisions (a choice with ' +
          'lasting impact), open_questions (a blocker needing resolution), risks (a hazard affecting later work).',
      },
      entry: {
        type: 'string',
        description:
          'The note text. One concise, self-contained item: what was found/decided and why it matters. ' +
          'Keep each call to one item — call again for a second item.',
      },
      tag: {
        type: 'string',
        description: 'Optional short label for grouping (e.g. "parser-bug", "api-shape"). Rendered as **[tag]**.',
      },
    },
    required: ['section', 'entry'],
    additionalProperties: false,
  },
  // 兼容模型的 section 命名偏差:单复数/分隔符/别名归一到预设 key。
  normalizeArguments(args) {
    const s = normalizeSection(args.section);
    if (s) args.section = s;
    if (typeof args.tag === 'string') args.tag = args.tag.trim();
  },
  async execute(args): Promise<ToolOutcome> {
    const section = normalizeSection(args.section);
    if (!section) {
      return err(`section 非法:"${String(args.section ?? '')}"(仅 ${NOTE_SECTION_KEYS.join('/')} 或常见别名)。`);
    }
    const entry = String(args.entry ?? '').trim();
    if (!entry) return err('entry 不能为空。');
    if (entry.length > 2000) {
      return err(`entry 过长(${entry.length} 字符,上限 2000)——拆成多条 note_append 或精简。`);
    }
    const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined;

    const result = appendNoteToSection(section, entry, tag);
    if ('error' in result) {
      return {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        output: `错误:写入 notes.md 失败: ${result.error}`,
      };
    }
    // note_append 写内部 notes.md,不作为用户代码 mutation 上报 changedFiles(与 plan_update 一致)。
    const titleMap: Record<string, string> = {
      findings: 'Findings',
      decisions: 'Decisions',
      open_questions: 'Open Questions',
      risks: 'Risks',
    };
    const rendered = tag ? `- **[${tag}]** ${entry}` : `- ${entry}`;
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      output: `已追加笔记到 ## ${titleMap[section]} 段(将常驻 prompt,抗 compact):\n${rendered}`,
    };
  },
};
