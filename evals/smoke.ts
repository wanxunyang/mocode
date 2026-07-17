import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverValidationCommand } from '../src/verification/discovery.js';
import { runCommandRaw } from '../src/tools/builtins/run-command.js';

interface SmokeCase {
  name: string;
  run: () => void | Promise<void>;
}

function fixture(manifest?: object, lockfile?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mocode-eval-'));
  if (manifest) writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest), 'utf8');
  if (lockfile) writeFileSync(path.join(root, lockfile), '', 'utf8');
  return root;
}

const cases: SmokeCase[] = [
  {
    name: 'prefers typecheck over test and build',
    run() {
      const root = fixture({ scripts: { build: 'x', test: 'x', typecheck: 'x' } }, 'package-lock.json');
      try {
        assert.equal(discoverValidationCommand(root).command?.command, 'npm run typecheck');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'honors a safe declared package manager',
    run() {
      const root = fixture({ packageManager: 'pnpm@9.0.0', scripts: { test: 'x' } });
      try {
        assert.equal(discoverValidationCommand(root).command?.command, 'pnpm run test');
      } finally {
        rmSync(root, { recursive: true, force: true });
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
        rmSync(root, { recursive: true, force: true });
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
        rmSync(root, { recursive: true, force: true });
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
