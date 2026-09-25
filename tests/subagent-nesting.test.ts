import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as content from '../src/ui/content.js';
import * as batch from '../src/ui/batch.js';
import { stripAnsi } from '../src/ui/render.js';

/** 复刻 batch.test.ts 的 layout 适配(content 模块为纯 buffer,不写真实终端)。 */
function makeLayout() {
  return {
    contentWrite(s: string) {
      for (const ch of s) {
        if (ch === '\n') content.breakRow();
        else content.feedChar(ch);
      }
    },
    contentInsertAfter(after: number, lines: string[]) {
      content.insertAfter(after, lines);
    },
    contentDeleteFrom(start: number, n: number) {
      content.deleteFrom(start, n);
    },
    contentReplaceLine(abs: number, line: string) {
      content.replaceLine(abs, line);
    },
    totalRows: () => content.totalRows(),
  };
}

afterEach(() => {
  batch.reset();
  content.reset();
});

describe('子 agent 嵌套调用树状挂载', () => {
  it('孙批挂到内部 sub-agent entry 下:父折叠时隐藏,展开按层级缩进恢复,折叠再移除', () => {
    batch.setMaxCols(120);
    const layout = makeLayout();
    const rows = () => content.sliceFromEnd(0, content.totalRows()).map((r) => stripAnsi(r));
    const leadingSpaces = (r: string) => r.match(/^ */)?.[0].length ?? 0;

    // ── 主侧:组容器批 + 第 1 个 sub-agent 调用(c1)──
    const group = batch.beginBatch(undefined, { groupParent: true });
    batch.bindCall('c1', group);
    batch.recordCall(group, 'sub-agent', '{"prompt":"L1 delegation"}', 'c1');
    batch.showLiveBatch(group, layout as never);
    batch.expandBatch(group, layout as never, true);

    // ── L1 子 agent 批:组容器批的子批(缩进 4)──
    const l1 = batch.beginBatch('子 Agent 运行中', {
      parentId: batch.batchIdForCall('c1') ?? undefined,
      groupChildIndex: batch.getGroupChildIndex('c1'),
      running: true,
    });
    batch.showLiveBatch(l1, layout as never);

    // L1 内部:read_file + 嵌套 sub-agent 调用(c2)——全部默认折叠在 L1 摘要行里。
    batch.bindCall('read-1', l1);
    batch.recordCall(l1, 'read_file', 'package.json', 'read-1');
    batch.showLiveBatch(l1, layout as never);
    batch.recordResult(l1, 'read_file', '120 lines', null, 'pkg contents', false, 'read-1');
    batch.showLiveBatch(l1, layout as never);
    batch.bindCall('c2', l1);
    batch.recordCall(l1, 'sub-agent', '{"prompt":"L2 delegation"}', 'c2');
    batch.showLiveBatch(l1, layout as never);

    // ── L2 孙批:spawnAgent 内据 c2 反查父批,应挂到 L1 而非游离到 buffer 末尾 ──
    const l2 = batch.beginBatch('子 Agent 运行中', {
      parentId: batch.batchIdForCall('c2') ?? undefined,
      groupChildIndex: batch.getGroupChildIndex('c2'),
      running: true,
    });
    // L1 处于折叠态:L2 摘要先隐藏。
    batch.showLiveBatch(l2, layout as never);
    batch.bindCall('write-1', l2);
    batch.recordCall(l2, 'write_file', 'nested/a.txt', 'write-1');
    batch.showLiveBatch(l2, layout as never);
    batch.recordResult(l2, 'write_file', 'No output', null, '', false, 'write-1');
    batch.showLiveBatch(l2, layout as never);
    // L2 在 L1 折叠期间跑完 → endBatch 保持隐藏,等 L1 展开时统一恢复。
    batch.setBatchRunning(l2, false);
    batch.endBatch(l2, layout as never);

    // L2 缩进 = L1 缩进(4) + SUB_BATCH_INDENT(4) = 8(在恢复后验证)。

    // L1 折叠中:buffer 里只有 L1 摘要行(缩进 4),没有 L2 的 8 缩进行。
    let current = rows();
    const l1SummaryIdx = current.findIndex((r) => r.includes('子 Agent'));
    assert.notEqual(l1SummaryIdx, -1, 'L1 摘要行应已落盘');
    assert.equal(leadingSpaces(current[l1SummaryIdx]), batch.SUB_BATCH_INDENT.length);
    assert.equal(
      current.some((r) => leadingSpaces(r) === batch.SUB_BATCH_INDENT.length * 2 && r.includes('子 Agent')),
      false,
      'L1 折叠时 L2 孙批摘要必须隐藏',
    );

    // 用户点击 L1 摘要行 → 展开内部工具列表并恢复 L2。
    batch.toggleBatch(l1, layout as never);
    current = rows();
    // L1 的内部 sub-agent entry 行(c2 的 callSummary)
    const entryIdx = current.findIndex((r) => r.trimStart().startsWith('sub-agent') && r.includes('L2 delegation'));
    assert.notEqual(entryIdx, -1, 'L1 内部 sub-agent entry 应已展开');
    // L2 摘要行必须紧跟在该 entry 行下方,且缩进 8(树状逐层加深)。
    const l2Row = current[entryIdx + 1];
    assert.ok(l2Row, 'L2 摘要行应紧跟内部 sub-agent entry');
    assert.equal(l2Row.includes('子 Agent'), true);
    assert.equal(leadingSpaces(l2Row), batch.SUB_BATCH_INDENT.length * 2, '孙批摘要缩进必须比子批再深一层');

    // 再点 L1 摘要 → 折叠:内部 entry 与 L2 一并移除,L1 摘要保留。
    batch.toggleBatch(l1, layout as never);
    current = rows();
    assert.equal(
      current.some((r) => r.includes('L2 delegation')),
      false,
      '折叠后 L1 内部 entry 必须移除',
    );
    assert.equal(
      current.some((r) => leadingSpaces(r) === batch.SUB_BATCH_INDENT.length * 2 && r.includes('子 Agent')),
      false,
      '折叠后 L2 孙批必须一并移除',
    );
    assert.equal(
      current.some((r) => r.includes('子 Agent')),
      true,
      'L1 摘要行应保留',
    );
  });
});
