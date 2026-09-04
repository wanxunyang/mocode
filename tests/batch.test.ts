import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as content from '../src/ui/content.js';
import * as batch from '../src/ui/batch.js';
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
    assert.equal(
      layout.state.scrollOffset,
      0,
      'mutation 自动展开属新内容，视口必须跟随屏底（scrollOffset 保持 0）',
    );
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