import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ValidationCommand } from './types.js';

interface PackageManifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

const SCRIPT_PRIORITY = ['typecheck', 'test', 'build'] as const;

function packageManagerFromField(value: unknown): ValidationCommand['packageManager'] | null {
  if (typeof value !== 'string') return null;
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/.exec(value.trim());
  return match ? (match[1] as ValidationCommand['packageManager']) : null;
}

function detectPackageManager(root: string, field: unknown): ValidationCommand['packageManager'] {
  const declared = packageManagerFromField(field);
  if (declared) return declared;
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Discover one lowest-cost project validation command. No shell input comes from packageManager. */
export function discoverValidationCommand(root: string): {
  command: ValidationCommand | null;
  reason?: 'no_package_json' | 'no_validation_script';
} {
  const manifestPath = path.join(root, 'package.json');
  if (!existsSync(manifestPath)) return { command: null, reason: 'no_package_json' };

  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  } catch {
    return { command: null, reason: 'no_validation_script' };
  }

  const script = SCRIPT_PRIORITY.find((name) => typeof manifest.scripts?.[name] === 'string');
  if (!script) return { command: null, reason: 'no_validation_script' };
  const packageManager = detectPackageManager(root, manifest.packageManager);
  return {
    command: {
      script,
      command: `${packageManager} run ${script}`,
      packageManager,
      cwd: root,
    },
  };
}
