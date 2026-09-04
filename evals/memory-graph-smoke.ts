// 知识图谱层冒烟测试:tsx evals/memory-graph-smoke.ts
// chdir 到临时目录(隔离 project scope)+ USERPROFILE 指到临时目录(隔离 global scope),
// 不读不污染真实 ~/.mocode。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mocode-graph-smoke-'));
process.chdir(tmp);
// global scope 隔离:home 必须是 tmp 的子目录且 ≠ tmp,否则 global/project 图文件同路径会重复计数
process.env.USERPROFILE = path.join(tmp, 'home'); // Windows 上 os.homedir() 优先取 USERPROFILE

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const { addTriple, upsertEntity, findEntity, searchGraph, neighborsOf, pathBetween, graphStats } = await import(
  '../src/memory/graph.js'
);

// 1. 基本三元组(含 CJK 实体名 → slug 兜底)
const r1 = addTriple({ src: 'mocode', relation: 'depends_on', dst: 'JSONL 存储', fact: '记忆用 JSONL 落盘' });
check('addTriple 基本', r1.ok === true, JSON.stringify(r1));

// 2. 同 fact 幂等
const r2 = addTriple({ src: 'mocode', relation: 'depends_on', dst: 'JSONL 存储', fact: '记忆用 JSONL 落盘' });
check('同 fact 幂等', r2.ok === true && r2.duplicate === true, JSON.stringify(r2));

// 3. 冲突 fact → 旧边时序失效
const r3 = addTriple({ src: 'mocode', relation: 'depends_on', dst: 'JSONL 存储', fact: '已迁移 SQLite' });
check('冲突边 superseded=1', r3.ok === true && r3.superseded === 1, JSON.stringify(r3));

// 4. search:命中实体 + 只返 active 边(新 fact)
const s1 = searchGraph('mocode');
check(
  'search 命中实体',
  s1.entities.some((e: { name: string }) => e.name === 'mocode'),
);
check('search 只返 active 边', s1.edges.length === 1 && s1.edges[0].fact === '已迁移 SQLite', JSON.stringify(s1.edges));

// 5. 链式图: A→B→C,neighbors depth 1 / 2
addTriple({ src: 'agent-core', relation: 'calls', dst: 'executeTool' });
addTriple({ src: 'executeTool', relation: 'dispatches', dst: 'registry' });
const n1 = neighborsOf('agent-core', 1);
check(
  'neighbors depth1 一跳',
  n1.entities.length === 1 && n1.edges.length === 1,
  JSON.stringify({ e: n1.entities.length, ed: n1.edges.length }),
);
const n2 = neighborsOf('agent-core', 2);
check(
  'neighbors depth2 两跳',
  n2.entities.length === 2 && n2.edges.length === 2,
  JSON.stringify({ e: n2.entities.length, ed: n2.edges.length }),
);

// 6. 别名匹配 + upsert 合并
upsertEntity('mocode', { alias: 'MoCode' });
const fe = findEntity('MoCode');
check('别名匹配', fe?.id === 'mocode', JSON.stringify(fe));

// 7. 未知实体
const n3 = neighborsOf('不存在的实体');
check('未知实体返空', n3.center === null);

// 8. stats + 文件落盘
const st = graphStats();
check('stats 计数', st.entities === 5 && st.edgesActive === 3 && st.edgesInvalid === 1, JSON.stringify(st));
const raw = JSON.parse(readFileSync(path.join(tmp, '.mocode', 'memory-graph.json'), 'utf8'));
check('文件落盘结构', Array.isArray(raw.entities) && Array.isArray(raw.edges) && raw.edges.length === 4);

// 8b. 独立三跳链:chain-a→chain-b→chain-c→chain-d(不连旧图,避免捷径)
addTriple({ src: 'chain-a', relation: 'calls', dst: 'chain-b' });
addTriple({ src: 'chain-b', relation: 'calls', dst: 'chain-c' });
addTriple({ src: 'chain-c', relation: 'uses', dst: 'chain-d' });
const n3d = neighborsOf('chain-a', 3);
check(
  'neighbors depth3 三跳',
  n3d.entities.some((e: { name: string }) => e.name === 'chain-d'),
  JSON.stringify(n3d.entities.map((e: { name: string }) => e.name)),
);
const n2d = neighborsOf('chain-a', 2);
check(
  'neighbors depth2 到不了三跳',
  !n2d.entities.some((e: { name: string }) => e.name === 'chain-d') &&
    n2d.entities.some((e: { name: string }) => e.name === 'chain-c'),
  JSON.stringify(n2d.entities.map((e: { name: string }) => e.name)),
);

// 8c. relation 过滤:只沿 calls 走,uses 边不带出
const nRel = neighborsOf('chain-a', 3, 'calls');
check(
  'neighbors relation 过滤',
  nRel.entities.some((e: { name: string }) => e.name === 'chain-b') &&
    nRel.entities.some((e: { name: string }) => e.name === 'chain-c') &&
    !nRel.entities.some((e: { name: string }) => e.name === 'chain-d') &&
    nRel.edges.every((e: { relation: string }) => e.relation === 'calls'),
  JSON.stringify({
    e: nRel.entities.map((x: { name: string }) => x.name),
    rel: nRel.edges.map((x: { relation: string }) => x.relation),
  }),
);

// 8d. pathBetween:最短路径 / 同实体 / 不存在端点 / 不走失效边
const p1 = pathBetween('agent-core', 'registry');
check(
  'path 最短路径 2 跳',
  !!p1 && p1.edges.length === 2 && p1.path.map((e) => e.name).join('>') === 'agent-core>executeTool>registry',
  JSON.stringify(p1?.path.map((e) => e.name)),
);
const p2 = pathBetween('agent-core', 'agent-core');
check('path 同实体 0 跳', !!p2 && p2.edges.length === 0 && p2.path.length === 1);
const p3 = pathBetween('agent-core', '不存在的');
check('path 未知端点 null', p3 === null);
// 失效边不参与路径:mocode→JSONL存储 旧 fact 已失效,新边仍 active → 路径存在;
// 但 mocode 与 agent-core 两个连通分量之间无路径
const p4 = pathBetween('mocode', 'agent-core');
check('path 不连通 null', p4 === null);

// 9. 合并后的 memory_search:条目为空时仍返回图谱事实段
const { memorySearchTool } = await import('../src/tools/builtins/memory-search.js');
const out = String(await memorySearchTool.execute({ query: 'mocode' }, {} as never));
check('memory_search 含图谱事实段', out.includes('知识图谱事实') && out.includes('已迁移 SQLite'), out.slice(0, 200));
check('memory_search 无条目时不报无匹配', !out.startsWith('(无匹配记忆:'), out.slice(0, 80));

process.chdir(os.tmpdir()); // 先离开,避免 Windows EBUSY
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
