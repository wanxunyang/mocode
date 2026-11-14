import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCheckGroups,
  checkCommand,
  isCheckScript,
  orderScripts,
  packageManagerFor,
  parsePackage,
  scriptPriority,
  workspaceDirs,
} from '../../packages/work-app/src/checks.js';

/**
 * 「检查」面板只有一个事实源：磁盘上的 package.json。这些用例钉的是
 * 「列出来的命令必须真的存在」与「不该列的不能混进来」两条底线 ——
 * 前者错了用户点下去就是 Missing script，后者错了面板就成了脚本大全。
 */

test('isCheckScript：校验类脚本进面板，dev/start/prepare 这类噪声不进', () => {
  for (const name of [
    'typecheck',
    'type-check',
    'tsc',
    'lint',
    'lint:fix',
    'build',
    'build:electron',
    'test',
    'test:unit',
    'check',
    'verify:all',
    'format:check',
  ]) {
    assert.equal(isCheckScript(name), true, `${name} 应当算检查`);
  }
  for (const name of ['dev', 'start', 'serve', 'prepare', 'postinstall', 'clean', 'release']) {
    assert.equal(isCheckScript(name), false, `${name} 不该进检查面板`);
  }
});

test('orderScripts：按 typecheck → lint → build → test 排，未知项靠字母序垫后', () => {
  const ordered = orderScripts([
    { name: 'test', command: 'node --test' },
    { name: 'deploy', command: 'echo x' },
    { name: 'build', command: 'tsc' },
    { name: 'lint', command: 'eslint' },
    { name: 'typecheck', command: 'tsc --noEmit' },
  ]);
  assert.deepEqual(
    ordered.map((item) => item.name),
    ['typecheck', 'lint', 'build', 'test', 'deploy'],
  );
  assert.ok(scriptPriority('deploy') > scriptPriority('test'));
});

test('checkCommand：根目录不带 cd，子包带 cd 前缀', () => {
  assert.equal(checkCommand('npm', 'typecheck'), 'npm run typecheck');
  assert.equal(checkCommand('pnpm', 'build', 'packages/protocol'), 'cd packages/protocol && pnpm run build');
});

test('packageManagerFor：packageManager 字段优先于锁文件', () => {
  // 字段说 pnpm，即使同时存在 package-lock.json 也以字段为准。
  assert.equal(packageManagerFor({ packageManager: 'pnpm@9.1.0', lockfiles: ['package-lock.json'] }), 'pnpm');
  assert.equal(packageManagerFor({ packageManager: 'yarn@4.0.0', lockfiles: [] }), 'yarn');
  // 带 scoped 包名形态的字段（`@scope@1.0.0`）只取第一段。
  assert.equal(packageManagerFor({ packageManager: 'bun@1.1.0', lockfiles: [] }), 'bun');
  // 字段缺省才看锁文件。
  assert.equal(packageManagerFor({ lockfiles: ['pnpm-lock.yaml'] }), 'pnpm');
  assert.equal(packageManagerFor({ lockfiles: ['yarn.lock'] }), 'yarn');
  assert.equal(packageManagerFor({ lockfiles: [] }), 'npm');
});

test('packageManagerFor：bun 与 yarn 都有 yarn.lock 时按 bun 专属锁文件判定', () => {
  assert.equal(packageManagerFor({ lockfiles: ['yarn.lock', 'bun.lockb'] }), 'bun');
  assert.equal(packageManagerFor({ lockfiles: ['yarn.lock', 'bun.lock'] }), 'bun');
  assert.equal(packageManagerFor({ lockfiles: ['yarn.lock'] }), 'yarn');
});

test('parsePackage：坏 JSON / 非对象返回 null', () => {
  assert.equal(parsePackage(null), null);
  assert.equal(parsePackage(''), null);
  assert.equal(parsePackage('{'), null);
  assert.equal(parsePackage('[]'), null);
  assert.equal(parsePackage('"x"'), null);
});

test('parsePackage：空命令与非脚本字段不进列表', () => {
  const pkg = parsePackage(
    JSON.stringify({
      name: 'demo',
      scripts: { dev: 'vite', typecheck: 'tsc --noEmit', blank: '', 'lint:fix': 'eslint --fix' },
    }),
  );
  assert.ok(pkg);
  assert.deepEqual(
    pkg.scripts.map((item) => item.name),
    ['typecheck', 'lint:fix'],
  );
  assert.equal(pkg.name, 'demo');
});

test('parsePackage：读得出 workspaces 与 packageManager', () => {
  const pkg = parsePackage(
    JSON.stringify({
      name: 'root',
      packageManager: 'pnpm@9.0.0',
      workspaces: ['packages/*', 42, ''],
      scripts: { build: 'tsc' },
    }),
  );
  assert.ok(pkg);
  assert.deepEqual(pkg.workspaces, ['packages/*']);
  assert.equal(pkg.packageManager, 'pnpm@9.0.0');
});

test('workspaceDirs：字面目录与单层通配分开，两层通配静默丢弃', () => {
  assert.deepEqual(workspaceDirs(['apps/web', 'packages/*', 'packages/**/*', 'lib/*/src', ' tools/ ']), {
    literal: ['apps/web', 'tools'],
    globs: ['packages'],
  });
});

test('buildCheckGroups：根组用 name，子包用目录名，子包继承根的包管理器', () => {
  const { packageManager, groups } = buildCheckGroups([
    {
      dir: '',
      text: JSON.stringify({ name: 'mocode', packageManager: 'pnpm@9.0.0', scripts: { build: 'tsc', dev: 'tsx' } }),
    },
    {
      dir: 'packages/protocol',
      text: JSON.stringify({ name: '@mocode/protocol', scripts: { typecheck: 'tsc --noEmit' } }),
    },
    { dir: 'packages/runtime', text: null },
    { dir: 'packages/empty', text: JSON.stringify({ name: 'empty', scripts: { dev: 'vite' } }) },
  ]);
  assert.equal(packageManager, 'pnpm');
  // runtime 没有 package.json、empty 只有 dev —— 两组都不该出现。
  assert.deepEqual(
    groups.map((group) => group.dir),
    ['', 'packages/protocol'],
  );
  assert.equal(groups[0]!.label, 'mocode');
  assert.equal(groups[1]!.label, 'packages/protocol');
  assert.equal(groups[1]!.packageManager, 'pnpm');
});

test('buildCheckGroups：根 package.json 缺 packageManager 时按锁文件判定', () => {
  const { packageManager, groups } = buildCheckGroups([
    { dir: '', text: JSON.stringify({ scripts: { typecheck: 'tsc' } }), lockfiles: ['pnpm-lock.yaml'] },
  ]);
  assert.equal(packageManager, 'pnpm');
  // 根没有 name：label 留空由渲染层兜底文案，不能凭空造一个名字。
  assert.equal(groups[0]!.label, '');
  assert.equal(groups.length, 1);
});

test('buildCheckGroups：一个 package.json 都没有时返回空分组', () => {
  const { groups } = buildCheckGroups([{ dir: '', text: null }]);
  assert.deepEqual(groups, []);
});
