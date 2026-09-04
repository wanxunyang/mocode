import path from 'node:path';
import type { PackageProfile, ProjectProfile } from './profile.js';

export type AffectedReasonKind =
  | 'direct_change'
  | 'root_config_change'
  | 'workspace_config_change'
  | 'dependent_change';

export type ChangedPathClassification = 'source' | 'test' | 'generated' | 'vendor' | 'fixture' | 'other';

export interface AffectedReason {
  kind: AffectedReasonKind;
  changedPath: string;
  classification: ChangedPathClassification;
  sourcePackage?: string;
}

export interface AffectedPackage {
  package: PackageProfile;
  reasons: AffectedReason[];
}

export interface RejectedChangedFile {
  input: string;
  reason: 'outside_project' | 'invalid_path';
}

export interface AffectedPackagesResult {
  packages: AffectedPackage[];
  canonicalChangedFiles: string[];
  rejected: RejectedChangedFile[];
  unmatchedFiles: string[];
  affectsAll: boolean;
}

export interface AffectedPackageOptions {
  changedFilesBase: string;
  expandDependents?: (directPackages: readonly PackageProfile[], profile: ProjectProfile) => readonly PackageProfile[];
}

interface CanonicalPath {
  absolute: string;
  key: string;
  display: string;
}

const isWindows = process.platform === 'win32';
const ROOT_CONFIG_NAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

function comparisonKey(value: string): string {
  const resolved = path.resolve(value);
  return isWindows ? resolved.toLowerCase() : resolved;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(comparisonKey(parent), comparisonKey(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function toNativeSeparators(value: string): string {
  return value.replace(/[\\/]/g, path.sep);
}

function canonicalize(profile: ProjectProfile, input: string, base: string): CanonicalPath | RejectedChangedFile {
  if (!input.trim() || input.includes('\0')) return { input, reason: 'invalid_path' };
  try {
    const absolute = path.resolve(base, toNativeSeparators(input));
    if (!isInside(profile.root, absolute)) return { input, reason: 'outside_project' };
    const relative = path.relative(profile.root, absolute);
    return {
      absolute,
      key: comparisonKey(absolute),
      display: relative === '' ? '.' : relative.split(path.sep).join('/'),
    };
  } catch {
    return { input, reason: 'invalid_path' };
  }
}

function matchesAnyRoot(file: string, roots: string[]): boolean {
  return roots.some((root) => isInside(root, file));
}

function classify(file: string, owner: PackageProfile): ChangedPathClassification {
  if (matchesAnyRoot(file, owner.fixtureRoots)) return 'fixture';
  if (matchesAnyRoot(file, owner.generatedRoots)) return 'generated';
  if (matchesAnyRoot(file, owner.vendorRoots)) return 'vendor';
  if (matchesAnyRoot(file, owner.testRoots)) return 'test';
  if (matchesAnyRoot(file, owner.sourceRoots)) return 'source';
  return 'other';
}

function rootConfigReason(profile: ProjectProfile, file: CanonicalPath): AffectedReasonKind | null {
  const workspaceKeys = new Set(profile.workspaceConfigPaths.map(comparisonKey));
  if (workspaceKeys.has(file.key)) return 'workspace_config_change';
  const rootPackage = profile.packages.find((item) => comparisonKey(item.root) === comparisonKey(profile.root));
  const configKeys = new Set(
    [
      ...(rootPackage?.tsconfigPaths ?? []),
      ...(rootPackage?.testConfigPaths ?? []),
      ...(rootPackage?.lintConfigPaths ?? []),
    ].map(comparisonKey),
  );
  if (configKeys.has(file.key)) return 'root_config_change';
  if (comparisonKey(path.dirname(file.absolute)) !== comparisonKey(profile.root)) return null;
  const name = path.basename(file.absolute).toLowerCase();
  if (ROOT_CONFIG_NAMES.has(name) || /^tsconfig(?:\..+)?\.json$/i.test(name)) {
    return name.startsWith('pnpm-workspace') ? 'workspace_config_change' : 'root_config_change';
  }
  return null;
}

function addReason(
  selections: Map<string, AffectedPackage>,
  packageProfile: PackageProfile,
  reason: AffectedReason,
): void {
  const key = comparisonKey(packageProfile.root);
  let selected = selections.get(key);
  if (!selected) {
    selected = { package: packageProfile, reasons: [] };
    selections.set(key, selected);
  }
  if (
    !selected.reasons.some(
      (item) =>
        item.kind === reason.kind &&
        item.changedPath === reason.changedPath &&
        item.sourcePackage === reason.sourcePackage,
    )
  ) {
    selected.reasons.push(reason);
  }
}

/** Map changed paths to their longest matching package roots without touching the filesystem. */
export function resolveAffectedPackages(
  profile: ProjectProfile,
  changedFiles: readonly string[],
  options: AffectedPackageOptions,
): AffectedPackagesResult {
  const canonicalByKey = new Map<string, CanonicalPath>();
  const rejected: RejectedChangedFile[] = [];
  for (const input of changedFiles) {
    const result = canonicalize(profile, input, path.resolve(options.changedFilesBase));
    if ('reason' in result) rejected.push(result);
    else if (!canonicalByKey.has(result.key)) canonicalByKey.set(result.key, result);
  }

  const canonical = [...canonicalByKey.values()];
  const packageByDepth = [...profile.packages].sort(
    (left, right) => comparisonKey(right.root).length - comparisonKey(left.root).length,
  );
  const selections = new Map<string, AffectedPackage>();
  const unmatchedFiles: string[] = [];
  let affectsAll = false;

  for (const file of canonical) {
    const configReason = rootConfigReason(profile, file);
    if (configReason) {
      affectsAll = true;
      for (const packageProfile of profile.packages) {
        addReason(selections, packageProfile, {
          kind: configReason,
          changedPath: file.display,
          classification: 'other',
        });
      }
      continue;
    }

    const owner = packageByDepth.find((packageProfile) => isInside(packageProfile.root, file.absolute));
    if (!owner) {
      unmatchedFiles.push(file.display);
      continue;
    }
    addReason(selections, owner, {
      kind: 'direct_change',
      changedPath: file.display,
      classification: classify(file.absolute, owner),
    });
  }

  if (!affectsAll && options.expandDependents && selections.size > 0) {
    const direct = profile.packages.filter((item) => selections.has(comparisonKey(item.root)));
    const sourcePackage = direct.map((item) => item.name).join(', ');
    for (const expanded of options.expandDependents(direct, profile)) {
      const packageProfile = profile.packages.find((item) => comparisonKey(item.root) === comparisonKey(expanded.root));
      if (!packageProfile || selections.has(comparisonKey(packageProfile.root))) continue;
      addReason(selections, packageProfile, {
        kind: 'dependent_change',
        changedPath: canonical[0]?.display ?? '.',
        classification: 'other',
        sourcePackage,
      });
    }
  }

  return {
    packages: profile.packages
      .map((item) => selections.get(comparisonKey(item.root)))
      .filter((item): item is AffectedPackage => item !== undefined),
    canonicalChangedFiles: canonical.map((item) => item.display),
    rejected,
    unmatchedFiles,
    affectsAll,
  };
}
