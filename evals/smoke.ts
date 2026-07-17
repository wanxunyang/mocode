import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverValidationCommand } from '../src/verification/discovery.js';
import {
  clearProjectProfileCache,
  discoverProjectProfile,
  type ProjectPackageManager,
} from '../src/verification/profile.js';
import { runCommandRaw } from '../src/tools/builtins/run-command.js';

interface SmokeCase {
  name: string;
  run: () => void | Promise<void>;
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(manifest?: object, lockfile?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mocode-eval-'));
  if (manifest) writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest), 'utf8');
  if (lockfile) writeFileSync(path.join(root, lockfile), '', 'utf8');
  return root;
}

function writePackage(root: string, relativeRoot: string, manifest: object): string {
  const packageRoot = path.join(root, relativeRoot);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest), 'utf8');
  return packageRoot;
}

function removeFixture(root: string): void {
  clearProjectProfileCache(root);
  rmSync(root, { recursive: true, force: true });
}

function assertWorkspaceProfile(
  manager: ProjectPackageManager,
  rootManifest: object,
  workspaceYaml?: string,
): void {
  const root = fixture(rootManifest, manager === 'pnpm' ? 'pnpm-lock.yaml' : undefined);
  try {
    if (workspaceYaml) writeFileSync(path.join(root, 'pnpm-workspace.yaml'), workspaceYaml, 'utf8');
    writePackage(root, 'packages/app', { name: `${manager}-app`, scripts: { test: 'x' } });
    const profile = discoverProjectProfile(root);
    assert.equal(profile.packageManager, manager);
    assert.deepEqual(profile.packages.map((item) => item.name), ['root', `${manager}-app`]);
  } finally {
    removeFixture(root);
  }
}

const cases: SmokeCase[] = [
  {
    name: 'prefers typecheck over test and build',
    run() {
      const root = fixture({ scripts: { build: 'x', test: 'x', typecheck: 'x' } }, 'package-lock.json');
      try {
        assert.equal(discoverValidationCommand(root).command?.command, 'npm run typecheck');
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'honors a safe declared package manager through ProjectProfile',
    run() {
      const root = fixture({ packageManager: 'pnpm@9.0.0', scripts: { test: 'x' } });
      try {
        assert.equal(discoverValidationCommand(root).command?.command, 'pnpm run test');
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'profiles one package and its config and marked directories',
    run() {
      const root = fixture({ name: 'single', scripts: { lint: 'eslint .' } });
      try {
        for (const directory of ['src', 'tests', 'generated', 'vendor', 'fixtures']) {
          mkdirSync(path.join(root, directory), { recursive: true });
        }
        for (const config of ['tsconfig.json', 'vitest.config.ts', 'eslint.config.js']) {
          writeFileSync(path.join(root, config), '', 'utf8');
        }
        const profile = discoverProjectProfile(root);
        assert.equal(profile.packages.length, 1);
        const single = profile.packages[0];
        assert.equal(single?.name, 'single');
        assert.deepEqual(single?.scripts, { lint: 'eslint .' });
        assert.equal(single?.sourceRoots.length, 1);
        assert.equal(single?.testRoots.length, 1);
        assert.equal(single?.tsconfigPaths.length, 1);
        assert.equal(single?.testConfigPaths.length, 1);
        assert.equal(single?.lintConfigPaths.length, 1);
        assert.equal(single?.generatedRoots.length, 1);
        assert.equal(single?.vendorRoots.length, 1);
        assert.equal(single?.fixtureRoots.length, 1);
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'discovers npm array workspaces',
    run() {
      assertWorkspaceProfile('npm', {
        name: 'root', packageManager: 'npm@10.0.0', workspaces: ['packages/*'],
      });
    },
  },
  {
    name: 'discovers yarn object workspaces',
    run() {
      assertWorkspaceProfile('yarn', {
        name: 'root', packageManager: 'yarn@4.0.0', workspaces: { packages: ['packages/*'] },
      });
    },
  },
  {
    name: 'discovers pnpm-workspace packages',
    run() {
      assertWorkspaceProfile(
        'pnpm',
        { name: 'root', packageManager: 'pnpm@9.0.0' },
        "packages:\n  - 'packages/*'\n",
      );
    },
  },
  {
    name: 'discovers the mocode root and packages layout',
    run() {
      clearProjectProfileCache(REPOSITORY_ROOT);
      const profile = discoverProjectProfile(REPOSITORY_ROOT);
      assert.equal(profile.packages[0]?.name, 'mocode-ai');
      assert.ok(profile.packages.some((item) => item.name === 'mocode-pet-app'));
    },
  },
  {
    name: 'invalidates a cached profile when config files change',
    run() {
      const root = fixture({ name: 'cached' });
      try {
        const first = discoverProjectProfile(root);
        assert.strictEqual(discoverProjectProfile(root), first);
        writeFileSync(path.join(root, 'tsconfig.json'), '{}', 'utf8');
        const refreshed = discoverProjectProfile(root);
        assert.notStrictEqual(refreshed, first);
        assert.equal(refreshed.packages[0]?.tsconfigPaths.length, 1);
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'parses package.json as data without executing scripts',
    run() {
      const root = fixture({
        name: 'safe-json',
        scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'executed\',\'yes\')"' },
      });
      try {
        const profile = discoverProjectProfile(root);
        assert.equal(profile.packages[0]?.scripts.postinstall?.startsWith('node'), true);
        assert.equal(existsSync(path.join(root, 'executed')), false);
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'rejects malformed package manifests safely',
    run() {
      const root = fixture();
      try {
        writeFileSync(path.join(root, 'package.json'), 'export default { scripts: {} }', 'utf8');
        assert.throws(() => discoverProjectProfile(root), SyntaxError);
        assert.equal(discoverValidationCommand(root).reason, 'no_validation_script');
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'skips projects without package.json',
    run() {
      const root = fixture();
      try {
        assert.equal(discoverValidationCommand(root).reason, 'no_package_json');
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'skips projects without a supported validation script',
    run() {
      const root = fixture({ scripts: { lint: 'x' } });
      try {
        assert.equal(discoverValidationCommand(root).reason, 'no_validation_script');
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'reports command pass, failure, and abort structurally',
    async run() {
      const passed = await runCommandRaw('node -e "process.exit(0)"', 5000);
      const failed = await runCommandRaw('node -e "process.exit(2)"', 5000);
      const controller = new AbortController();
      const pending = runCommandRaw('node -e "setTimeout(() => {}, 5000)"', 5000, controller.signal);
      setTimeout(() => controller.abort(), 50);
      const aborted = await pending;
      assert.equal(passed.status, 'passed');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.exitCode, 2);
      assert.equal(aborted.status, 'aborted');
    },
  },
];

let failures = 0;
for (const item of cases) {
  try {
    await item.run();
    console.log(`PASS ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${item.name}`);
    console.error(error);
  }
}

if (failures > 0) process.exitCode = 1;
else console.log(`PASS ${cases.length} automatic-validation smoke cases`);
