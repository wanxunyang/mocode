import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverValidationCommand } from '../src/verification/discovery.js';
import {
  clearProjectProfileCache,
  discoverProjectProfile,
  type ProjectPackageManager,
} from '../src/verification/profile.js';
import { resolveAffectedPackages } from '../src/verification/affected.js';
import { runCommandRaw, runCommandTool } from '../src/tools/builtins/run-command.js';
import { askHumanTool } from '../src/tools/builtins/ask-human.js';
import { validateToolArguments } from '../src/tools/validation.js';
import { getSandboxRoot, setSandboxRoot } from '../src/sandbox/index.js';
import { inOverlay, mergeSubAgentChangeSet } from '../src/agents/coordinator.js';
import {
  checkPermission,
  clearSessionPermissionGrants,
  permissionFingerprint,
  resetPermissionGrantsForTests,
} from '../src/permissions/index.js';
import { t } from '../src/i18n/index.js';
import { buildMocodeCorePrompt, buildNotepadSection } from '../src/config/index.js';
import { setCurrentSessionId } from '../src/session/state.js';

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

function affectedWorkspaceFixture(): { root: string; packageA: string; packageB: string } {
  const root = fixture({
    name: 'root',
    workspaces: ['packages/*'],
    scripts: { typecheck: 'root-check' },
  });
  const packageA = writePackage(root, 'packages/a', { name: 'a', scripts: { test: 'a-test' } });
  const packageB = writePackage(root, 'packages/b', { name: 'b', scripts: { build: 'b-build' } });
  mkdirSync(path.join(packageA, 'src'), { recursive: true });
  mkdirSync(path.join(packageA, 'tests', 'fixtures'), { recursive: true });
  mkdirSync(path.join(packageB, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.json'), '{}', 'utf8');
  return { root, packageA, packageB };
}

const cases: SmokeCase[] = [
  {
    name: 'binds session command grants to the exact command fingerprint',
    async run() {
      resetPermissionGrantsForTests();
      let prompts = 0;
      const prompt = async () => {
        prompts += 1;
        return { action: 'selected' as const, value: t('permission.allowSessionResource') };
      };
      assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, undefined, { prompt }), 'allow');
      assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, undefined, { prompt }), 'allow');
      assert.equal(prompts, 1);
      assert.equal(await checkPermission(runCommandTool, { command: 'npm publish' }, undefined, {
        prompt: async () => ({ action: 'selected', value: t('permission.deny') }),
      }), 'deny');
      assert.notEqual(
        permissionFingerprint(runCommandTool, { command: 'npm test' }),
        permissionFingerprint(runCommandTool, { command: 'npm publish' }),
      );
      clearSessionPermissionGrants();
    },
  },
  {
    name: 'denies cancelled and aborted permission requests',
    async run() {
      resetPermissionGrantsForTests();
      assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, undefined, {
        prompt: async () => ({ action: 'cancelled' }),
      }), 'deny');
      const controller = new AbortController();
      controller.abort();
      assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, controller.signal, {
        prompt: async () => ({ action: 'selected', value: t('permission.allow') }),
      }), 'deny');
    },
  },
  {
    name: 'scopes permanent grants to command/resource and project',
    async run() {
      resetPermissionGrantsForTests();
      const root = fixture({ scripts: { test: 'x' } });
      let prompts = 0;
      const projectPrompt = async () => {
        prompts += 1;
        return { action: 'selected' as const, value: t('permission.allowProjectResource') };
      };
      try {
        const options = { projectRoot: root, prompt: projectPrompt, persistProjectGrant: false };
        assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, undefined, options), 'allow');
        assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, undefined, options), 'allow');
        assert.equal(prompts, 1);
        assert.equal(await checkPermission(runCommandTool, { command: 'npm run build' }, undefined, {
          ...options,
          prompt: async () => ({ action: 'selected', value: t('permission.deny') }),
        }), 'deny');
        const otherRoot = fixture({ scripts: { test: 'x' } });
        try {
          assert.equal(await checkPermission(runCommandTool, { command: 'npm test' }, undefined, {
            ...options,
            projectRoot: otherRoot,
            prompt: async () => ({ action: 'selected', value: t('permission.deny') }),
          }), 'deny');
        } finally {
          removeFixture(otherRoot);
        }
      } finally {
        removeFixture(root);
        resetPermissionGrantsForTests();
      }
    },
  },
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
    name: 'maps normalized Windows-style paths to the longest package root',
    run() {
      const { root } = affectedWorkspaceFixture();
      try {
        const profile = discoverProjectProfile(root);
        const changed = process.platform === 'win32'
          ? 'PACKAGES\\A\\src\\..\\src\\x.ts'
          : 'packages/a/src/../src/x.ts';
        const result = resolveAffectedPackages(
          profile,
          [changed, 'packages/a/src/x.ts'],
          { changedFilesBase: root },
        );
        assert.deepEqual(result.packages.map((item) => item.package.name), ['a']);
        assert.equal(result.canonicalChangedFiles.length, 1);
        assert.equal(result.packages[0]?.reasons[0]?.classification, 'source');
        assert.equal(result.rejected.length, 0);
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'expands root config changes to every package with reasons',
    run() {
      const { root } = affectedWorkspaceFixture();
      try {
        const profile = discoverProjectProfile(root);
        const result = resolveAffectedPackages(
          profile,
          ['tsconfig.json', 'package.json'],
          { changedFilesBase: root },
        );
        assert.equal(result.affectsAll, true);
        assert.deepEqual(result.packages.map((item) => item.package.name), ['root', 'a', 'b']);
        assert.ok(result.packages.every((item) =>
          item.reasons.some((reason) => reason.kind === 'root_config_change')
          && item.reasons.some((reason) => reason.kind === 'workspace_config_change')));
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'rejects project escapes and exposes a dependent expansion hook',
    run() {
      const { root } = affectedWorkspaceFixture();
      try {
        const profile = discoverProjectProfile(root);
        const escaped = resolveAffectedPackages(
          profile,
          ['../outside.ts'],
          { changedFilesBase: root },
        );
        assert.equal(escaped.rejected[0]?.reason, 'outside_project');
        assert.equal(escaped.packages.length, 0);

        const expanded = resolveAffectedPackages(
          profile,
          ['packages/a/tests/fixtures/case.ts'],
          {
            changedFilesBase: root,
            expandDependents: (_direct, project) =>
              project.packages.filter((item) => item.name === 'b'),
          },
        );
        assert.deepEqual(expanded.packages.map((item) => item.package.name), ['a', 'b']);
        assert.equal(expanded.packages[0]?.reasons[0]?.classification, 'fixture');
        assert.equal(expanded.packages[1]?.reasons[0]?.kind, 'dependent_change');
      } finally {
        removeFixture(root);
      }
    },
  },
  {
    name: 'runs internal validation commands in the selected package cwd',
    async run() {
      const { root, packageA } = affectedWorkspaceFixture();
      const previousRoot = setSandboxRoot(root);
      try {
        const result = await runCommandRaw(
          'node -e "console.log(process.cwd())"',
          5000,
          undefined,
          packageA,
        );
        assert.equal(result.status, 'passed');
        const actual = path.resolve(result.output.trim());
        assert.equal(
          process.platform === 'win32' ? actual.toLowerCase() : actual,
          process.platform === 'win32' ? packageA.toLowerCase() : packageA,
        );
      } finally {
        setSandboxRoot(previousRoot);
        removeFixture(root);
      }
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
    name: 'normalizes malformed ask_human options before schema validation',
    run() {
      const malformed: Record<string, unknown> = {
        question: '实现计划的落盘方式',
        options: [{}],
      };
      assert.equal(validateToolArguments(askHumanTool, malformed).valid, true);
      assert.deepEqual(
        malformed,
        { question: '实现计划的落盘方式', options: [] },
        'empty options should become the explicit free-text protocol instead of failing validation',
      );

      const explicitFreeText: Record<string, unknown> = {
        question: '请粘贴错误日志',
        options: [],
      };
      assert.equal(validateToolArguments(askHumanTool, explicitFreeText).valid, true);
      assert.deepEqual(explicitFreeText.options, []);

      const omittedLegacyFreeText: Record<string, unknown> = {
        question: '请粘贴错误日志',
      };
      assert.equal(validateToolArguments(askHumanTool, omittedLegacyFreeText).valid, true);
      assert.deepEqual(omittedLegacyFreeText.options, []);

      const legacyStrings: Record<string, unknown> = {
        question: '选择方式',
        options: ['  现有文档  ', '新建文件'],
      };
      assert.equal(validateToolArguments(askHumanTool, legacyStrings).valid, true);
      assert.deepEqual(legacyStrings.options, [
        { label: '现有文档' },
        { label: '新建文件' },
      ]);
      const askSchema = askHumanTool.parameters as {
        required?: string[];
        properties?: { options?: { minItems?: number } };
      };
      assert.equal(JSON.stringify(askSchema).includes('anyOf'), false);
      assert.equal(askSchema.required?.includes('options'), true);
      assert.equal(askSchema.properties?.options?.minItems, 0);
    },
  },
  {
    name: 'shares mocode core behavior with sub-agents without session payload',
    run() {
      const prompt = buildMocodeCorePrompt();
      assert.match(prompt, /## Tool details/);
      assert.match(prompt, /## Workflow/);
      assert.match(prompt, /## Failure Handling/);
      assert.match(prompt, /## Termination & Reporting/);
      assert.doesNotMatch(prompt, /## Project context \(dynamic reference\)/);
      assert.doesNotMatch(prompt, /## Session Notepad/);
    },
  },
  {
    name: 'merges an isolated sub-agent ChangeSet without writing through the overlay',
    async run() {
      const root = fixture();
      const previous = setSandboxRoot(root);
      try {
        writeFileSync(path.join(root, 'a.txt'), 'before', 'utf8');
        const isolated = await inOverlay(async () => {
          await writeFile(path.join(getSandboxRoot()!, 'a.txt'), 'after', 'utf8');
        });
        assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'before');
        assert.equal(await mergeSubAgentChangeSet(isolated.changeSet), 'committed');
        assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after');
      } finally {
        setSandboxRoot(previous);
        removeFixture(root);
      }
    },
  },
  {
    name: 'rejects a stale sub-agent ChangeSet instead of overwriting external edits',
    async run() {
      const root = fixture();
      const previous = setSandboxRoot(root);
      try {
        writeFileSync(path.join(root, 'a.txt'), 'before', 'utf8');
        const isolated = await inOverlay(async () => {
          await writeFile(path.join(getSandboxRoot()!, 'a.txt'), 'agent', 'utf8');
        });
        writeFileSync(path.join(root, 'a.txt'), 'user', 'utf8');
        assert.equal(await mergeSubAgentChangeSet(isolated.changeSet), 'conflict');
        assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'user');
      } finally {
        setSandboxRoot(previous);
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
  {
    name: 'notepad digest splits active vs Done into two buckets',
    async run() {
      const { withSandboxRoot } = await import('../src/sandbox/index.js');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-notepad-'));
      const sessionId = 'unit-notepad-buckets';
      fs.mkdirSync(path.join(tmpRoot, '.mocode', 'sessions', sessionId), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, '.mocode', 'sessions', sessionId, 'notes.md'),
        [
          '## Auth Module',
          '- JWT TTL: 86400',
          '',
          '## Plan: refactor X',
          '- [ ] 1. step a',
          '- [x] 2. step b',
          '',
          '## Open Questions',
          '- refresh TTL?',
          '',
          '## Done: migrated DB',
          '- done at T1',
          '',
          '## Done: fixed #42',
          '',
        ].join('\n'),
      );

      await withSandboxRoot(tmpRoot, async () => {
        setCurrentSessionId(sessionId, tmpRoot);
        try {
          const out = buildNotepadSection(sessionId);

          // 1) header mentions total section count
          assert.match(out, /## Session Notepad \(5 sections/);
          // 2) both buckets labeled
          assert.match(out, /Active \(3\)/);
          assert.match(out, /Done \(2\)/);
          // 3) Plan progress lives on its own line
          assert.match(out, /Plan progress: 1\/2 steps done/);
          // 4) active contents include Plan + Open Questions + Auth
          assert.match(out, /- Auth Module\b/);
          assert.match(out, /- Plan: refactor X/);
          assert.match(out, /- Open Questions/);
          // 5) archived contents include the Done items
          assert.match(out, /- Done: migrated DB/);
          assert.match(out, /- Done: fixed #42/);
          // 6) Done topics must not appear inside the Active block
          const activeBlock = out.split('Done (')[0];
          assert.doesNotMatch(activeBlock, /migrated DB/);
          assert.doesNotMatch(activeBlock, /fixed #42/);
          // 7) empty file → empty digest
          fs.writeFileSync(path.join(tmpRoot, '.mocode', 'sessions', sessionId, 'notes.md'), '');
          assert.equal(buildNotepadSection(sessionId), '');
        } finally {
          // last test in the suite — leaving the session id set is fine
        }
      });
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
