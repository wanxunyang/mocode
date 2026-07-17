import { existsSync } from 'node:fs';
import path from 'node:path';
import { discoverProjectProfile } from './profile.js';
import type { ValidationCommand } from './types.js';

const SCRIPT_PRIORITY = ['typecheck', 'test', 'build'] as const;

/** Discover one lowest-cost project validation command from the cached project profile. */
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
    const rootPackage = profile.packages.find((item) => item.root === resolvedRoot);
    const script = SCRIPT_PRIORITY.find((name) => typeof rootPackage?.scripts[name] === 'string');
    if (!script) return { command: null, reason: 'no_validation_script' };
    return {
      command: {
        script,
        command: `${profile.packageManager} run ${script}`,
        packageManager: profile.packageManager,
        cwd: resolvedRoot,
      },
    };
  } catch {
    return { command: null, reason: 'no_validation_script' };
  }
}
