import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as content from '../src/ui/content.js';
import * as batch from '../src/ui/batch.js';
import { ansiDisplayWidth, stripAnsi } from '../src/ui/render.js';
import { ui } from '../src/ui/theme.js';

const RESET = '\x1B[0m';
const TRUNCATED_MARKER = `…(还有 313 行未显示)${RESET}`;

/** 把 batch 期望的 layout 接口适配到 content 模块（contentWrite = feedChar + breakRow）。 */
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

/**
 * 带 scrollOffset 的 layout：复刻 content-write.ts contentInsertAfter 的视口语义。
 * keepViewport=true 且插入点在视口内时，会把 scrollOffset 顶到插入行数（视口锚定，
 * 新内容在下方）；否则视口跟随屏底（scrollOffset 保持 0）。
 */
function makeScrollAwareLayout(contentBottom = 10) {
  const st = { scrollOffset: 0, contentBottom };
  return {
    state: st,
    contentWrite(s: string) {
      for (const ch of s) {
        if (ch === '\n') content.breakRow();
        else content.feedChar(ch);
      }
    },
    contentInsertAfter(after: number, lines: string[], keepViewport = true) {
      const totalBefore = content.totalRows();
      const scrolled = st.scrollOffset > 0;
      content.insertAfter(after, lines);
      const delta = content.totalRows() - totalBefore;
      if (delta === 0) return;
      if (scrolled) {
        st.scrollOffset = Math.max(
          0,
          Math.min(st.scrollOffset + delta, Math.max(0, content.totalRows() - st.contentBottom)),
        );
      } else if (keepViewport && after < totalBefore) {
        const insertedAfterViewport = after >= totalBefore - st.contentBottom;
        if (insertedAfterViewport) {
          st.scrollOffset = Math.min(delta, Math.max(0, content.totalRows() - st.contentBottom));
        }
      }
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

describe('batch mutation 工具块折叠/重开', () => {
  it('折叠后重开，截断提示与 entry 行不重复', () => {
    batch.setMaxCols(120);
    const layout = makeLayout();

    // 模拟 agent：单条 write_file mutation，diff 块末尾带「还有 N 行未显示」截断提示
    // —— 这个字符串就是用户报告 bug 截图里看到的两行重复行。
    const id = batch.beginBatch();
    batch.recordCall(id, 'write_file', 'docs/computer-use-design.md');
    const diffLines = [
      `+ ${ui.dim}# Computer Use 设计:可插拔的桌面操控工具簇${RESET}`,
      `+ ${ui.dim}- **状态**:Design(待评审)${RESET}`,
      `+ ${ui.dim}- **范围**:**src/tools/builtins/**、**src/tools/constants.ts**${RESET}`,
      `+ ${ui.dim}- **一句话**:给 mocode 增加一个**默认关闭**、**/cu** 一键开关的 computer_use 套件${RESET}`,
      `+ ${RESET}`,
      TRUNCATED_MARKER,
    ].join('\n');
    batch.recordResult(id, 'write_file', 'Added 337 lines', diffLines);
    batch.endBatch(id, layout);

    // mutation 自动展开（路径：expandSingleEntryFully）
    batch.expandSingleEntryFully(id, layout);

    assert.equal(batch.isExpanded(id), true);
    const rowsAfterExpand = content.sliceFromEnd(0, content.totalRows());
    // 展开后: 截断提示应只出现 1 次
    assert.equal(
      rowsAfterExpand.filter((r) => r.includes('还有 313 行未显示')).length,
      1,
      'mutation 首次展开后截断提示应只出现 1 次',
    );

    // 用户折叠 entry 行的 details（模拟：用户先关掉了 details，只看 entry 摘要）
    batch.toggleEntry(id, 0, layout);
    const rowsAfterEntryCollapse = content.sliceFromEnd(0, content.totalRows());
    assert.equal(
      rowsAfterEntryCollapse.filter((r) => r.includes('还有 313 行未显示')).length,
      0,
      'entry 详情折叠后截断提示应消失',
    );

    // 用户再折叠 summary（关键 bug 触发路径）
    batch.toggleBatch(id, layout);
    assert.equal(batch.isExpanded(id), false);
    const rowsAfterCollapse = content.sliceFromEnd(0, content.totalRows());
    assert.equal(
      rowsAfterCollapse.filter((r) => r.includes('还有 313 行未显示')).length,
      0,
      '折叠后截断提示应被完全删除',
    );
    // entry 行也应被删（不再出现 "▸ write_file" / "▾ write_file"）
    assert.equal(
      rowsAfterCollapse.filter((r) => /write_file/.test(r) && /docs\/computer-use-design/.test(r)).length,
      0,
      '折叠后 entry 行应被完全删除',
    );

    // 用户再次展开 summary（触发 bug 的关键路径）
    batch.toggleBatch(id, layout);
    assert.equal(batch.isExpanded(id), true);

    // 用户最后再展开 entry 的 details，恢复完整 diff 视图
    batch.toggleEntry(id, 0, layout);

    const rowsAfterReopen = content.sliceFromEnd(0, content.totalRows());
    // 截断提示必须恰好 1 次（修复前会因 collapse 漏删 entry 行的旧 details 残留 → 出现 2 次）
    assert.equal(
      rowsAfterReopen.filter((r) => r.includes('还有 313 行未显示')).length,
      1,
      'mutation 工具块折叠后重开，截断提示不应重复出现',
    );
    // 第一层 entry 行也应只 1 次
    assert.equal(
      rowsAfterReopen.filter((r) => /write_file/.test(r) && /docs\/computer-use-design/.test(r)).length,
      1,
      'mutation 工具块折叠后重开，entry 行不应重复出现',
    );
  });

  it('mutation 自动展开后视口跟随屏底，不把 scrollOffset 顶上去', () => {
    batch.setMaxCols(120);
    // contentBottom=10：可视区远小于 diff 行数，确保一旦锚定视口就会被顶出大量 offset
    const layout = makeScrollAwareLayout(10);

    const id = batch.beginBatch();
    batch.recordCall(id, 'edit_file', 'docs/computer-use-design.md');
    // 造一个几十行的 diff（远超 contentBottom=10）
    const diffLines = Array.from({ length: 40 }, (_, i) => `+ line ${i + 1}${RESET}`).join('\n');
    batch.recordResult(id, 'edit_file', 'Applied 1 edit', diffLines);
    batch.endBatch(id, layout);

    assert.equal(layout.state.scrollOffset, 0, '展开前视口应在底部');

    // mutation 自动展开（agent 产出新内容，非用户点击回看）
    batch.expandSingleEntryFully(id, layout);

    // 修复前：expandSingleEntryFully 未传 keepViewport=false → 默认 true → 视口锚定，
    // scrollOffset 被顶到插入行数（40 行）→ 后续 contentWriteMd 见 offset>0 只喂缓冲不物理写，
    // 表现为「edit_file 后不自动滚动，得手动拉到底」。
    assert.equal(layout.state.scrollOffset, 0, 'mutation 自动展开属新内容，视口必须跟随屏底（scrollOffset 保持 0）');
  });

  it('用户点击展开仍锚定视口（keepViewport 语义不被自动展开改动波及）', () => {
    batch.setMaxCols(120);
    const layout = makeScrollAwareLayout(10);

    const id = batch.beginBatch();
    batch.recordCall(id, 'read_file', 'package.json');
    batch.recordResult(id, 'read_file', 'Read 40 lines', null, 'line\n'.repeat(40));
    batch.endBatch(id, layout);
    assert.equal(layout.state.scrollOffset, 0);

    // 模拟鼠标点击摘要行展开第一层
    batch.toggleBatch(id, layout);
    assert.equal(batch.isExpanded(id), true);
    // 第一层只有 1 条 entry 行,视口(10 行)装得下,offset 仍为 0 属正常;
    // 锚定语义要点在第二层:点击 entry 展开 40 行详情时视口必须锚定(不跳底)。
    batch.toggleEntry(id, 0, layout);

    assert.ok(layout.state.scrollOffset > 0, '用户点击展开应锚定视口，不自动跳到详情底部');
  });
});

describe('batch 纯渲染 helper', () => {
  it('sanitizeRow 保留 SGR、替换控制字符并钳制物理行宽', () => {
    const row = batch.sanitizeRow(`${ui.red}ab\tcd\x00${'界'.repeat(20)}${ui.reset}`, 12);

    assert.ok(row.includes(ui.red), 'SGR 颜色序列应保留');
    assert.ok(stripAnsi(row).includes('·'), '裸控制字符应替换为可见字符');
    assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(stripAnsi(row)), false);
    assert.ok(ansiDisplayWidth(row) <= 12, '缓冲一行不得触发终端自动折行');
    assert.ok(row.endsWith(RESET), '每条物理行必须以 reset 收尾');
  });

  it('buildExpandedLines 的 fromIndex 只渲染尚未输出的 entry', () => {
    const entries: batch.BatchEntry[] = [
      { name: 'read_file', callSummary: 'first.ts', resultSummary: '1 line', diffBlock: null },
      { name: 'grep', callSummary: 'needle', resultSummary: '2 matches', diffBlock: null },
      { name: 'glob', callSummary: '**/*.ts', resultSummary: '3 files', diffBlock: null },
    ];

    const lines = batch.buildExpandedLines({ entries, expandedEntries: new Set<number>() }, '', 1, 120);
    const visible = lines.map(stripAnsi);

    assert.equal(lines.length, 2);
    assert.equal(
      visible.some((line) => line.includes('first.ts')),
      false,
    );
    assert.match(visible[0], /grep.*needle/);
    assert.match(visible[1], /glob.*\*\*\/\*\.ts/);
  });

  it('缩进单一体系:entry 行前导 = ENTRY_INDENT(2),子批随批缩进联动', () => {
    // entry 行相对摘要行的前导缩进(曾为 4,用户反馈第二层留白过大 → 收成 2)。
    // 必须带 resultSummary —— 否则 hasEntryDetail 为 false,三角退化成占位空格,indexOf('▸') 得 -1。
    const mk = (name: string, extraIndent: string) =>
      batch.buildExpandedLines(
        {
          entries: [{ name, callSummary: 'pwd-cmd', resultSummary: 'ok-result', diffBlock: null }],
          expandedEntries: new Set<number>(),
        },
        extraIndent,
        0,
        120,
      );

    assert.equal(stripAnsi(mk('run_command', '')[0]).indexOf('▸'), 2, 'entry 行 ▸ 应落在 col 2');

    // 子批(挂在父批下)多叠 SUB_BATCH_INDENT,不能与 ENTRY_INDENT 脱钩。
    assert.equal(
      stripAnsi(mk('grep', batch.SUB_BATCH_INDENT)[0]).indexOf('▸'),
      batch.SUB_BATCH_INDENT.length + 2,
      '子批 entry 行 = 批缩进 + ENTRY_INDENT',
    );
  });
});

describe('batch 摘要行:结构与字形', () => {
  /** 取 content 缓冲里最后一条摘要行(剥色)。摘要行是 endBatch 前 totalRows-2 那条。 */
  function lastSummary(rowIdx: number): string {
    return stripAnsi(content.lineAt(rowIdx) ?? '');
  }

  it('同类工具合并计数;单次调用不带计数(不再出现「run_command 1」)', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'run_command', 'npm run dev');
    batch.showLiveBatch(id, layout);
    const one = lastSummary(content.totalRows() - 2);
    assert.match(one, /run_command/);
    assert.doesNotMatch(one, /run_command\s+1\b/, '单次调用不应带冗余计数');
  });

  it('多次调用写 ×N', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'read_file', 'a.ts');
    batch.recordCall(id, 'read_file', 'b.ts');
    batch.recordCall(id, 'read_file', 'c.ts');
    batch.showLiveBatch(id, layout);
    assert.match(lastSummary(content.totalRows() - 2), /read_file ×3/);
  });

  it('符号与标签间距恒定 1 空格(防回归:曾误留 3 空格,符号读作孤立在左)', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'run_command', 'a');
    batch.recordCall(id, 'run_command', 'b');
    batch.showLiveBatch(id, layout);
    const line = lastSummary(content.totalRows() - 2);
    // 缩进 + 符号 + 恰好 1 空格 + 标签:运行态应为「◇ 正在探索」(前缀后无额外留白)。
    assert.match(line, /◇ [^\s]/, '符号与标签之间应恰好 1 空格');
    assert.doesNotMatch(line, /◇\s{2,}/, '符号后不应出现 2+ 空格');

    batch.recordResult(id, 'run_command', 'ok', null, 'ok');
    batch.recordResult(id, 'run_command', 'ok', null, 'ok');
    batch.endBatch(id, layout);
    const done = lastSummary(content.totalRows() - 2);
    assert.doesNotMatch(done, /◆\s{2,}/, '收口态符号后同样不应出现 2+ 空格');
  });

  it('字形即进度:未回结果 → ◇,部分回 → 档位推进,收口 → ◆', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'run_command', 'a');
    batch.recordCall(id, 'run_command', 'b');
    batch.recordCall(id, 'run_command', 'c');
    batch.recordCall(id, 'run_command', 'd');
    batch.showLiveBatch(id, layout);
    const rowIdx = content.totalRows() - 2;
    assert.match(lastSummary(rowIdx), /◇/);

    batch.recordResult(id, 'run_command', 'ok', null, 'ok');
    batch.recordResult(id, 'run_command', 'ok', null, 'ok');
    batch.showLiveBatch(id, layout);
    const mid = lastSummary(rowIdx);
    assert.match(mid, /[◔◑◕]/, '部分完成应落到中间档字形');
    assert.doesNotMatch(mid, /◆/, '未收口不应出现实心 ◆');

    batch.recordResult(id, 'run_command', 'ok', null, 'ok');
    batch.recordResult(id, 'run_command', 'ok', null, 'ok');
    batch.endBatch(id, layout);
    assert.match(lastSummary(rowIdx), /◆/, '收口应落 ◆ 实心');
  });

  it('全失败用 ×,部分失败用 !', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'run_command', 'x');
    batch.recordResult(id, 'run_command', 'Error', null, 'boom', true);
    batch.endBatch(id, layout);
    assert.match(lastSummary(content.totalRows() - 2), /×/);

    const id2 = batch.beginBatch();
    batch.recordCall(id2, 'run_command', 'y');
    batch.recordCall(id2, 'read_file', 'z.ts');
    batch.recordResult(id2, 'run_command', 'Error', null, 'boom', true);
    batch.recordResult(id2, 'read_file', 'ok', null, 'ok');
    batch.endBatch(id2, layout);
    const all = content.sliceFromEnd(0, content.totalRows()).map(stripAnsi);
    assert.ok(
      all.some((l) => /!/.test(l)),
      '部分失败应出现 !',
    );
  });

  it('在飞态显实时耗时(而非等收尾才出数字)', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'run_command', 'sleep 30');
    batch.showLiveBatch(id, layout);
    const live = lastSummary(content.totalRows() - 2);
    assert.match(live, /<\d|\d+(\.\d+)?s|m \d+s/, '在飞态应带耗时');
    assert.match(live, /步|step/, '应带步数');
  });
});

