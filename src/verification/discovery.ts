import { existsSync } from 'node:fs';
import path from 'node:path';
import { discoverProjectProfile } from './profile.js';
import type { PackageProfile, ProjectProfile } from './profile.js';
import type { ValidationCommand } from './types.js';

const COMPATIBILITY_PRIORITY = ['typecheck', 'test', 'build'] as const;
const LAYERED_ORDER = ['typecheck', 'build', 'test'] as const;
const isWindows = process.platform === 'win32';

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return isWindows
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function commandFor(
  profile: ProjectProfile,
  packageProfile: PackageProfile,
  script: ValidationCommand['script'],
): ValidationCommand {
  return {
    script,
    command: `${profile.packageManager} run ${script}`,
    packageManager: profile.packageManager,
    cwd: packageProfile.root,
  };
}

/** Discover every available V3 command in increasing-cost order. */
export function discoverPackageValidationCommands(
  profile: ProjectProfile,
  packageProfile: PackageProfile,
): ValidationCommand[] {
  return LAYERED_ORDER
    .filter((script) => typeof packageProfile.scripts[script] === 'string')
    .map((script) => commandFor(profile, packageProfile, script));
}

/** Compatibility API retained for callers that intentionally want one command. */
export function discoverPackageValidationCommand(
  profile: ProjectProfile,
  packageProfile: PackageProfile,
): ValidationCommand | null {
  const script = COMPATIBILITY_PRIORITY.find((name) => typeof packageProfile.scripts[name] === 'string');
  return script ? commandFor(profile, packageProfile, script) : null;
}

/** Compatibility wrapper that discovers the root package validation command. */
export function discoverValidationCommand(root: string): {
  command: ValidationCommand | null;
  reason?: 'no_package_json' | 'no_validation_script';
} {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(path.join(resolvedRoot, 'package.json'))) {
    return { command: null, reason: 'no_package_json' };
  }

  try {
    const profile = discoverProjectProfile(resolvedRoot);
    const rootPackage = profile.packages.find((item) => samePath(item.root, resolvedRoot));
    const command = rootPackage ? discoverPackageValidationCommand(profile, rootPackage) : null;
    return command ? { command } : { command: null, reason: 'no_validation_script' };
  } catch {
    return { command: null, reason: 'no_validation_script' };
  }
}
