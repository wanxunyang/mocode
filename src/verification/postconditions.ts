import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ValidationDiagnostic,
  ValidationStageResult,
} from './types.js';

export interface WritePostconditionResult {
  status: 'passed' | 'failed';
  expectedHash: string;
  actualHash?: string;
  diagnostics: ValidationDiagnostic[];
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function diagnostic(file: string, code: string, message: string): ValidationDiagnostic {
  return {
    level: 'V0',
    source: 'postcondition',
    severity: 'error',
    code,
    file,
    message,
  };
}

function parseJson(file: string, content: string): ValidationDiagnostic[] {
  if (path.extname(file).toLowerCase() !== '.json') return [];
  try {
    JSON.parse(content);
    return [];
  } catch (error) {
    return [diagnostic(file, 'INVALID_JSON', error instanceof Error ? error.message : String(error))];
  }
}

/** Immediate read-after-write verification used by write_file and edit_file. */
export async function verifyWrittenFile(
  file: string,
  expectedContent: string,
): Promise<WritePostconditionResult> {
  const expectedHash = hash(Buffer.from(expectedContent, 'utf8'));
  let actual: Buffer;
  try {
    actual = await readFile(file);
  } catch (error) {
    return {
      status: 'failed',
      expectedHash,
      diagnostics: [diagnostic(file, 'POSTCONDITION_READ_FAILED', error instanceof Error ? error.message : String(error))],
    };
  }

  const actualHash = hash(actual);
  const diagnostics = actualHash === expectedHash
    ? parseJson(file, actual.toString('utf8'))
    : [diagnostic(file, 'CONTENT_HASH_MISMATCH', 'Content read after writing differs from the requested content.')];
  return {
    status: diagnostics.length === 0 ? 'passed' : 'failed',
    expectedHash,
    actualHash,
    diagnostics,
  };
}

/** Re-check current changed files before more expensive validation layers. */
export async function runFilePostconditions(
  root: string,
  changedFiles: readonly string[],
  inputFingerprint: string,
): Promise<ValidationStageResult> {
  const startedAt = Date.now();
  const diagnostics: ValidationDiagnostic[] = [];
  const hashes: string[] = [];
  let checked = 0;

  for (const changedFile of changedFiles) {
    const absolute = path.resolve(process.cwd(), changedFile);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      diagnostics.push(diagnostic(changedFile, 'OUTSIDE_PROJECT', 'Changed path is outside the project root.'));
      continue;
    }
    try {
      const fileStat = await stat(absolute);
      if (!fileStat.isFile()) continue;
      const content = await readFile(absolute);
      checked += 1;
      hashes.push(`${relative.replace(/\\/g, '/')}: ${hash(content)}`);
      diagnostics.push(...parseJson(relative, content.toString('utf8')));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        diagnostics.push(diagnostic(relative, 'POSTCONDITION_READ_FAILED', error instanceof Error ? error.message : String(error)));
      }
    }
  }

  const status = diagnostics.some((item) => item.severity === 'error') ? 'failed' : checked > 0 ? 'passed' : 'skipped';
  return {
    level: 'V0',
    status,
    adapter: 'file-postconditions',
    diagnostics,
    output: status === 'skipped' ? 'No current files require V0 postconditions.' : hashes.join('\n'),
    durationMs: Date.now() - startedAt,
    skipReason: status === 'skipped' ? 'no_current_files' : undefined,
    inputFingerprint,
  };
}

export function formatPostconditionFailure(result: WritePostconditionResult): string {
  return result.diagnostics
    .map((item) => `[${item.code ?? 'V0_FAILED'}] ${item.file ?? ''}: ${item.message}`)
    .join('\n');
}