describe('sweepRender 可见宽度不变量(行宽钳制与 buffer 索引的前提)', () => {
  const HI = '\x1B[38;2;130;225;240m';
  const BASE = '\x1B[38;2;86;182;194m';

  it('任意帧下可见字符序列与宽度都不变(仅 SGR 变化)', () => {
    for (const label of ['正在探索', '子 Agent 运行中', 'Exploring', 'a', '']) {
      const expect = [...label].join('');
      for (let f = 0; f < 60; f++) {
        const rendered = batch.sweepRender(label, BASE, HI, f);
        assert.equal(stripAnsi(rendered), label, `帧 ${f}: 可见文本被改动`);
        assert.equal([...stripAnsi(rendered)].join(''), expect);
      }
    }
  });

  it('高亮带在一个周期内扫过所有位置且不越界', () => {
    const n = 4;
    const seen = new Set<number>();
    for (let f = 0; f < n * 2; f++) {
      const [start, end] = batch.sweepBandRange(n, f);
      assert.ok(start >= 0 && end <= n, `帧 ${f}: 区间 [${start},${end}) 越界`);
      assert.ok(end > start, `帧 ${f}: 空带`);
      for (let i = start; i < end; i++) seen.add(i);
    }
    assert.equal(seen.size, n, '一个周期内每个字符都应被扫到');
  });

  it('带宽不超过 SWEEP_BAND 且短文本自动收窄', () => {
    for (const n of [1, 2, 3, 4, 11]) {
      for (let f = 0; f < n * 2 + 2; f++) {
        const [s, e] = batch.sweepBandRange(n, f);
        assert.ok(e - s <= Math.min(3, n), `n=${n} 帧 ${f}: 带宽 ${e - s} 超限`);
      }
    }
  });

  it('帧号回环连续:周期末与周期首之间无空白帧', () => {
    const n = 5;
    const cycle = n * 2;
    const a = batch.sweepBandRange(n, cycle - 1);
    const b = batch.sweepBandRange(n, cycle);
    assert.deepEqual(b, batch.sweepBandRange(n, 0));
    assert.ok(a[1] > a[0] && b[1] > b[0]);
  });

  it('负数/超大帧号不抛错(帧号归一化)', () => {
    assert.doesNotThrow(() => batch.sweepBandRange(4, -1));
    assert.doesNotThrow(() => batch.sweepRender('测试', BASE, HI, -7));
    assert.doesNotThrow(() => batch.sweepRender('测试', BASE, HI, 1e9));
  });
});

