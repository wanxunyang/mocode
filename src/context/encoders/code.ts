import type { ContextEncoder } from '../types.js';

/** read_file line: right-aligned source line number + tab + exact content. */
const LINE_RE = /^(\s*\d+)\t(.*)$/;
const JS_LIKE_PATH_RE = /\.(?:[cm]?js|jsx|ts|tsx)$/i;

interface NumberedLine {
  raw: string;
  line: number;
  content: string;
}

function parseLine(raw: string): NumberedLine | null {
  const match = LINE_RE.exec(raw);
  if (!match) return null;
  return { raw, line: Number(match[1].trim()), content: match[2] };
}

function collapseBlankCodeRuns(output: string): {
  text: string;
  collapsed: number;
} {
  const lines = output.split('\n');
  const out: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    if (parseLine(lines[i])?.content === '') {
      let j = i;
      while (j < lines.length && parseLine(lines[j])?.content === '') j++;
      if (j - i >= 3) {
        out.push(lines[i]);
        collapsed++;
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]);
      }
      i = j;
      continue;
    }
    out.push(lines[i++]);
  }
  return { text: out.join('\n'), collapsed };
}

function isJsLikePath(args: Record<string, unknown> | null): boolean {
  return typeof args?.path === 'string' && JS_LIKE_PATH_RE.test(args.path);
}

function isSingleLineImport(content: string): boolean {
  const line = content.trim();
  return /^import\b/.test(line) && /(?:['"][^'"]+['"]\s*;?|;)$/.test(line);
}
function collapseImportBlocks(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    const first = parseLine(lines[i]);
    if (!first || !isSingleLineImport(first.content)) {
      out.push(lines[i++]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      const next = parseLine(lines[j]);
      if (!next || !isSingleLineImport(next.content)) break;
      j++;
    }
    const run = j - i;
    if (run >= 4) {
      const last = parseLine(lines[j - 1])!;
      out.push(lines[i]);
      out.push(`… ${run - 2} import lines folded (source lines ${first.line + 1}–${last.line - 1}; cold read)`);
      out.push(lines[j - 1]);
      collapsed++;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  const result = out.join('\n');
  return result.length < text.length
    ? { text: result, collapsed }
    : { text, collapsed: 0 };
}

interface LexState {
  quote: "'" | '"' | '`' | null;
  escaped: boolean;
  blockComment: boolean;
}

function braceDelta(line: string, state: LexState): number {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.blockComment) {
      if (ch === '*' && next === '/') {
        state.blockComment = false;
        i++;
      }
      continue;
    }
    if (state.quote) {
      if (state.escaped) {
        state.escaped = false;
      } else if (ch === '\\') {
        state.escaped = true;
      } else if (ch === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') {
      state.blockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state.quote = ch;
      state.escaped = false;
      continue;
    }
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  state.escaped = false;
  return delta;
}
function isFunctionStart(content: string): boolean {
  return (
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s+[\w$]+)?\s*\(/.test(content) ||
    /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=.*=>\s*\{\s*$/.test(content) ||
    /^\s*(?:(?:public|private|protected|static|abstract|override|async|get|set)\s+)*(?:constructor|[\w$]+)\s*\([^;]*\)\s*(?::[^={]+)?\s*\{\s*$/.test(content)
  );
}

function collapseFunctionBodies(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    const start = parseLine(lines[i]);
    if (!start || !isFunctionStart(start.content)) {
      out.push(lines[i++]);
      continue;
    }

    const state: LexState = { quote: null, escaped: false, blockComment: false };
    let depth = braceDelta(start.content, state);
    if (depth <= 0) {
      out.push(lines[i++]);
      continue;
    }

    let j = i + 1;
    for (; j < lines.length && depth > 0; j++) {
      const current = parseLine(lines[j]);
      if (!current) break;
      depth += braceDelta(current.content, state);
    }
    const endIndex = j - 1;
    const end = parseLine(lines[endIndex] ?? '');
    const bodyLines = endIndex - i - 1;
    if (depth === 0 && end && bodyLines >= 8) {
      out.push(lines[i]);
      out.push(`… ${bodyLines} function-body lines folded (source lines ${start.line + 1}–${end.line - 1}; cold read)`);
      out.push(lines[endIndex]);
      collapsed++;
      i = j;
    } else {
      out.push(lines[i++]);
    }
  }
  const result = out.join('\n');
  return result.length < text.length
    ? { text: result, collapsed }
    : { text, collapsed: 0 };
}

export const codeEncoder: ContextEncoder = {
  kind: 'code',
  encode(input) {
    const blankResult = collapseBlankCodeRuns(input.output);
    let text = blankResult.text;
    const notes: string[] = [];
    if (blankResult.collapsed) notes.push(`collapsed ${blankResult.collapsed} blank runs`);

    if (
      input.phase === 'sweep' &&
      input.isCold === true &&
      (input.age ?? 0) >= 2 &&
      input.isFirstRead === false &&
      isJsLikePath(input.args)
    ) {
      const imports = collapseImportBlocks(text);
      text = imports.text;
      if (imports.collapsed) notes.push(`folded ${imports.collapsed} import blocks`);
      const functions = collapseFunctionBodies(text);
      text = functions.text;
      if (functions.collapsed) notes.push(`folded ${functions.collapsed} function bodies`);
    }

    return {
      text,
      meta: {
        kind: 'code',
        originalLen: input.output.length,
        encodedLen: text.length,
        note: notes.join(', ') || 'no change',
      },
    };
  },
};
