/**
 * 图谱 pull 召回强化护栏(临时 HOME + chdir 隔离双 scope 图谱):
 *  - searchGraphFacts:中文 fact 词面命中、一跳邻接补全(viaNeighbor)、scope 过滤、空 query
 *  - buildProjectGraphHint:无边/关开关 → 空串;有边含主题实体与检索指引、≤预算
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTriple, searchGraphFacts } from '../src/memory/graph.js';
import { buildProjectGraphHint, GRAPH_HINT_MAX_CHARS } from '../src/memory/recall.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-recall-'));
    // global 图取 $HOME/.mocode,project 图取 $cwd/.mocode——必须用两个不同目录,
    // 否则两 scope 路径撞成同一文件(loadAllGraph 会按文件重复打 scope 标签)。
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    try {
      await fn();
    } finally {
      process.env.HOME = home ?? '';
      process.env.USERPROFILE = up ?? '';
      if (home === undefined) delete process.env.HOME;
      if (up === undefined) delete process.env.USERPROFILE;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'searchGraphFacts: 命中中文 fact + 一跳邻接补全 + scope 过滤',
  isolated(() => {
    addTriple({
      src: 'auth-service',
      relation: 'depends_on',
      dst: 'jwt-lib',
      fact: '认证服务依赖 jwt 库签发令牌',
      scope: 'project',
    });
    addTriple({ src: 'jwt-lib', relation: 'runs_on', dst: 'node-runtime', fact: '', scope: 'project' });
    addTriple({
      src: 'someone',
      relation: 'located_in',
      dst: 'beijing',
      fact: '全局事实不应在 project 过滤中出现',
      scope: 'global',
    });

    // 直接边:query 命中 auth-service 名与 fact 里的"认证"(刻意不含 jwt,
    // 好让 jwt-lib runs_on node-runtime 成为纯邻接边)。
    const all = searchGraphFacts('auth 认证', { scope: 'all' });
    assert.ok(all.length >= 1);
    const direct = all.find((h) => !h.viaNeighbor);
    assert.ok(direct, '应有直接命中边');
    assert.equal(direct!.edge.relation, 'depends_on');

    // 邻接:jwt-lib runs_on node-runtime 不含 query 词,但 jwt-lib 是直接命中端点,补出一跳
    const neighbor = all.find((h) => h.viaNeighbor && h.edge.relation === 'runs_on');
    assert.ok(neighbor, '应补出一跳邻接边');

    // scope 过滤:只要 project,global 边不出现
    const proj = searchGraphFacts('全局事实 北京', { scope: 'project' });
    assert.equal(proj.length, 0, 'global 边不应被 project scope 检到');
    const glob = searchGraphFacts('全局事实 北京', { scope: 'global' });
    assert.ok(glob.some((h) => h.edge.scope === 'global'));
  }),
);

test(
  'searchGraphFacts: 空 query / 无命中 → 空数组',
  isolated(() => {
    addTriple({ src: 'a', relation: 'rel', dst: 'b', scope: 'project' });
    assert.deepEqual(searchGraphFacts(''), []);
    assert.deepEqual(searchGraphFacts('完全无关的词 xyz'), []);
  }),
);

test(
  'buildProjectGraphHint: 无边/关闭 → 空串;有边 → 含主题实体与检索指引且不超预算',
  isolated(() => {
    assert.equal(buildProjectGraphHint(true), '');
    addTriple({ src: 'auth-service', relation: 'depends_on', dst: 'jwt-lib', fact: '认证依赖 jwt', scope: 'project' });
    addTriple({ src: 'auth-service', relation: 'runs_on', dst: 'node-runtime', scope: 'project' });
    assert.equal(buildProjectGraphHint(false), '');
    const hint = buildProjectGraphHint(true);
    assert.match(hint, /Project knowledge graph/);
    assert.match(hint, /memory_search/);
    assert.match(hint, /auth-service/, '高度数主题实体应列出');
    assert.ok(hint.length <= GRAPH_HINT_MAX_CHARS, `hint 超预算 ${hint.length}/${GRAPH_HINT_MAX_CHARS}`);
  }),
);
