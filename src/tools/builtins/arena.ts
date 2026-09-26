import type { Tool, ToolOutcome } from '../types.js';
import { spawnAgent } from '../../agent/spawn.js';
import { chat, type ChatMessage } from '../../llm/index.js';
import { effectiveSystemPrompt } from '../../skills/index.js';

// ---------- arena ----------
// D2 Arena：同一任务并行派生 N 个独立子 agent（各自独立 history、不同随机分支），
// 收齐后用一次模型调用当 judge，按给定标准对候选排序，返回排名 + 最优方案。
//
// 定位：方案 / 答案的“多跑几遍选最好”（生成候选文本）。N 个 agent 并发跑，
// 因此不要让它们并发改同一工作区文件——适合探索、设计、解题、给方案。
export const arenaTool: Tool = {
  name: 'arena',
  risk: 'dangerous',
  description: [
    'Run the same task N times in parallel as independent workers, then have a judge model rank every candidate and return the best one with the full ranking.',
    'Use for design/exploration/problem-solving where sampling several independent attempts and picking the best beats a single attempt. Not for parallel file edits.',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task given identically to every candidate worker.',
      },
      candidates: {
        type: 'number',
        description: 'Number of parallel attempts (default 3, max 6).',
      },
      criteria: {
        type: 'string',
        description: 'Optional judging criteria the judge ranks candidates against.',
      },
      maxSteps: {
        type: 'number',
        description: 'Optional per-candidate step ceiling.',
      },
    },
    required: ['prompt'],
  },
  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '');
    if (!prompt) return 'arena requires a prompt';
    const n = Math.min(6, Math.max(2, Math.floor(Number(args.candidates) || 3)));
    const criteria = typeof args.criteria === 'string' ? args.criteria : 'correctness, completeness, clarity';
    const maxSteps = typeof args.maxSteps === 'number' && args.maxSteps > 0 ? Math.floor(args.maxSteps) : undefined;

    // 并行派生，quiet：不刷屏，结果只在本工具内汇总。
    const settled = await Promise.allSettled(
      Array.from({ length: n }, (_, i) =>
        spawnAgent({
          prompt: `[Arena candidate #${i + 1} of ${n}]\n${prompt}`,
          quiet: true,
          maxSteps,
          signal: ctx?.signal,
          parentAllowedToolNames: ctx?.allowedToolNames,
        }),
      ),
    );

    interface Cand {
      label: string;
      text: string;
      tokens: number;
    }
    const candidates: Cand[] = [];
    settled.forEach((r, i) => {
      const label = `candidate-${i + 1}`;
      if (r.status === 'fulfilled' && r.value.summary) {
        candidates.push({ label, text: r.value.summary, tokens: r.value.usage.totalTokens });
      } else {
        candidates.push({
          label,
          text: r.status === 'rejected' ? `(worker threw: ${String(r.reason).slice(0, 120)})` : '(no result)',
          tokens: 0,
        });
      }
    });

    // judge：一次性模型调用，要求返回严格 JSON 排名。
    const judgeMessages: ChatMessage[] = [
      {
        role: 'system',
        content: effectiveSystemPrompt(
          'You are an impartial judge ranking candidate solutions. Output ONLY minified JSON of the form ' +
            '{"ranking":[{"label":"candidate-1","score":0-100,"reason":"..."}],"winner":"candidate-1"}. ' +
            'Rank best first. Every label must be one of the provided candidate labels.',
        ),
      },
      {
        role: 'user',
        content: [
          `Task:\n${prompt}`,
          `Ranking criteria: ${criteria}`,
          ...candidates.map((c) => `--- ${c.label} ---\n${c.text.slice(0, 6000)}`),
          'Rank the candidates and pick a winner. Respond with JSON only.',
        ].join('\n\n'),
      },
    ];

    let rankingText: string;
    let judgeUsage: import('../../llm/index.js').ChatUsage | undefined;
    try {
      const res = await chat(judgeMessages, {}, ctx?.signal);
      rankingText = res.content ?? '';
      judgeUsage = res.usage;
    } catch (e) {
      rankingText = '';
      process.stderr.write(`[arena] judge call failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    const parsed = parseJudgeJson(
      rankingText,
      candidates.map((c) => c.label),
    );
    const lines: string[] = [`Arena: ${n} candidates for: ${prompt.split('\n')[0].slice(0, 100)}`, ''];
    if (parsed) {
      for (const [i, item] of parsed.ranking.entries()) {
        lines.push(`${i + 1}. ${item.label}  score=${item.score}  ${item.reason}`);
      }
      lines.push('', `WINNER: ${parsed.winner}`, '', `--- ${parsed.winner} full output ---`);
      const winner = candidates.find((c) => c.label === parsed.winner);
      lines.push(winner?.text ?? '(missing)');
    } else {
      lines.push('(judge JSON unparseable; showing candidates in spawn order)');
      for (const c of candidates) lines.push('', `--- ${c.label} (tokens=${c.tokens}) ---`, c.text);
    }

    const output = lines.join('\n');
    // 汇总全部 candidate + judge 的用量。
    const sum = (k: keyof NonNullable<typeof judgeUsage>): number =>
      settled.reduce(
        (acc, r) => acc + (r.status === 'fulfilled' ? (r.value.usage?.[k] ?? 0) : 0),
        judgeUsage?.[k] ?? 0,
      );
    const outcome: ToolOutcome = {
      status: 'success',
      code: 'OK',
      retryable: false,
      output,
      usage: {
        promptTokens: sum('promptTokens'),
        completionTokens: sum('completionTokens'),
        totalTokens: sum('totalTokens'),
        cachedTokens: sum('cachedTokens'),
        reasoningTokens: sum('reasoningTokens'),
      },
    };
    return outcome;
  },
};

interface JudgeItem {
  label: string;
  score: number;
  reason: string;
}

function parseJudgeJson(text: string, validLabels: string[]): { ranking: JudgeItem[]; winner: string } | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as {
      ranking?: Array<{ label?: unknown; score?: unknown; reason?: unknown }>;
      winner?: unknown;
    };
    if (!Array.isArray(obj.ranking) || typeof obj.winner !== 'string') return null;
    const ranking: JudgeItem[] = obj.ranking
      .filter((r) => typeof r.label === 'string' && validLabels.includes(r.label))
      .map((r) => ({
        label: String(r.label),
        score: typeof r.score === 'number' ? r.score : Number(r.score) || 0,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 160) : '',
      }));
    if (ranking.length === 0) return null;
    const winner = validLabels.includes(obj.winner) ? obj.winner : (ranking[0]?.label ?? validLabels[0]);
    return { ranking, winner: winner ?? validLabels[0]! };
  } catch {
    return null;
  }
}
