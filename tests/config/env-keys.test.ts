/**
 * 配置键清单的防腐化测试。
 *
 * 背景：work-app（Electron GUI）没有 shell 环境，用户级配置只能靠
 * 「~/.mocode/config → process.env」回填，回填过滤器用的就是 packages/protocol 的
 * USER_CONFIG_ENV_KEYS。这份清单曾经只有 30 个键，而 core 实际读取 106 个——
 * 差集里所有开关写进配置文件都静默无效（记忆子开关、计算机控制门、请求体预算、代理…）。
 *
 * 所以这里做的是**派生校验**而不是逐条断言：直接扫 src/ 下所有 process.env 读取点，
 * 出现清单外的新键就失败。加新 env 配置时忘了归类，CI 会挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_KNOWN_ENV_KEYS, INTERNAL_ENV_KEYS, USER_CONFIG_ENV_KEYS } from '@mocode/protocol';

/**
 * 仓库根：向上找带 `"name": "mocode-ai"` 的 package.json。
 * 不能写死 `'..','..'` —— 源码在 tests/config/ 下是两层，编译后落在 dist-tests/tests/config/
 * 是三层，写死会让扫描目录落到 dist-tests 里、一个键都读不到（测试自己变成空转）。
 */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"name": "mocode-ai"')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（package.json 里 name=mocode-ai）');
}

const repoRoot = findRepoRoot();

/** 递归收集 src/ 下所有 .ts 文件路径。 */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTs(full, out);
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** src/ 里实际被读取的 env 键（`process.env.X` 与 `process.env['X']` 两种写法）。 */
function readEnvKeys(): Set<string> {
  const keys = new Set<string>();
  const srcDir = path.join(repoRoot, 'src');
  for (const file of collectTs(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) keys.add(match[1]!);
    for (const match of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) keys.add(match[1]!);
  }
  return keys;
}

test('src/ 读取的每个 env 键都已归类（用户级或内部）', () => {
  const used = readEnvKeys();
  assert.ok(used.size > 50, `扫描到的键太少（${used.size}），测试本身可能失效`);
  const known = new Set(ALL_KNOWN_ENV_KEYS);
  const unclassified = [...used].filter((key) => !known.has(key)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `以下 env 键未归类到 packages/protocol/src/env-keys.ts：\n${unclassified.join('\n')}\n` +
      '新增用户级配置请加进 USER_CONFIG_ENV_KEYS（否则 work-app 从配置文件读不到它）；' +
      '过程/宿主内部键请加进 INTERNAL_ENV_KEYS。',
  );
});

test('用户级与内部键两个清单互斥', () => {
  const overlap = USER_CONFIG_ENV_KEYS.filter((key) => INTERNAL_ENV_KEYS.includes(key));
  assert.deepEqual(overlap, [], `键不能同时是用户级与内部键：${overlap.join(', ')}`);
});

test('清单里没有重复项（重复会让 isUserConfigEnvKey 的语义变得含混）', () => {
  const dupes = ALL_KNOWN_ENV_KEYS.filter((key, index) => ALL_KNOWN_ENV_KEYS.indexOf(key) !== index);
  assert.deepEqual(dupes, [], `清单存在重复键：${dupes.join(', ')}`);
});

test('清单不含 path 空壳（防止误把空串键塞进来）', () => {
  for (const key of ALL_KNOWN_ENV_KEYS) {
    assert.ok(/^[A-Z][A-Z0-9_]+$/.test(key), `非法键名：${JSON.stringify(key)}`);
  }
});

test('用户级清单里的键名确实出现在 src/ 读取点（清单不能凭空空转）', () => {
  const used = readEnvKeys();
  const stale = USER_CONFIG_ENV_KEYS.filter((key) => !used.has(key)).sort();
  assert.deepEqual(stale, [], `清单里有 core 从不读取的键（应删除）：${stale.join(', ')}`);
});

test('协议包能被 work-app 的构建环境解析（清单消费方的前提）', () => {
  // 这条是「清单必须放在 packages/protocol」这个决定的守门测试：
  // work-app 的 tsconfig rootDir 是它自己的 src，无法 import core 的 src/config。
  assert.ok(existsSync(path.join(repoRoot, 'packages/protocol/src/env-keys.ts')));
});
