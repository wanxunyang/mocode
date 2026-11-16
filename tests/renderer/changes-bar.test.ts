/**
 * 会话下方「本轮改动」长条列表的结构生成。
 *
 * 回归背景：任务跑完后用户第一件事是「它改了哪些文件」，而在这一版之前那句话只是
 * 正文里的一段文字，用户得自己复制路径再去编辑器里打开。这里把那批路径渲染成
 * 一条条长条，点击由 renderer.ts 的 openChangeDiff 送到右侧面板的 diff 视图。
 *
 * 这份 HTML 是纯字符串（无 DOM、无 i18n 运行时），所以能在 node 里直接断言。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { changesBarHtml, type ChangesBarLabels } from '../../packages/work-app/src/renderer/changes-bar.js';

const labels: ChangesBarLabels = {
  title: (n) => `本轮改动 · ${n} 个文件`,
  all: '全部改动',
  untracked: '新文件',
  open: (path) => `查看 ${path} 的改动`,
};

/** 每个长条的 data-change-path（点击时用它定位文件）。 */
const paths = (html: string): string[] => [...html.matchAll(/data-change-path="([^"]*)"/g)].map((match) => match[1]!);

test('每个文件一条长条，data-change-path 保留完整相对路径', () => {
  const html = changesBarHtml(
    [
      { path: 'docs/design.md', added: 3, removed: 1, untracked: false },
      { path: 'src/index.ts', added: 0, removed: 0, untracked: false },
    ],
    labels,
  );
  assert.deepEqual(paths(html), ['docs/design.md', 'src/index.ts']);
  assert.match(html, /本轮改动 · 2 个文件/);
});

test('路径拆成目录 + 文件名：文件名在前（用户扫读对象），目录单独弱化', () => {
  const html = changesBarHtml(
    [{ path: 'packages/work-app/src/renderer/renderer.ts', added: 1, removed: 0, untracked: false }],
    labels,
  );
  assert.match(html, /<span class="changes-bar-name">renderer\.ts<\/span>/);
  assert.match(html, /<span class="changes-bar-dir">packages\/work-app\/src\/renderer\/<\/span>/);
});

test('无目录（仓库根文件）时不产出空的目录节点', () => {
  const html = changesBarHtml([{ path: 'README.md', added: 1, removed: 0, untracked: false }], labels);
  assert.doesNotMatch(html, /changes-bar-dir/);
});

test('Windows 反斜杠路径按正斜杠拆分，不会把整串当文件名', () => {
  const html = changesBarHtml([{ path: 'src\\agent\\model-turn.ts', added: 2, removed: 0, untracked: false }], labels);
  assert.match(html, /<span class="changes-bar-name">model-turn\.ts<\/span>/);
  assert.match(html, /<span class="changes-bar-dir">src\/agent\/<\/span>/);
});

test('增删统计：只显示非零项，两侧为零就不出现统计块', () => {
  const onlyAdded = changesBarHtml([{ path: 'a.ts', added: 7, removed: 0, untracked: false }], labels);
  assert.match(onlyAdded, /\+\d*7|>\+7</);
  assert.doesNotMatch(onlyAdded, /diff-del/);

  const none = changesBarHtml([{ path: 'b.ts', added: 0, removed: 0, untracked: false }], labels);
  assert.doesNotMatch(none, /changes-bar-stat/);
});

test('新文件带角标（与「改动」面板同一个词）', () => {
  const html = changesBarHtml([{ path: 'new.md', added: 10, removed: 0, untracked: true }], labels);
  assert.match(html, /changes-bar-badge">新文件</);
});

test('路径整体转义：HTML 尖括号不会变成标签，标题里也不留原样', () => {
  const html = changesBarHtml([{ path: 'a/<script>.ts', added: 1, removed: 0, untracked: false }], labels);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  // title / aria-label 同样是转义后的字符串，不会提前闭合属性。
  assert.match(html, /title="查看 a\/&lt;script&gt;\.ts 的改动"/);
});

test('「全部改动」按钮带 data-changes-all（renderer 据此打开改动面板）', () => {
  const html = changesBarHtml([{ path: 'a.ts', added: 1, removed: 0, untracked: false }], labels);
  assert.match(html, /data-changes-all/);
  assert.match(html, /全部改动/);
});

test('空列表仍产出卡片骨架（调用方据此判空来决定是否显示该区域）', () => {
  const html = changesBarHtml([], labels);
  assert.match(html, /本轮改动 · 0 个文件/);
  assert.doesNotMatch(html, /data-change-path/);
});