describe('batch renderedCount 不变量', () => {
  it('一级展开后折叠会删除全部 entry 行并保留下游正文', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'read_file', 'first.ts');
    batch.recordResult(id, 'read_file', 'Read 1 line', null);
    batch.recordCall(id, 'grep', 'unique-needle');
    batch.recordResult(id, 'grep', 'Found 1 match', null);
    batch.endBatch(id, layout);

    batch.expandBatch(id, layout);
    layout.contentWrite('sentinel-after-batch\n');
    assert.deepEqual(batch.findEntryByAbsLine(1), { batchId: id, entryIndex: 0 });
    assert.deepEqual(batch.findEntryByAbsLine(2), { batchId: id, entryIndex: 1 });

    batch.toggleBatch(id, layout);
    const visible = content.sliceFromEnd(0, content.totalRows()).map(stripAnsi);

    assert.equal(
      visible.some((line) => line.includes('first.ts')),
      false,
    );
    assert.equal(
      visible.some((line) => line.includes('unique-needle')),
      false,
    );
    assert.equal(
      visible.some((line) => line.includes('sentinel-after-batch')),
      true,
    );
  });

  it('运行态增量刷新不重复旧 entry，重复 refresh 为 no-op', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'read_file', 'first-only.ts');
    batch.showLiveBatch(id, layout);
    batch.expandBatch(id, layout, true);

    batch.recordCall(id, 'grep', 'second-only');
    batch.refreshBatchExpanded(id, layout);
    const afterFirstRefresh = content.sliceFromEnd(0, content.totalRows());
    batch.refreshBatchExpanded(id, layout);
    const afterSecondRefresh = content.sliceFromEnd(0, content.totalRows());

    assert.deepEqual(afterSecondRefresh, afterFirstRefresh, 'renderedCount 推进后重复 refresh 必须为 no-op');
    const visible = afterSecondRefresh.map(stripAnsi);
    assert.equal(visible.filter((line) => line.includes('first-only.ts')).length, 1);
    assert.equal(visible.filter((line) => line.includes('second-only')).length, 1);
    assert.deepEqual(batch.findEntryByAbsLine(2), { batchId: id, entryIndex: 1 });

    batch.toggleBatch(id, layout);
    const collapsed = content.sliceFromEnd(0, content.totalRows()).map(stripAnsi);
    assert.equal(
      collapsed.some((line) => line.includes('first-only.ts')),
      false,
    );
    assert.equal(
      collapsed.some((line) => line.includes('second-only')),
      false,
    );
  });
});

