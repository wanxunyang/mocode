import type { ContextEncoder, EncoderInput } from '../types.js';

interface GrepMatch {
  file: string;
  line: string;
  content: string;
}

const LEGACY_GREP_RE = /^(.*?):(\d+):(.*)$/;
const STRUCTURED_HEADER_RE = /^(.*): (\d+) 处匹配,行号 \[([0-9,\s]+)\]$/;
const STRUCTURED_BODY_RE = /^\s{2}L\d+:/;
const STRUCTURED_FOLDED_RE = /^\s{2}\(body 已折叠/;

function isAgedCold(input: EncoderInput): boolean {
  return input.phase === 'sweep' && input.isCold === true && (input.age ?? 0) >= 2;
}

/** Current grep output already has lossless file headers; Cold drops body previews only. */
function collapseStructuredGrep(output: string): { text: string; files: number } | null {
  const lines = output.split('\n');
  const out: string[] = [];
  let files = 0;
  let inFile = false;
  for (const line of lines) {
    if (STRUCTURED_HEADER_RE.test(line)) {
      files++;
      inFile = true;
      out.push(line);
      continue;
    }
    if (inFile && (STRUCTURED_BODY_RE.test(line) || STRUCTURED_FOLDED_RE.test(line))) {
      continue;
    }
    inFile = false;
    out.push(line);
  }
  return files > 0 ? { text: out.join('\n'), files } : null;
}

function encodeLegacyGrep(output: string): { text: string; matches: number; files: number } | null {
  const lines = output.split('\n');
  const matches: GrepMatch[] = [];
  const tail: string[] = [];
  let inTail = false;
  for (const line of lines) {
    if (!line) continue;
    if (inTail) {
      tail.push(line);
      continue;
    }
    const match = LEGACY_GREP_RE.exec(line);
    if (match) {
      matches.push({ file: match[1], line: match[2], content: match[3] });
    } else {
      inTail = true;
      tail.push(line);
    }
  }
  if (matches.length === 0) return null;

  const groups = new Map<string, { line: string; content: string }[]>();
  const order: string[] = [];
  for (const match of matches) {
    if (!groups.has(match.file)) {
      groups.set(match.file, []);
      order.push(match.file);
    }
    groups.get(match.file)!.push({ line: match.line, content: match.content });
  }
  const out = [`# ${matches.length} matches · ${order.length} files · search-encoded`];
  for (const file of order) {
    out.push(`${file}:`);
    for (const item of groups.get(file)!) out.push(`  ${item.line}:${item.content}`);
  }
  if (tail.length) out.push(...tail);
  return { text: out.join('\n'), matches: matches.length, files: order.length };
}
function collapseLegacyBodies(text: string): string {
  if (!text.startsWith('# ') || !text.includes('search-encoded')) return text;
  return text
    .split('\n')
    .filter((line) => !/^\s{2}\d+:/.test(line))
    .join('\n');
}

export const searchEncoder: ContextEncoder = {
  kind: 'search',
  encode(input) {
    const structured = collapseStructuredGrep(input.output);
    if (structured) {
      const text = isAgedCold(input) ? structured.text : input.output;
      return {
        text,
        meta: {
          kind: 'search',
          originalLen: input.output.length,
          encodedLen: text.length,
          note: isAgedCold(input)
            ? `${structured.files} files · Cold body previews removed`
            : `${structured.files} structured grep files · passthrough`,
        },
      };
    }

    // A previous pass may already have transformed legacy file:line output.
    if (input.output.startsWith('# ') && input.output.includes('search-encoded')) {
      const text = isAgedCold(input) ? collapseLegacyBodies(input.output) : input.output;
      return {
        text,
        meta: {
          kind: 'search',
          originalLen: input.output.length,
          encodedLen: text.length,
          note: isAgedCold(input) ? 'Cold legacy bodies removed' : 'already encoded',
        },
      };
    }

    const legacy = encodeLegacyGrep(input.output);
    if (!legacy) {
      return {
        text: input.output,
        meta: {
          kind: 'search',
          originalLen: input.output.length,
          encodedLen: input.output.length,
          note: 'no recognized grep structure → passthrough',
        },
      };
    }

    const text = isAgedCold(input) ? collapseLegacyBodies(legacy.text) : legacy.text;
    return {
      text,
      meta: {
        kind: 'search',
        originalLen: input.output.length,
        encodedLen: text.length,
        note: `${legacy.matches} matches / ${legacy.files} files${isAgedCold(input) ? ' · Cold bodies removed' : ''}`,
      },
    };
  },
};
