import type { ContextEncoder, EncoderInput } from '../types.js';
import { stripAnsi, collapseBlankRuns } from './_util.js';

function isAgedCold(input: EncoderInput): boolean {
  return input.phase === 'sweep' && input.isCold === true && (input.age ?? 0) >= 2;
}

function normalizeBlock(block: string): string {
  return block
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function dedupeFencedBlocks(text: string): { text: string; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const result = text.replace(/```[^\n]*\n[\s\S]*?\n```/g, (block) => {
    const key = normalizeBlock(block);
    if (key.length < 120 || !seen.has(key)) {
      seen.add(key);
      return block;
    }
    removed++;
    return '… duplicate source block omitted (cold graph)';
  });
  return { text: result, removed };
}

function looksLikeSourceBlock(block: string): boolean {
  const lines = block.split('\n');
  const sourceLines = lines.filter((line) =>
    /^\s*\d+\t/.test(line) ||
    /^\s*(?:L)?\d+[:|]\s/.test(line) ||
    /^.*:\d+(?::\d+)?:\s/.test(line),
  ).length;
  return block.length >= 120 && sourceLines >= 3;
}

function dedupeParagraphSourceBlocks(text: string): { text: string; removed: number } {
  const parts = text.split(/(\n{2,})/);
  const seen = new Set<string>();
  let removed = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const block = parts[i];
    if (!looksLikeSourceBlock(block)) continue;
    const key = normalizeBlock(block);
    if (seen.has(key)) {
      parts[i] = '… duplicate source block omitted (cold graph)';
      removed++;
    } else {
      seen.add(key);
    }
  }
  return { text: parts.join(''), removed };
}

export const graphEncoder: ContextEncoder = {
  kind: 'graph',
  encode(input) {
    const stripped = stripAnsi(input.output);
    let text = stripped;
    let duplicates = 0;
    if (isAgedCold(input)) {
      const fenced = dedupeFencedBlocks(text);
      const paragraphs = dedupeParagraphSourceBlocks(fenced.text);
      text = paragraphs.text;
      duplicates = fenced.removed + paragraphs.removed;
    }
    text = collapseBlankRuns(text, 3);

    const notes = [
      /\x1b/.test(input.output) ? 'ANSI stripped' : '',
      text !== stripped && duplicates === 0 ? 'blank runs collapsed' : '',
      duplicates > 0 ? `${duplicates} duplicate source blocks omitted` : '',
    ].filter(Boolean);
    return {
      text,
      meta: {
        kind: 'graph',
        originalLen: input.output.length,
        encodedLen: text.length,
        note: notes.join(', ') || 'no change',
      },
    };
  },
};
