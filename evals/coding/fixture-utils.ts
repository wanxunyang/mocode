import type { BenchmarkDifficulty, BenchmarkGroup, CodingTaskFixture, FileFixture } from './types.js';

const verifier = (checks: string[]): FileFixture => ({
  path: 'verify.mjs',
  content: `import fs from 'node:fs';\n${checks.join('\n')}\nconsole.log('ok');\n`,
});

export const task = (
  id: string,
  title: string,
  group: BenchmarkGroup,
  goal: string,
  files: FileFixture[],
  checks: string[],
  expectedFiles: string[],
  difficulty: BenchmarkDifficulty = 'basic',
): CodingTaskFixture => ({
  id,
  title,
  group,
  difficulty,
  goal: `${goal} Never modify verify.mjs.`,
  files: [...files, verifier(checks)],
  verificationCommand: 'node verify.mjs',
  timeoutMs: 120_000,
  expected: { verification: 'passed', files: expectedFiles },
});
