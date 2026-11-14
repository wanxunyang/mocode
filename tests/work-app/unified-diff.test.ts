/**
 * 统一 diff 的行级渲染。
 *
 * 回归背景：源代码管理面板以前把 `git diff` 原文整块塞进 `<pre>`，全篇同色 ——
 * 添加行和删除行只差首字符，扫一眼完全看不出改了什么，用户的原话是「相当于没有可视化」。
 * 这组测试锁住三点：行号追踪（旧/新两列各自推进）、红绿底色分类、非 diff 输入不硬套颜色。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderUnifiedDiff } from '../../packages/work-app/src/renderer/unified-diff.js';

/** 一份最典型的两处改动：1 行删、2 行加，中间有上下文。 */
const SAMPLE = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -3,6 +3,7 @@ export function run() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a + b;',
  '',
].join('\n');

/** 取某一类行的 [旧行号, 新行号, gutter]。 */
function rowsOf(html: string, kind: string): string[][] {
  return [
    ...html.matchAll(
      new RegExp(
        `<div class="udiff-row ${kind}"><span class="ln">(\\d*)</span><span class="ln">(\\d*)</span><span class="gut">([^<]*)</span>`,
        'g',
      ),
    ),
  ].map((match) => [match[1]!, match[2]!, match[3]!]);
}

test('删除行只有旧行号，添加行只有新行号（两列各自推进，一眼看出插在哪）', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  // hunk 从 -3,6 +3,7 起：ctx 占第 3 行，del 是旧 4，add 是新 4、新 5。
  assert.deepEqual(rowsOf(html, 'del'), [['4', '', '-']]);
  assert.deepEqual(rowsOf(html, 'add'), [
    ['', '4', '+'],
    ['', '5', '+'],
  ]);
  // 上下文行两列都有号（旧 5 新 6 —— del 只推进旧号，add 只推进新号）。
  assert.deepEqual(rowsOf(html, 'ctx'), [
    ['3', '3', ''],
    ['5', '6', ''],
  ]);
});

test('添加行与删除行是不同 class（底色分开由 CSS 提供），且代码里不含 diff 前缀', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  assert.equal((html.match(/udiff-row add/g) ?? []).length, 2);
  assert.equal((html.match(/udiff-row del/g) ?? []).length, 1);
  // 前缀剥进 gutter，代码列只留正文 —— 否则会与 gutter 的 +/- 重复成「++」。
  // 只看增删行：文件头 `+++ b/...` 本来就该原样显示。
  assert.equal(/udiff-row (add|del)[\s\S]{0,200}?<code>[+-]/.test(html), false, '代码列不应残留 +/- 前缀');
  assert.ok(html.includes('= <span class="hl-n">3</span>'), html);
});

test('文件头与 hunk 头单独成行（多文件 diff 才分得清边界）', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  assert.equal((html.match(/udiff-row file/g) ?? []).length, 3, 'diff --git / --- / +++');
  assert.equal((html.match(/udiff-row hunk/g) ?? []).length, 1);
  assert.equal((html.match(/udiff-row meta/g) ?? []).length, 1, 'index 行进 meta');
});

test('按文件后缀做语法高亮（同一份 diff 换文件时切换语言）', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  // .ts → typescript：const 是关键字。若解析不出路径会退化成纯文本，这里必须命中。
  assert.ok(html.includes('hl-k'), '应当带上高亮 token');
});

test('纯新增文件：每行都有新行号，旧行号列留空', () => {
  const html = renderUnifiedDiff(
    [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+第一行',
      '+第二行',
    ].join('\n'),
  );
  assert.ok(html);
  assert.deepEqual(rowsOf(html, 'add'), [
    ['', '1', '+'],
    ['', '2', '+'],
  ]);
  assert.equal((html.match(/udiff-row del/g) ?? []).length, 0);
});

test('解析不出 hunk 的文本返回 null（二进制 / 冲突提示不该被硬套红绿）', () => {
  assert.equal(renderUnifiedDiff('Binary files a/x.png and b/x.png differ'), null);
  assert.equal(renderUnifiedDiff('Unresolved merge conflict.'), null);
  assert.equal(renderUnifiedDiff(''), null);
  assert.equal(renderUnifiedDiff('   '), null);
});

test('超出行数上限时给尾注，而不是静默截断', () => {
  const lines = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', '@@ -0,0 +1,2500 @@'];
  for (let i = 0; i < 2500; i++) lines.push(`+line ${i}`);
  const html = renderUnifiedDiff(lines.join('\n'), { moreLines: (n) => `…还有 ${n} 行` });
  assert.ok(html);
  assert.ok(html.includes('还有 504 行'), '2504 行总数 - 2000 上限 = 504');
  // 上限数的是「渲染出的行」，文件头 4 行占额度，所以 add 行是 2000 - 4。
  assert.equal((html.match(/udiff-row add/g) ?? []).length, 1996);
});

test('HTML 转义：diff 内容里的尖括号不能被当成标签', () => {
  const html = renderUnifiedDiff(['@@ -1,1 +1,1 @@', '-const a = <T>();', '+const a = <U>();'].join('\n'));
  assert.ok(html);
  assert.equal(html.includes('<T>'), false);
  assert.ok(html.includes('&lt;T&gt;') || html.includes('&lt;'), html);
});

test('hunk 内部的 `--- x` / `+++ x` 内容行仍是增删行，不被当成文件头', () => {
  // 删掉一行 SQL 注释 `-- note` 在 diff 里就是 `--- note`；若按前缀盲判，这行会变成
  // 灰底文件头，红绿高亮直接丢失。只有 hunk 之前的 `--- ` / `+++ ` 才是路径行。
  const html = renderUnifiedDiff(
    [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- old comment',
      '+++ new comment',
      ' SELECT 1;',
    ].join('\n'),
  );
  assert.ok(html);
  assert.equal((html.match(/udiff-row file/g) ?? []).length, 3, '只有 diff --git / --- / +++ 三行是文件头');
  assert.deepEqual(rowsOf(html, 'del'), [['1', '', '-']]);
  assert.deepEqual(rowsOf(html, 'add'), [['', '1', '+']]);
});
