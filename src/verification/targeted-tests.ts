import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AffectedPackage } from './affected.js';
import type { ProjectProfile } from './profile.js';
import type { ValidationCommand } from './types.js';

export interface TargetedTestCommand {
  affected: AffectedPackage;
  command: ValidationCommand;
  adapter: 'vitest' | 'jest' | 'node-test';
  files: string[];
}

const TEST_FILE = /(?:^|[/\\])(?:__tests__[/\\].+|.+\.(?:test|spec))\.[cm]?[jt]sx?$/i;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function quoteArg(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function adapterFor(script: string): TargetedTestCommand['adapter'] | null {
  if (/\bvitest\b/i.test(script)) return 'vitest';
  if (/\bjest\b/i.test(script)) return 'jest';
  if (/\bnode\s+--test\b/i.test(script)) return 'node-test';
  return null;
}

function candidateTests(source: string): string[] {
  if (TEST_FILE.test(source)) return [source];
  if (!SOURCE_EXTENSION.test(source) || source.endsWith('.d.ts')) return [];
  const extension = path.extname(source);
  const stem = source.slice(0, -extension.length);
  const base = path.basename(stem);
  const directory = path.dirname(source);
  return [
    `${stem}.test${extension}`,
    `${stem}.spec${extension}`,
    path.join(directory, '__tests__', `${base}.test${extension}`),
    path.join(directory, '__tests__', `${base}.spec${extension}`),
  ];
}

function runnerArgs(adapter: TargetedTestCommand['adapter'], script: string): string[] {
  if (adapter === 'vitest' && !/\bvitest\s+run\b/i.test(script)) return ['--run'];
  if (adapter === 'jest') return ['--runInBand'];
  return [];
}

/** Discover reliable direct/co-located tests without crossing package boundaries. */
export function discoverTargetedTestCommands(
  profile: ProjectProfile,
  affectedPackages: readonly AffectedPackage[],
): TargetedTestCommand[] {
  const selected: TargetedTestCommand[] = [];
  for (const affected of affectedPackages) {
    const script = affected.package.scripts.test;
    if (typeof script !== 'string') continue;
    const adapter = adapterFor(script);
    if (!adapter) continue;

    const files = new Set<string>();
    for (const reason of affected.reasons) {
      if (reason.kind !== 'direct_change') continue;
      const changed = path.resolve(profile.root, reason.changedPath);
      if (!inside(affected.package.root, changed)) continue;
      for (const candidate of candidateTests(changed)) {
        if (existsSync(candidate) && isFile(candidate) && inside(affected.package.root, candidate)) {
          files.add(candidate);
        }
      }
    }
    if (files.size === 0) continue;

    const relativeFiles = [...files]
      .map((file) => path.relative(affected.package.root, file))
      .sort();
    const args = [...runnerArgs(adapter, script), ...relativeFiles].map(quoteArg).join(' ');
    selected.push({
      affected,
      adapter,
      files: relativeFiles,
      command: {
        script: 'test',
        command: `${profile.packageManager} run test -- ${args}`,
        packageManager: profile.packageManager,
        cwd: affected.package.root,
      },
    });
  }
  return selected;
}
