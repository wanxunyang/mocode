import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  ValidationDiagnostic,
  ValidationLevel,
  ValidationStatus,
} from './types.js';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value: string, root: string): string {
  const normalizedRoot = path.resolve(root).replace(/\\/g, '/');
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\\/g, '/')
    .replaceAll(normalizedRoot, '<root>')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** Fingerprint the relevant on-disk inputs, so rewriting identical content can reuse validation. */
export function fingerprintFiles(root: string, files: readonly string[]): string {
  const entries = [...new Set(files)].sort().map((file) => {
    const absolute = path.resolve(process.cwd(), file);
    const display = path.relative(root, absolute).replace(/\\/g, '/');
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) return `${display}\0<${stat.isDirectory() ? 'directory' : 'other'}>`;
      return `${display}\0${sha256(readFileSync(absolute))}`;
    } catch {
      return `${display}\0<missing>`;
    }
  });
  return sha256(entries.join('\n'));
}

export function fingerprintValidation(input: {
  root: string;
  level?: ValidationLevel;
  status: ValidationStatus;
  adapter?: string;
  command?: string;
  diagnostics: readonly ValidationDiagnostic[];
  output?: string;
}): string {
  const diagnostics = [...input.diagnostics]
    .map((item) => ({
      source: item.source,
      severity: item.severity,
      code: item.code ?? '',
      file: item.file ? normalizeText(item.file, input.root) : '',
      line: item.line ?? 0,
      column: item.column ?? 0,
      message: normalizeText(item.message, input.root),
      packageName: item.packageName ?? '',
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(JSON.stringify({
    level: input.level ?? '',
    status: input.status,
    adapter: input.adapter ?? '',
    command: input.command ? normalizeText(input.command, input.root) : '',
    diagnostics,
    output: diagnostics.length === 0 ? normalizeText(input.output ?? '', input.root) : '',
  }));
}
