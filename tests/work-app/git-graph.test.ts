import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphWalker, buildGraph } from '../../packages/work-app/src/git-graph.js';

/**
 * 泳道算法是历史视图里唯一有真逻辑的部分，所以这里按「图会长什么样」来断言，
 * 而不是按内部 lanes 数组 —— 后者是实现细节，改了会误报。
 */

test('线性历史：单 lane、无斜线、每行都有来自行顶的连线（除首行）', () => {
  const rows = buildGraph([
    { sha: 'c3', parents: ['c2'] },
    { sha: 'c2', parents: ['c1'] },
    { sha: 'c1', parents: [] },
  ]);
  assert.equal(rows.length, 3);
  // 首行是分支尖端：没有任何 lane 在等它，所以没有行顶连线。
  assert.equal(rows[0].fromTop, false);
  assert.equal(rows[0].lane, 0);
  for (const row of rows) {
    assert.equal(row.lane, 0);
    assert.deepEqual([...row.through], []);
    assert.equal(row.lanes, 1);
  }
  assert.equal(rows[1].fromTop, true);
  assert.equal(rows[2].fromTop, true);
  // 第一个父提交都留在本列 → 竖线；最后一个提交没有父提交。
  assert.equal(rows[0].edges.length, 1);
  assert.equal(rows[0].edges[0].from, rows[0].edges[0].to);
  assert.equal(rows[2].edges.length, 0);
  // 同一分支颜色不变。
  assert.equal(rows[0].color, rows[1].color);
  assert.equal(rows[1].color, rows[2].color);
});

test('分叉：第二个尖端占新 lane，汇合后图宽收窄回 1', () => {
  const rows = buildGraph([
    { sha: 'b2', parents: ['base'] },
    { sha: 'a2', parents: ['base'] },
    { sha: 'base', parents: [] },
  ]);
  assert.equal(rows[0].lane, 0);
  // a2 是另一个尖端：不能复用 0 号列（那列在等 base），必须另开一列。
  assert.equal(rows[1].lane, 1);
  assert.notEqual(rows[0].color, rows[1].color);
  // b2 的线在 a2 那一行直通，同时 base 被两条分支同时等待。
  assert.deepEqual(
    rows[1].through.map((lane) => lane.lane),
    [0],
  );
  assert.equal(rows[1].lanes, 2);
  // base 由两列同时等待 → 落在先占的那列（0），另一列在这一行结束。
  assert.equal(rows[2].lane, 0);
  assert.equal(rows[2].fromTop, true);
  // 汇合之后只剩一列：图宽必须收窄，不能留着已经空掉的 lane。
  assert.equal(rows[2].lanes, 1);
});

test('合并提交：两个父提交分到两列，第一父继承本列', () => {
  const rows = buildGraph([
    { sha: 'm', parents: ['p1', 'p2'] },
    { sha: 'p2', parents: ['base'] },
    { sha: 'p1', parents: ['base'] },
    { sha: 'base', parents: [] },
  ]);
  const merge = rows[0];
  assert.equal(merge.edges.length, 2);
  // 第一父留在本列（直落），第二父另开一列 → 画斜线。
  assert.equal(merge.edges[0].to, merge.lane);
  assert.notEqual(merge.edges[1].to, merge.lane);
  // 两条父链最终都要落到 base：base 只有一行，且此后没有存活分支。
  assert.equal(rows[3].sha, 'base');
  assert.equal(new GraphWalker().activeLanes, 0);
});

test('任何非节点 lane 都不会半路消失：每行的直通线在下一行仍然存在或成为节点', () => {
  const commits = [
    { sha: 'z', parents: ['y', 'x'] },
    { sha: 'y', parents: ['w'] },
    { sha: 'x', parents: ['w'] },
    { sha: 'w', parents: [] },
  ];
  const rows = buildGraph(commits);
  for (let i = 0; i < rows.length - 1; i++) {
    const next = rows[i + 1];
    const aliveNext = new Set<number>([next.lane, ...next.through.map((lane) => lane.lane)]);
    for (const lane of rows[i].through)
      assert.ok(aliveNext.has(lane.lane), `lane ${lane.lane} 在第 ${i + 1} 行凭空消失`);
    // 本行连向父提交的每条线，都必须在下一行体现为节点或直通线。
    const nextNodes = new Set<number>([...next.through.map((lane) => lane.lane), next.lane]);
    for (const edge of rows[i].edges)
      assert.ok(nextNodes.has(edge.to), `父提交连线落在 lane ${edge.to}，下一行却不存在`);
  }
});

test('分页续算：state 快照接上后与一次性算完全相同', () => {
  const commits = [
    { sha: 'z', parents: ['a', 'b'] },
    { sha: 'b', parents: ['base'] },
    { sha: 'a', parents: ['base'] },
    { sha: 'base', parents: [] },
  ];
  const whole = buildGraph(commits);
  const first = new GraphWalker();
  const head = commits.slice(0, 2).map((commit) => first.push(commit));
  // 模拟「第二页」：用快照新建 walker 继续。
  const resumed = new GraphWalker(first.state);
  const tail = commits.slice(2).map((commit) => resumed.push(commit));
  assert.deepEqual([...head, ...tail], whole);
});

test('空位复用：新占用 slot 的分支拿到新颜色，不沿用上一任', () => {
  const walker = new GraphWalker();
  const tip = walker.push({ sha: 'z', parents: ['p1', 'p2'] });
  // p2 没有父提交 → 它那一列立刻空出来，之后可以被复用。
  const p2 = walker.push({ sha: 'p2', parents: [] });
  assert.notEqual(p2.lane, tip.lane);
  const p1 = walker.push({ sha: 'p1', parents: [] });
  assert.equal(p1.lane, tip.lane);
  for (const row of [tip, p2, p1]) assert.ok(row.color >= 0 && row.color < 8);
  // 三个节点里至少两种颜色（分叉出去的那条分支换了色）。
  assert.ok(new Set([tip.color, p2.color, p1.color]).size >= 2);
});
