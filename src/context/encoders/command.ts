import type { ContextEncoder } from '../types.js';
import { stripAnsi } from './_util.js';

interface Diagnostic {
  file: string;
  line: string;
  column?: string;
  severity: string;
  message: string;
  continuation: string[];
}

const PAREN_DIAGNOSTIC = /^(.*)\((\d+),(\d+)\):\s*(error|warning|warn|fatal|note)\b\s*:?\s*(.*)$/i;
const COL_DIAGNOSTIC = /^(.*):(\d+):(\d+):\s*(error|warning|warn|fatal|note)\b\s*:?\s*(.*)$/i;
const LINE_DIAGNOSTIC = /^(.*):(\d+):\s*(error|warning|warn|fatal|note)\b\s*:?\s*(.*)$/i;
const PASS_LINE = /^\s*(?:PASS\b|PASSED\b|✓|✔|✅|ok\b)/i;
const FAIL_LINE = /^\s*(?:FAIL\b|FAILED\b|ERROR\b|✗|×|❌|not ok\b|●)/i;
const TEST_SUMMARY = /^\s*(?:Test Suites?|Tests?|Ran\s+\d+|=+\s|\d+\s+(?:passed|failed|errors?))/i;
const IMPORTANT_LINE = /\b(?:error|failed|failure|fatal|exception|panic)\b|not ok|[✗×❌]/i;
const TEST_COMMAND = /\b(?:test|vitest|jest|pytest|mocha|ava|tap|cargo\s+test|go\s+test|dotnet\s+test)\b/i;

function parseDiagnostic(line: string): Diagnostic | null {
  const m = PAREN_DIAGNOSTIC.exec(line) ?? COL_DIAGNOSTIC.exec(line);
  if (m) {
    return { file: m[1], line: m[2], column: m[3], severity: m[4], message: m[5], continuation: [] };
  }
  const lineOnly = LINE_DIAGNOSTIC.exec(line);
  if (!lineOnly) return null;
  return {
    file: lineOnly[1],
    line: lineOnly[2],
    severity: lineOnly[3],
    message: lineOnly[4],
    continuation: [],
  };
}

function splitStatus(text: string): { status: string | null; lines: string[] } {
  const lines = text.split('\n');
  const status = /^\[(?:退出码 [^\]]+|已中断|超时,已终止)\]$/.test(lines[0] ?? '')
    ? lines.shift()!
    : null;
  return { status, lines };
}
function formatDiagnostics(lines: string[]): { text: string; count: number } | null {
  const diagnostics: Diagnostic[] = [];
  const other: string[] = [];
  let current: Diagnostic | null = null;
  for (const line of lines) {
    const diagnostic = parseDiagnostic(line);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      current = diagnostic;
    } else if (current && (/^\s+/.test(line) || /^[\^~|]/.test(line))) {
      current.continuation.push(line);
    } else {
      current = null;
      other.push(line);
    }
  }
  if (diagnostics.length === 0) return null;

  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const group = groups.get(diagnostic.file) ?? [];
    group.push(diagnostic);
    groups.set(diagnostic.file, group);
  }
  const errors = diagnostics.filter((d) => /^(?:error|fatal)$/i.test(d.severity)).length;
  const warnings = diagnostics.filter((d) => /^(?:warning|warn)$/i.test(d.severity)).length;
  const out = [`# Build diagnostics · ${diagnostics.length} issues · ${groups.size} files · command-encoded`];
  if (errors || warnings) out.push(`# ${errors} errors · ${warnings} warnings`);
  for (const [file, items] of groups) {
    out.push(`${file}:`);
    for (const item of items) {
      const location = item.column ? `${item.line}:${item.column}` : item.line;
      out.push(`  ${location}: ${item.severity}${item.message ? `: ${item.message}` : ''}`);
      for (const continuation of item.continuation) out.push(`    ${continuation}`);
    }
  }
  if (other.some((line) => line.length > 0)) out.push('# Other output', ...other);
  return { text: out.join('\n'), count: diagnostics.length };
}

interface TestBlock {
  kind: 'pass' | 'fail';
  lines: string[];
}