// 运行态可能已记录新调用但尚未来得及把它插入 buffer；折叠只能按 renderedCount 删除。
describe('batch renderedCount 未追平 entries', () => {
  it('未渲染 entry 不得让折叠多删相邻正文', () => {
    const layout = makeLayout();
    const id = batch.beginBatch();
    batch.recordCall(id, 'read_file', 'rendered-entry.ts');
    batch.showLiveBatch(id, layout);
    batch.expandBatch(id, layout, true);

    batch.recordCall(id, 'grep', 'recorded-but-not-rendered');
    layout.contentWrite('sentinel-must-survive\n');

    batch.toggleBatch(id, layout);
    const visible = content.sliceFromEnd(0, content.totalRows()).map(stripAnsi);

    assert.equal(
      visible.some((line) => line.includes('rendered-entry.ts')),
      false,
    );
    assert.equal(
      visible.some((line) => line.includes('recorded-but-not-rendered')),
      false,
    );
    assert.equal(
      visible.some((line) => line.includes('sentinel-must-survive')),
      true,
      '折叠必须只删除 renderedCount 条一级行，不能按 entries.length 多删正文',
    );
  });
});

// 详情行缩进必须跟随批自身层级:子批(挂在父批下、entry 行更深)的二层详情
// 若仍用固定常量,会跑回父层左侧 —— 层级读错、且插/删行数计算点同源,漏改会行错位。
describe('batch 详情行缩进随批层级联动', () => {
  it('无缩进批的详情行 = DETAIL_INDENT(5);子批详情 = 批缩进 + 5', () => {
    const layout = makeLayout();
    /** 按剥色后的整行精确取详情行 —— 不能用 includes('a') 之类的子串匹配:
     *  摘要行 `◆ Exploration …` 里同样含 'a',会误命中(实测踩到)。 */
    const detailRow = (text: string): string =>
      content
        .sliceFromEnd(0, content.totalRows())
        .map((r) => stripAnsi(r))
        .find((r) => r.trim() === text) ?? '';

    const id = batch.beginBatch();
    batch.recordCall(id, 'run_command', 'pwd');
    batch.recordResult(id, 'run_command', 'ok', null, 'a\nb\nc');
    batch.endBatch(id, layout);
    batch.expandBatch(id, layout, true);
    batch.toggleEntry(id, 0, layout);

    const row = detailRow('a');
    assert.notEqual(row, '', '详情行应已插入');
    assert.equal(row.match(/^ */)?.[0].length, 5, '顶层批详情行前导缩进应为 5');

    // 子批:同一 entry 展开,详情行必须整体右移 SUB_BATCH_INDENT
    const child = batch.beginBatch('子 Agent 运行中', { indent: batch.SUB_BATCH_INDENT, running: true });
    batch.recordCall(child, 'grep', 'needle');
    batch.recordResult(child, 'grep', '3 matches', null, 'x.ts\n');
    batch.showLiveBatch(child, layout as never);
    batch.endBatch(child, layout);
    batch.expandBatch(child, layout, true);
    batch.toggleEntry(child, 0, layout);

    const childRow = detailRow('x.ts');
    assert.notEqual(childRow, '', '子批详情行应已插入');
    assert.equal(
      childRow.match(/^ */)?.[0].length,
      batch.SUB_BATCH_INDENT.length + 5,
      '子批详情行前导缩进 = 批缩进 + DETAIL_INDENT(不得跑回父层左侧)',
    );
  });
});
