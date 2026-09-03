/** 未知斜杠命令的纠错建议(纯逻辑,可单测)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestCommand } from '../src/repl/index.js';

test('suggestCommand:常见拼写错误能纠到正确命令', () => {
  assert.equal(suggestCommand('/hepl'), '/help');
  assert.equal(suggestCommand('/hlep'), '/help');
  assert.equal(suggestCommand('/theem'), '/theme');
  assert.equal(suggestCommand('/moc'), '/mcp');
  // /modle 离 /mode(真正的命令,plan/auto 的父节点)只差一个字母,比 /model 更近
  assert.equal(suggestCommand('/modle'), '/mode');
});

test('suggestCommand:离得太远就不该瞎猜', () => {
  assert.equal(suggestCommand('/zzzzzzzz'), null);
  assert.equal(suggestCommand('/x'), null);
});

test('suggestCommand:菜单树外的真实命令(/quit)也能被建议', () => {
  // /quit 可用但没登记进菜单树,knownCommandNames 里补了,保证建议出来的命令真能执行
  assert.equal(suggestCommand('/quiy'), '/quit');
});
