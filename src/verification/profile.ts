import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

export type ProjectPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PackageProfile {
  name: string;
  root: string;
  scripts: Record<string, string>;
  sourceRoots: string[];
  testRoots: string[];
  tsconfigPaths: string[];
  testConfigPaths: string[];
  lintConfigPaths: string[];
  generatedRoots: string[];
  vendorRoots: string[];
  fixtureRoots: string[];
}

export interface ProjectProfile {
  root: string;
  packageManager: ProjectPackageManager;
  workspaceConfigPaths: string[];
  workspacePatterns: string[];
  packages: PackageProfile[];
}

interface PackageManifest {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
  workspaces?: unknown;
}

interface CacheEntry {
  profile: ProjectProfile;
  workspacePatterns: string[];
  signatures: string[];
}

const cache = new Map<string, CacheEntry>();
const ROOT_INPUTS = [
  'package.json', 'pnpm-workspace.yaml', 'pnpm-workspace.yml',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
];

const SOURCE_DIRS = ['src', 'lib', 'app'];
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec', 'src/test', 'src/tests', 'src/__tests__'];
const GENERATED_DIRS = ['generated', 'gen', 'dist', 'build', 'coverage', 'src/generated', 'src/gen'];
const VENDOR_DIRS = ['vendor', 'vendors', 'third_party', 'third-party', 'node_modules'];
const FIXTURE_DIRS = ['fixture', 'fixtures', '__fixtures__', 'test/fixtures', 'tests/fixtures'];
const ALL_MARKED_DIRS = [...SOURCE_DIRS, ...TEST_DIRS, ...GENERATED_DIRS, ...VENDOR_DIRS, ...FIXTURE_DIRS];
const TSCONFIG_GLOBS = ['tsconfig*.json', '{config,configs}/tsconfig*.json'];
const TEST_CONFIG_GLOBS = [
  '{vitest,jest,playwright,cypress}.config.{js,cjs,mjs,ts,cts,mts,json}',
  '.mocharc.{js,cjs,mjs,json,yaml,yml}',
];
const LINT_CONFIG_GLOBS = [
  'eslint.config.{js,cjs,mjs,ts,cts,mts}',
  '.eslintrc',
  '.eslintrc.{js,cjs,json,yaml,yml}',
  'biome.json',
  'biome.jsonc',
];
const GLOB_OPTIONS = {
  absolute: true,
  onlyFiles: true,
  unique: true,
  followSymbolicLinks: false,
  suppressErrors: true,
  ignore: ['**/node_modules/**', '**/.git/**'],
};

