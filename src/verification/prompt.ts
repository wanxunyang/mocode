import path from 'node:path';
import { discoverPackageValidationCommands } from './discovery.js';
import { discoverProjectProfile } from './profile.js';
import type { PackageProfile, ProjectProfile } from './profile.js';

/** Keep the prompt section small on large monorepos; the agent can still discover the rest. */
const MAX_LISTED_PACKAGES = 8;

function displayRoot(profile: ProjectProfile, packageProfile: PackageProfile): string {
  const relative = path.relative(profile.root, packageProfile.root);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

function lineFor(profile: ProjectProfile, packageProfile: PackageProfile): string | null {
  const commands = discoverPackageValidationCommands(profile, packageProfile);
  if (commands.length === 0) return null;
  const cwd = displayRoot(profile, packageProfile);
  const rendered = commands.map((item) => `\`${item.command}\``).join(', ');
  return `- ${packageProfile.name} (cwd \`${cwd}\`): ${rendered}`;
}

/**
 * Deterministic project validation map injected into the system prompt: which package owns which
 * script, and the exact command plus cwd to run it. Commands are listed in increasing cost order
 * (typecheck → build → test) and are never executed here — this is evidence, not a completion gate.
 *
 * Returns '' when no package exposes a validation script, or when discovery fails for any reason
 * (missing/invalid manifest, unreadable workspace): prompt construction must never break.
 */
export function buildValidationCommandsSection(root: string = process.cwd()): string {
  try {
    const profile = discoverProjectProfile(root);
    const lines: string[] = [];
    let omitted = 0;
    for (const packageProfile of profile.packages) {
      const line = lineFor(profile, packageProfile);
      if (!line) continue;
      if (lines.length >= MAX_LISTED_PACKAGES) omitted += 1;
      else lines.push(line);
    }
    if (lines.length === 0) return '';
    if (omitted > 0) {
      lines.push(`- …${omitted} more package(s) with scripts: read their package.json when needed.`);
    }
    return [
      '',
      '## Validation commands (discovered from project manifests)',
      'Listed in increasing cost order. Use them when a check is worth running; prefer the package that owns your change over repository-wide runs. Not a completion gate.',
      ...lines,
    ].join('\n');
  } catch {
    return ''; // Discovery is best-effort: never let it break prompt construction.
  }
}
