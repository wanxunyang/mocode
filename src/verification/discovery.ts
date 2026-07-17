import { existsSync } from 'node:fs';
import path from 'node:path';
import { discoverProjectProfile } from './profile.js';
import type { PackageProfile, ProjectProfile } from './profile.js';
import type { ValidationCommand } from './types.js';

const SCRIPT_PRIORITY = ['typecheck', 'test', 'build'] as const;
const isWindows = process.platform === 'win32';

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return isWindows
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Discover one lowest-cost validation command for a package in a project profile. */
export function discoverPackageValidationCommand(
  profile: ProjectProfile,
  packageProfile: PackageProfile,
): ValidationCommand | null {
  const script = SCRIPT_PRIORITY.find((name) => typeof packageProfile.scripts[name] === 'string');
  if (!script) return null;
  return {
    script,
    command: `${profile.packageManager} run ${script}`,
    packageManager: profile.packageManager,
    cwd: packageProfile.root,
  };
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