function readManifest(file: string): PackageManifest {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid package manifest: ${file}`);
  }
  return parsed as PackageManifest;
}

function packageManagerFromField(value: unknown): ProjectPackageManager | null {
  if (typeof value !== 'string') return null;
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/.exec(value.trim());
  return match ? match[1] as ProjectPackageManager : null;
}

function detectPackageManager(root: string, field: unknown): ProjectPackageManager {
  const declared = packageManagerFromField(field);
  if (declared) return declared;
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function manifestWorkspacePatterns(value: unknown): string[] {
  const patterns = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as { packages?: unknown }).packages
      : [];
  return Array.isArray(patterns)
    ? patterns.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function cleanYamlValue(value: string): string | null {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const unquoted = withoutComment.replace(/^(['"])(.*)\1$/, '$2').trim();
  return unquoted || null;
}

function pnpmWorkspacePatterns(file: string): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const result: string[] = [];
  let packageIndent: number | null = null;
  for (const line of lines) {
    const declaration = /^(\s*)packages\s*:\s*(.*)$/.exec(line);
    if (declaration) {
      packageIndent = declaration[1]?.length ?? 0;
      const inline = declaration[2]?.trim();
      if (inline?.startsWith('[') && inline.endsWith(']')) {
        for (const item of inline.slice(1, -1).split(',')) {
          const value = cleanYamlValue(item);
          if (value) result.push(value);
        }
      }
      continue;
    }
    if (packageIndent === null || /^\s*(?:#.*)?$/.test(line)) continue;
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (indent <= packageIndent) break;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item?.[1]) {
      const value = cleanYamlValue(item[1]);
      if (value) result.push(value);
    }
  }
  return result;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function workspaceManifestGlobs(patterns: string[]): string[] {
  return patterns.map((raw) => {
    const negative = raw.startsWith('!');
    const value = (negative ? raw.slice(1) : raw).replace(/[\\/]+$/, '');
    const manifest = value.endsWith('package.json') ? value : `${value}/package.json`;
    return negative ? `!${manifest}` : manifest;
  });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function discoverManifestPaths(root: string, patterns: string[]): string[] {
  const rootManifest = path.join(root, 'package.json');
  const matches = fg.sync(workspaceManifestGlobs(patterns), { cwd: root, ...GLOB_OPTIONS });
  const paths = [
    ...(existsSync(rootManifest) ? [rootManifest] : []),
    ...matches.map((item) => path.resolve(item)),
  ].filter((item) => isInside(root, item));
  return uniqueSorted(paths.map((item) => path.resolve(item)));
}

function discoverConfigPaths(root: string, patterns: string[]): string[] {
  return uniqueSorted(fg.sync(patterns, { cwd: root, ...GLOB_OPTIONS }).map((item) => path.resolve(item)));
}

function existingDirectories(root: string, relativePaths: string[]): string[] {
  return relativePaths.map((item) => path.resolve(root, item)).filter((item) => {
    try {
      return statSync(item).isDirectory();
    } catch {
      return false;
    }
  });
}

function scriptsFromManifest(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function createPackageProfile(manifestPath: string): PackageProfile {
  const root = path.dirname(manifestPath);
  const manifest = readManifest(manifestPath);
  return {
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : path.basename(root),
    root,
    scripts: scriptsFromManifest(manifest.scripts),
    sourceRoots: existingDirectories(root, SOURCE_DIRS),
    testRoots: existingDirectories(root, TEST_DIRS),
    tsconfigPaths: discoverConfigPaths(root, TSCONFIG_GLOBS),
    testConfigPaths: discoverConfigPaths(root, TEST_CONFIG_GLOBS),
    lintConfigPaths: discoverConfigPaths(root, LINT_CONFIG_GLOBS),
    generatedRoots: existingDirectories(root, GENERATED_DIRS),
    vendorRoots: existingDirectories(root, VENDOR_DIRS),
    fixtureRoots: existingDirectories(root, FIXTURE_DIRS),
  };
}

function inputSignatures(root: string, workspacePatterns: string[]): string[] {
  const manifestPaths = discoverManifestPaths(root, workspacePatterns);
  const packageRoots = uniqueSorted([root, ...manifestPaths.map((item) => path.dirname(item))]);
  const configPaths = packageRoots.flatMap((packageRoot) => [
    ...discoverConfigPaths(packageRoot, TSCONFIG_GLOBS),
    ...discoverConfigPaths(packageRoot, TEST_CONFIG_GLOBS),
    ...discoverConfigPaths(packageRoot, LINT_CONFIG_GLOBS),
  ]);
  const directoryPaths = packageRoots.flatMap((packageRoot) =>
    ALL_MARKED_DIRS.map((item) => path.resolve(packageRoot, item)));
  const candidates = uniqueSorted([
    ...ROOT_INPUTS.map((item) => path.join(root, item)),
    ...manifestPaths,
    ...configPaths,
    ...directoryPaths,
  ]);
  return candidates.flatMap((item) => {
    try {
      const stat = statSync(item);
      return [`${item}\0${stat.isDirectory() ? 'd' : 'f'}\0${stat.size}\0${stat.mtimeMs}`];
    } catch {
      return [];
    }
  });
}

function sameSignatures(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Build a safe, cached description of a package project. Manifests are parsed strictly as JSON;
 * package scripts and configuration files are never imported or executed.
 */
export function discoverProjectProfile(projectRoot: string): ProjectProfile {
  const root = path.resolve(projectRoot);
  const cached = cache.get(root);
  if (cached) {
    const current = inputSignatures(root, cached.workspacePatterns);
    if (sameSignatures(current, cached.signatures)) return cached.profile;
  }

  const rootManifestPath = path.join(root, 'package.json');
  const rootManifest = existsSync(rootManifestPath) ? readManifest(rootManifestPath) : {};
  const pnpmFiles = ['pnpm-workspace.yaml', 'pnpm-workspace.yml']
    .map((item) => path.join(root, item))
    .filter((item) => existsSync(item));
  const explicitPatterns = [
    ...manifestWorkspacePatterns(rootManifest.workspaces),
    ...pnpmFiles.flatMap((item) => pnpmWorkspacePatterns(item)),
  ];
  const workspacePatterns = uniqueSorted(explicitPatterns.length > 0 ? explicitPatterns : ['packages/*']);
  const profile: ProjectProfile = {
    root,
    packageManager: detectPackageManager(root, rootManifest.packageManager),
    workspaceConfigPaths: uniqueSorted([
      ...(manifestWorkspacePatterns(rootManifest.workspaces).length > 0 ? [rootManifestPath] : []),
      ...pnpmFiles,
    ]),
    workspacePatterns,
    packages: discoverManifestPaths(root, workspacePatterns).map(createPackageProfile),
  };
  cache.set(root, { profile, workspacePatterns, signatures: inputSignatures(root, workspacePatterns) });
  return profile;
}

/** Clear one cached project profile, or all profiles when no root is provided. */
export function clearProjectProfileCache(projectRoot?: string): void {
  if (projectRoot === undefined) cache.clear();
  else cache.delete(path.resolve(projectRoot));
}