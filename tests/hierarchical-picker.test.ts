/** 层级模糊选择器纯函数单测：flattenTree（路径 / 面包屑 / 分支叶子）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTree, type HPNode } from '../src/ui/hierarchical-picker.js';

function leaf(label: string, value: string): HPNode<string> {
  return { searchText: label, label, value };
}
function branch(label: string, children: HPNode<string>[]): HPNode<string> {
  return { searchText: label, label, children };
}

test('flattenTree: 深度优先，分支与叶子都收录，路径正确', () => {
  const roots: HPNode<string>[] = [
    branch('Volcengine', [leaf('doubao-seed', 'm1'), leaf('doubao-pro', 'm2')]),
    leaf('自定义', 'custom'),
  ];
  const flat = flattenTree(roots);

  // 节点数：2 root（Volcengine 分支 + 自定义叶）+ 2 子叶 = 4。
  assert.equal(flat.length, 4);
  assert.deepEqual(
    flat.map((h) => h.node.label),
    ['Volcengine', 'doubao-seed', 'doubao-pro', '自定义'],
  );
  assert.deepEqual(flat[0].path, [0]);
  assert.deepEqual(flat[1].path, [0, 0]);
  assert.deepEqual(flat[2].path, [0, 1]);
  assert.deepEqual(flat[3].path, [1]);
});

test('flattenTree: 面包屑记录祖先链，root 直属为空', () => {
  const roots: HPNode<string>[] = [branch('厂商A', [branch('子组', [leaf('模型X', 'x')])]), leaf('操作行', 'op')];
  const flat = flattenTree(roots);
  assert.equal(flat[0].crumb, ''); // 厂商A
  assert.equal(flat[1].crumb, '厂商A'); // 子组
  assert.equal(flat[2].crumb, '厂商A › 子组'); // 模型X
  assert.equal(flat[3].crumb, ''); // 操作行
});