function formatTests(lines: string[], command: string): { text: string; count: number } | null {
  const blocks: TestBlock[] = [];
  const other: string[] = [];
  let current: TestBlock | null = null;
  let markers = 0;
  for (const line of lines) {
    const kind = FAIL_LINE.test(line) ? 'fail' : PASS_LINE.test(line) ? 'pass' : null;
    if (kind) {
      current = { kind, lines: [line] };
      blocks.push(current);
      markers++;
    } else if (current && line.length > 0 && /^\s+/.test(line) && !TEST_SUMMARY.test(line)) {
      current.lines.push(line);
    } else {
      current = null;
      other.push(line);
    }
  }
  if (markers === 0 || (markers < 2 && !TEST_COMMAND.test(command))) return null;

  const failed = blocks.filter((block) => block.kind === 'fail');
  const passed = blocks.filter((block) => block.kind === 'pass');
  const out = [`# Test results · ${passed.length} passed · ${failed.length} failed · command-encoded`];
  if (failed.length) {
    out.push(`# Failed tests (${failed.length})`);
    for (const block of failed) out.push(...block.lines);
  }
  if (passed.length) {
    out.push(`# Passed tests (${passed.length})`);
    for (const block of passed) out.push(...block.lines);
  }
  if (other.some((line) => line.length > 0)) out.push('# Test summary / other output', ...other);
  return { text: out.join('\n'), count: markers };
}
function collapseDuplicateLines(text: string): { text: string; runs: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let runs = 0;
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    while (end < lines.length && lines[end] === lines[i]) end++;
    const count = end - i;
    if (count >= 3) {
      out.push(`${lines[i]}  [×${count}]`);
      runs++;
    } else {
      for (let j = i; j < end; j++) out.push(lines[j]);
    }
    i = end;
  }
  return { text: out.join('\n'), runs };
}

function errorTail(text: string, max: number): string {
  if (max <= 0) return '';
  const lines = text.split('\n');
  let important = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IMPORTANT_LINE.test(lines[i])) {
      important = i;
      break;
    }
  }
  if (important < 0) return text.slice(-max);
  const fromError = lines.slice(Math.max(0, important - 1)).join('\n');
  if (fromError.length <= max) return fromError;
  const joiner = '\n…[错误详情中段省略]…\n';
  const errorHead = Math.max(0, Math.floor((max - joiner.length) * 0.65));
  const finalTail = Math.max(0, max - joiner.length - errorHead);
  return fromError.slice(0, errorHead) + joiner + fromError.slice(-finalTail);
}

function truncateCommand(text: string, budget?: number): { text: string; truncated: boolean } {
  if (!budget || text.length <= budget) return { text, truncated: false };
  const marker = '\n…[command 输出已结构化截断；保留开头与错误尾部]…\n';
  const available = budget - marker.length;
  if (available <= 0) return { text: marker.slice(0, budget), truncated: true };
  const headSize = Math.floor(available * 0.45);
  const tailSize = available - headSize;
  return {
    text: text.slice(0, headSize) + marker + errorTail(text, tailSize),
    truncated: true,
  };
}

/** run_command 专用 encoder：构建诊断分文件、测试结果分 pass/fail，并按错误尾部优先截断。 */
export const commandEncoder: ContextEncoder = {
  kind: 'log',
  encode({ output, args, budget }) {
    const stripped = stripAnsi(output).replace(/\r\n?/g, '\n');
    const { status, lines } = splitStatus(stripped);
    const command = typeof args?.command === 'string' ? args.command : '';
    const diagnostics = formatDiagnostics(lines);
    const tests = diagnostics ? null : formatTests(lines, command);
    const structured = diagnostics?.text ?? tests?.text ?? lines.join('\n');
    const withStatus = status ? `${status}\n${structured}` : structured;
    const collapsed = collapseDuplicateLines(withStatus);
    const fitted = truncateCommand(collapsed.text, budget);
    const mode = diagnostics ? `build:${diagnostics.count}` : tests ? `tests:${tests.count}` : 'generic';
    const notes = [mode, 'ANSI stripped'];
    if (collapsed.runs) notes.push(`${collapsed.runs} dup runs collapsed`);
    if (fitted.truncated) notes.push('head+error-tail truncated');
    return {
      text: fitted.text,
      meta: {
        kind: 'log',
        originalLen: output.length,
        encodedLen: fitted.text.length,
        note: notes.join(', '),
      },
    };
  },
};