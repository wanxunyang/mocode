import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalUsagePath, __setGlobalUsagePath } from '../../src/session/global-usage.js';
import { __setWorkspaceRegistryPath } from '../../src/workspace/registry.js';
import { registerWorkspace, readWorkspaceRegistry } from '../../src/workspace/registry.js';
import { backfillGlobalUsage } from '../../src/session/backfill-usage.js';

// 全局账本/注册表/导入状态都默认写 ~/.mocode;测试用路径覆盖重定向到临时目录,
// 不污染真实 home(也不依赖全量测试进程里 HOME env 的设置时机)。
const tempHome = mkdtempSync(join(tmpdir(), 'mocode-usage-backfill-'));
const ledger = join(tempHome, 'usage-daily.jsonl');
const registry = join(tempHome, 'workspaces.jsonl');
const state = join(tempHome, 'usage-import-state.json');
__setGlobalUsagePath(ledger);
__setWorkspaceRegistryPath(registry);

function sessionUsage(root: string, id: string, rows: Array<Record<string, unknown>>): void {
  const dir = join(root, '.mocode', 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({ id, createdAt: id.slice(0, 10), model: 'model-hist', firstUser: 'x', history: [] }),
    'utf8',
  );
}

test.after(() => {
  __setGlobalUsagePath(undefined);
  __setWorkspaceRegistryPath(undefined);
  rmSync(tempHome, { recursive: true, force: true });
});

test('registry: 登记后可按 root 折叠读出,重复登记不产生重复工作区', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mocode-ws-'));
  try {
    registerWorkspace(ws, new Date('2026-10-01T08:00:00'));
    registerWorkspace(ws, new Date('2026-10-02T08:00:00'));
    const mine = readWorkspaceRegistry().filter((e) => e.root.toLowerCase() === ws.toLowerCase());
    assert.equal(mine.length, 1, '同 root 折叠成一条');
    assert.equal(mine[0]!.firstSeen.slice(0, 10), '2026-10-01', 'firstSeen 保留最早');
    assert.equal(mine[0]!.lastSeen.slice(0, 10), '2026-10-02', 'lastSeen 取最新');
    assert.equal(mine[0]!.name.length > 0, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('backfill: 历史 usage 行回填,trackedInGlobal 行跳过,重跑幂等', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mocode-ws-backfill-'));
  try {
    sessionUsage(ws, '20260920-101010-000-aaaaaaaa', [
      { step: 0, phase: 'main', inputTokens: 1000, outputTokens: 100, cachedTokens: 800, reasoningTokens: 10 },
      // 新代码 live 行:已实时统计,回填必须跳过
      { step: 1, phase: 'main', inputTokens: 2000, outputTokens: 200, cachedTokens: 0, trackedInGlobal: true },
    ]);
    sessionUsage(ws, '20260921-101010-000-bbbbbbbb', [
      { step: 0, phase: 'compact', inputTokens: 500, outputTokens: 50, cachedTokens: 0 },
    ]);
    registerWorkspace(ws);

    const r1 = backfillGlobalUsage({ statePath: state });
    assert.equal(r1.records, 2, '只回填 2 条无标记历史行');
    assert.equal(r1.skippedTracked, 1);
    assert.equal(r1.workspaces, 1);
    assert.equal(r1.sessions, 2);

    const global = readFileSync(getGlobalUsagePath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(global.length, 2);
    assert.ok(global.every((r) => r.source === 'backfill'));
    assert.equal(global[0].day, '2026-09-20', '日期按会话 id 时间前缀归集');
    assert.equal(global[0].model, 'model-hist');
    assert.equal(global[0].workspace.toLowerCase(), ws.toLowerCase());
    assert.equal(global[1].phase, 'compact');

    // 重跑:断点已推进,零新增
    const r2 = backfillGlobalUsage({ statePath: state });
    assert.equal(r2.records, 0);
    const count2 = readFileSync(getGlobalUsagePath(), 'utf8').split('\n').filter(Boolean).length;
    assert.equal(count2, 2, '重复执行不双算');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('backfill: 升级前后都活跃的会话,新增 tracked 行不重复导入,新增历史行仍补入', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mocode-ws-mixed-'));
  const state2 = join(tempHome, 'usage-import-state-2.json');
  try {
    const id = '20260922-101010-000-cccccccc';
    sessionUsage(ws, id, [
      { step: 0, phase: 'main', inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
      { step: 1, phase: 'main', inputTokens: 200, outputTokens: 20, cachedTokens: 0, trackedInGlobal: true },
    ]);
    registerWorkspace(ws);
    assert.equal(backfillGlobalUsage({ statePath: state2 }).records, 1);

    // 之后该会话又产生两行:一行 live(tracked)、一行旧进程风格(无标记)
    const file = join(ws, '.mocode', 'sessions', id, 'usage.jsonl');
    const existing = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      existing +
        JSON.stringify({
          step: 2,
          phase: 'main',
          inputTokens: 300,
          outputTokens: 30,
          cachedTokens: 0,
          trackedInGlobal: true,
        }) +
        '\n' +
        JSON.stringify({ step: 3, phase: 'main', inputTokens: 400, outputTokens: 40, cachedTokens: 0 }) +
        '\n',
      'utf8',
    );
    const r = backfillGlobalUsage({ statePath: state2 });
    assert.equal(r.records, 1, '只补新增的 1 条未标记行');
    assert.equal(r.skippedTracked, 1, '新 tracked 行识别为已统计');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
