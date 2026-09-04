import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as content from '../src/ui/content.js';
import { renderMarkdown } from '../src/ui/markdown.js';
import { padEndAnsiBackground, remapWrappedPoint, stripAnsi } from '../src/ui/render.js';

const RESET = '\x1B[0m';

function snapshot(): string[] {
  return content.sliceFromEnd(0, content.totalRows());
}

afterEach(() => content.reset());

describe('content markdown resize reflow', () => {
  it('按新列宽重新渲染已提交 markdown 段', () => {
    const source = '这是一段需要在窄窗口中换行、在宽窗口中重新铺开的 agent 正文。';
    const narrow = renderMarkdown(source, 12);

    content.beginSegment();
    content.setLines(narrow, source);
    content.commitSegment();

    assert.ok(narrow.length > 1);
    const changes = content.reflowMarkdown(80, renderMarkdown);

    assert.ok(changes.some((change) => change.delta < 0));
    assert.deepEqual(snapshot(), renderMarkdown(source, 80));
  });

  it('重排前段后仍能定位并重排后续 markdown 段', () => {
    const first = 'first segment contains enough words to wrap in a narrow terminal';
    const second = 'second segment also needs wrapping and must keep its own source';

    content.beginSegment();
    content.setLines(renderMarkdown(first, 14), first);
    content.commitSegment();
    content.feedChar('·');
    content.breakRow();
    content.beginSegment();
    content.setLines(renderMarkdown(second, 14), second);
    content.commitSegment();

    content.reflowMarkdown(80, renderMarkdown);

    assert.deepEqual(snapshot(), [
      ...renderMarkdown(first, 80),
      `·${RESET}`,
      ...renderMarkdown(second, 80),
    ]);
  });

  it('重排已提交段时保留末尾当前待写行', () => {
    const source = 'a markdown paragraph that wraps across several narrow rows';

    content.beginSegment();
    content.setLines(renderMarkdown(source, 12), source);
    content.commitSegment();
    content.feedChar('尾');

    content.reflowMarkdown(80, renderMarkdown);

    assert.equal(content.currentRowRaw(), '尾');
    assert.equal(content.lineAt(content.totalRows() - 1), `尾${RESET}`);
    assert.deepEqual(snapshot().slice(0, -1), renderMarkdown(source, 80));
  });

  it('one-shot markdown 可补回空的待写行', () => {
    const source = 'history paragraph';
    const rendered = renderMarkdown(source, 20);

    content.beginSegment();
    content.setLines(rendered, source);
    content.commitSegment();
    content.ensureCurrentRow();

    assert.equal(content.committedRows(), rendered.length);
    assert.equal(content.totalRows(), rendered.length + 1);
    assert.equal(content.currentRowRaw(), '');
    assert.equal(content.lineAt(content.totalRows() - 1), RESET);
  });

  it('用户消息背景可在放宽后补到新列宽', () => {
    const userBg = '\x1B[48;2;72;78;90m';
    const narrow = `${userBg}❯ 探索项目   ${RESET}`;

    const wide = padEndAnsiBackground(narrow, 24, userBg, RESET);

    assert.equal(stripAnsi(wide), '❯ 探索项目' + ' '.repeat(14));
    assert.equal(wide.endsWith(`${userBg}${' '.repeat(11)}${RESET}`), true);
  });

  it('物理行数不变但断行边界变化时也报告 reflow，并按字符位置迁移选区', () => {
    const oldLines = ['abcdefghij', 'klmnopqrst', 'uvwxyz'].map((line) => `${line}${RESET}`);
    const newLines = ['abcdefghijkl', 'mnopqrstuvwx', 'yz'].map((line) => `${line}${RESET}`);

    content.beginSegment();
    content.setLines(oldLines, 'abcdefghijklmnopqrstuvwxyz');
    content.commitSegment();

    const changes = content.reflowMarkdown(12, () => newLines);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].delta, 0);
    assert.deepEqual(changes[0].oldLines, oldLines);
    assert.deepEqual(changes[0].newLines, newLines);

    const start = remapWrappedPoint(oldLines, newLines, { line: 1, col: 1 });
    const end = remapWrappedPoint(oldLines, newLines, { line: 1, col: 5 });
    assert.deepEqual(start, { line: 0, col: 11 });
    assert.deepEqual(end, { line: 1, col: 3 });

    const selected = [
      stripAnsi(newLines[start.line]).slice(start.col),
      stripAnsi(newLines[end.line]).slice(0, end.col),
    ].join('');
    assert.equal(selected, 'lmno');
  });
});
