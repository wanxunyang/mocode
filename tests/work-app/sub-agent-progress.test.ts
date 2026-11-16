/**
 * 子 agent 卡片的进度解析层（packages/work-app/src/sub-agent-progress.ts）。
 *
 * 钉三件事：
 *   1. start/end 机器行能配成一条可展开条目（工具名 + 入参 + 输出）；
 *   2. 只有 `▸` 行的老会话退化成清单，不丢内容；
 *   3. `isSubAgentProgressLine` 认得两种行 —— renderer / recovery-log 靠它判断
 *      「最终结论会不会把进度行盖掉」，判错就等于卡片展开区永久为空。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSubAgentProgressLine,
  isSubAgentProgressLine,
  splitSubAgentProgress,
  SUB_TOOL_PREFIX,
} from '../../packages/work-app/src/sub-agent-progress.js';

const line = (payload: Record<string, unknown>): string => `${SUB_TOOL_PREFIX}${JSON.stringify(payload)}`;

test('start + end 机器行配对成一条条目：带完整入参与该次输出', () => {
  const output = [
    line({ phase: 'start', name: 'run_command', summary: 'npm test', args: '{"command":"npm test"}' }),
    line({ phase: 'end', name: 'run_command', summary: '12 行', failed: false, output: 'ok 12 tests' }),
    '子任务结论：测试全绿',
  ].join('\n');
  const { steps, lines, rest } = splitSubAgentProgress(output);
  assert.equal(lines.length, 0, '有机器行时不应再产出旧式进度行');
  assert.equal(steps.length, 1);
  assert.deepEqual(
    { name: steps[0]!.name, done: steps[0]!.done, failed: steps[0]!.failed },
    { name: 'run_command', done: true, failed: false },
  );
  assert.equal(steps[0]!.args, '{"command":"npm test"}');
  assert.equal(steps[0]!.output, 'ok 12 tests');
  assert.equal(rest.join('\n').trim(), '子任务结论：测试全绿');
});

test('同名工具连续调用各自成条（end 不串到上一条已完成的）', () => {
  const output = [
    line({ phase: 'start', name: 'read_file', summary: 'a.ts', args: '{"path":"a.ts"}' }),
    line({ phase: 'end', name: 'read_file', output: 'A' }),
    line({ phase: 'start', name: 'read_file', summary: 'b.ts', args: '{"path":"b.ts"}' }),
    line({ phase: 'end', name: 'read_file', output: 'B' }),
  ].join('\n');
  const { steps } = splitSubAgentProgress(output);
  assert.equal(steps.length, 2);
  assert.deepEqual(
    steps.map((step) => step.output),
    ['A', 'B'],
  );
  assert.deepEqual(
    steps.map((step) => step.args),
    ['{"path":"a.ts"}', '{"path":"b.ts"}'],
  );
});

test('只有 start 没有 end：条目保留为未完成（子 agent 还在跑或被打断）', () => {
  const { steps } = splitSubAgentProgress(
    line({ phase: 'start', name: 'grep', summary: 'foo', args: '{"pattern":"foo"}' }),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.done, false);
  assert.equal(steps[0]!.output, '');
});

test('孤立的 end（缺 start / 旧数据）仍产出一条完整条目，信息不丢', () => {
  const { steps } = splitSubAgentProgress(
    line({ phase: 'end', name: 'glob', summary: '*.ts', failed: true, output: '错误: 无匹配' }),
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.done, true);
  assert.equal(steps[0]!.failed, true);
  assert.match(steps[0]!.output, /无匹配/);
});

test('坏 JSON 的机器行退化成普通进度行，不让整张卡片渲染失败', () => {
  const { steps, lines, rest } = splitSubAgentProgress(`${SUB_TOOL_PREFIX}{not json`);
  assert.equal(steps.length, 0);
  assert.equal(lines.length, 1);
  assert.equal(rest.join('').trim(), '');
});

test('老会话只有 ▸ 行：仍能渲染清单', () => {
  const { steps, lines } = splitSubAgentProgress(['▸ read_file  src/a.ts', '▸ grep  foo'].join('\n'));
  assert.equal(steps.length, 0);
  assert.equal(lines.length, 2);
});

test('isSubAgentProgressLine / hasSubAgentProgressLine 认得两种行（收尾合并依赖它）', () => {
  assert.equal(isSubAgentProgressLine('▸ read_file  src/a.ts'), true);
  assert.equal(isSubAgentProgressLine(`  ${line({ phase: 'start', name: 'x' })}`), true, '行首空白不影响判定');
  assert.equal(isSubAgentProgressLine('子任务结论'), false);
  assert.equal(hasSubAgentProgressLine('结论\n[sub-tool]{"phase":"start"}'), true);
  assert.equal(hasSubAgentProgressLine('结论\n第二行'), false);
});
