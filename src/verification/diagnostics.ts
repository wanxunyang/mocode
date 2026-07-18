import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ValidationDiagnostic,
  ValidationStageResult,
} from './types.js';

type TypeScriptApi = typeof import('typescript');
const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);

async function loadTypeScript(root: string): Promise<TypeScriptApi | null> {
  const candidates: string[] = [];
  try {
    candidates.push(createRequire(path.join(root, 'package.json')).resolve('typescript'));
  } catch {
    // Target project may not depend on TypeScript; fall back to mocode's installation.
  }
  try {
    candidates.push(createRequire(import.meta.url).resolve('typescript'));
  } catch {
    // A production install may intentionally omit the optional parser.
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      const loaded = await import(pathToFileURL(candidate).href) as TypeScriptApi & { default?: TypeScriptApi };
      return loaded.default ?? loaded;
    } catch {
      // Try the next resolution root.
    }
  }
  return null;
}

function severity(category: number, ts: TypeScriptApi): ValidationDiagnostic['severity'] {
  if (category === ts.DiagnosticCategory.Error) return 'error';
  if (category === ts.DiagnosticCategory.Warning) return 'warning';
  return 'info';
}

/** Parse only changed TS/JS files; package-wide semantic checking remains V3. */
export async function runChangedFileDiagnostics(
  root: string,
  changedFiles: readonly string[],
  inputFingerprint: string,
): Promise<ValidationStageResult> {
  const startedAt = Date.now();
  const files = [...new Set(changedFiles)]
    .map((file) => path.resolve(process.cwd(), file))
    .filter((file) => SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()));
  if (files.length === 0) {
    return {
      level: 'V1', status: 'skipped', adapter: 'typescript-parser', diagnostics: [],
      output: 'No changed TypeScript or JavaScript files.', durationMs: Date.now() - startedAt,
      skipReason: 'unsupported_files', inputFingerprint,
    };
  }

  const ts = await loadTypeScript(root);
  if (!ts) {
    return {
      level: 'V1', status: 'skipped', adapter: 'typescript-parser', diagnostics: [],
      output: 'TypeScript parser is unavailable.', durationMs: Date.now() - startedAt,
      skipReason: 'typescript_unavailable', inputFingerprint,
    };
  }

  const diagnostics: ValidationDiagnostic[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      diagnostics.push({
        level: 'V1', source: 'typescript', severity: 'error', code: 'READ_FAILED',
        file: path.relative(root, file), message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const result = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.Latest,
      },
    });
    for (const item of result.diagnostics ?? []) {
      const location = item.file && item.start !== undefined
        ? item.file.getLineAndCharacterOfPosition(item.start)
        : undefined;
      diagnostics.push({
        level: 'V1',
        source: 'typescript',
        severity: severity(item.category, ts),
        code: item.code,
        file: item.file ? path.relative(root, item.file.fileName) : path.relative(root, file),
        line: location ? location.line + 1 : undefined,
        column: location ? location.character + 1 : undefined,
        message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
      });
    }
  }

  const failed = diagnostics.some((item) => item.severity === 'error');
  const output = diagnostics.length === 0
    ? `Parsed ${files.length} changed TypeScript/JavaScript file(s).`
    : diagnostics.map((item) =>
      `${item.file ?? '<unknown>'}:${item.line ?? 0}:${item.column ?? 0} TS${item.code ?? ''} ${item.message}`).join('\n');
  return {
    level: 'V1', status: failed ? 'failed' : 'passed', adapter: 'typescript-parser',
    diagnostics, output, durationMs: Date.now() - startedAt, inputFingerprint,
  };
}
