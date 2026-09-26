/** M2 单测：search 纯函数（过滤/分组/排序）+ catalog 命令路由匹配。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenCatalog, searchModels, groupByProvider } from '../src/models/search.js';
import { modelCatalogCommands } from '../src/repl/commands/model-catalog.js';
import type { CommandContext } from '../src/repl/commands/types.js';
import type { CatalogProvider } from '../src/models/types.js';

function prov(id: string, npm: string, api: string | undefined, models: Record<string, unknown>): CatalogProvider {
  return { id, npm, ...(api ? { api } : {}), models: models as CatalogProvider['models'] };
}

const providers: Record<string, CatalogProvider> = {
  zhipuai: prov('zhipuai', '@ai-sdk/openai-compatible', 'https://open.bigmodel.cn/api/paas/v4', {
    'glm-5v': {
      id: 'glm-5v',
      reasoning: true,
      tool_call: true,
      attachment: false,
      limit: { context: 200000 },
      release_date: '2026-04-01',
    },
    'glm-flash': {
      id: 'glm-flash',
      reasoning: false,
      tool_call: true,
      attachment: false,
      limit: { context: 128000 },
      release_date: '2026-08-01',
    },
  }),
  google: prov('google', '@ai-sdk/google', undefined, {
    'gemini-x': { id: 'gemini-x', reasoning: true, tool_call: true, limit: { context: 1000000 } },
  }),
};

test('flattenCatalog: supported 标记正确（google 不支持直发）', () => {
  const all = flattenCatalog(providers);
  const byId = Object.fromEntries(all.map((e) => [`${e.providerId}/${e.modelId}`, e]));
  assert.equal(byId['zhipuai/glm-5v'].supported, true);
  assert.equal(byId['google/gemini-x'].supported, false);
});

test('searchModels: 默认只返回可直发；关键字匹配 id/厂商', () => {
  const def = searchModels(providers);
  assert.equal(def.length, 2); // 只有 zhipuai 两个
  assert.ok(def.every((e) => e.supported));

  const glm = searchModels(providers, { query: 'glm-5v' });
  assert.equal(glm.length, 1);
  assert.equal(glm[0].modelId, 'glm-5v');

  // 厂商名关键字（zhipu / Zhipu AI）。
  const byProv = searchModels(providers, { query: 'zhipu' });
  assert.equal(byProv.length, 2);
});

test('searchModels: 能力过滤 + 多关键字 AND', () => {
  const reasoning = searchModels(providers, { reasoning: true });
  assert.deepEqual(reasoning.map((e) => e.modelId).sort(), ['glm-5v']); // glm-flash 不思考

  const multi = searchModels(providers, { query: 'glm zhipu' });
  assert.equal(multi.length, 2);
  assert.equal(searchModels(providers, { query: 'glm nope' }).length, 0);
});

test('includeUnsupported 时返回全部', () => {
  const all = searchModels(providers, { includeUnsupported: true });
  assert.equal(all.length, 3);
  // supported 排在前。
  assert.equal(all[0].supported, true);
});

test('groupByProvider: 按厂商分组', () => {
  const g = groupByProvider(searchModels(providers, { includeUnsupported: true }));
  assert.equal(g.size, 2);
  assert.equal(g.get('zhipuai')?.length, 2);
  assert.equal(g.get('google')?.length, 1);
});

// ── 命令路由 ──────────────────────────────────────────
const handler = modelCatalogCommands[0];

test('catalog 命令：不相关行 → unhandled', async () => {
  const out = await handler({ line: '/model list' } as unknown as CommandContext);
  assert.equal(out.kind, 'unhandled');
  const out2 = await handler({ line: '/foo' } as unknown as CommandContext);
  assert.equal(out2.kind, 'unhandled');
});
