/**
 * 统一 diff 的**并排两列**渲染。
 *
 * 回归背景：源代码管理面板以前把 `git diff` 原文整块塞进 `<pre>`，全篇同色 ——
 * 添加行和删除行只差首字符，扫一眼完全看不出改了什么，用户的原话是「相当于没有可视化」。
 * 后来改成单列行级渲染，但删除与新增上下相邻、中间还夹上下文行，只能逐字比对；
 * 现在改成左「原始」右「改动后」两列，同一处改动落在同一行的左右两半。
 *
 * 这组测试锁住五点：左右对齐（含行数不等时的空占位）、行号各自推进、红绿分类、
 * 元信息整行铺满、非 diff 输入不硬套颜色。
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

interface Cell {
  side: 'old' | 'new' | '';
  kind: 'add' | 'del' | 'ctx' | 'empty' | '';
  dup: boolean;
  no: string;
  gut: string;
}

interface Tr {
  cls: string;
  cells: Cell[];
  /** 整行铺满（colspan=2）的单元正文。 */
  full: string | null;
}

function parseRows(html: string): Tr[] {
  const out: Tr[] = [];
  for (const row of html.matchAll(/<tr class="udiff-row ([^"]*)">([\s\S]*?)<\/tr>/g)) {
    const cls = row[1]!;
    const inner = row[2]!;
    const cells: Cell[] = [];
    for (const cell of inner.matchAll(/<td class="udiff-side ([^"]*)">([\s\S]*?)<\/td>/g)) {
      const classes = cell[1]!.split(/\s+/).filter(Boolean);
      const body = cell[2]!;
      cells.push({
        side: (classes.find((name) => name === 'old' || name === 'new') ?? '') as Cell['side'],
        kind: (classes.find((name) => name === 'add' || name === 'del' || name === 'ctx' || name === 'empty') ??
          '') as Cell['kind'],
        dup: classes.includes('dup'),
        no: /<span class="ln">(\d*)<\/span>/.exec(body)?.[1] ?? '',
        gut: /<span class="gut">([^<]*)<\/span>/.exec(body)?.[1] ?? '',
      });
    }
    const full = /<td class="udiff-full"[^>]*><code>([\s\S]*?)<\/code><\/td>/.exec(inner);
    out.push({ cls, cells, full: full ? full[1]! : null });
  }
  return out;
}

const rowsOf = (html: string, cls: string): Tr[] => parseRows(html).filter((row) => row.cls.split(' ').includes(cls));
/** 取某一侧格子的 [kind, 行号, gutter]，用来断言「谁在哪半边」。 */
const sideOf = (row: Tr, side: 'old' | 'new'): [Cell['kind'], string, string] => {
  const cell = row.cells.find((item) => item.side === side);
  return [cell?.kind ?? '', cell?.no ?? '', cell?.gut ?? ''];
};

test('并排对齐：一处改动的删除在左、新增在右，落在同一行', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  const changed = rowsOf(html, 'change');
  // hunk 从 -3,+3 起：ctx 3 之后是 del 旧 4 / add 新 4、新 5。删 1 加 2 → 2 行对齐。
  assert.equal(changed.length, 2);
  assert.deepEqual(sideOf(changed[0]!, 'old'), ['del', '4', '-']);
  assert.deepEqual(sideOf(changed[0]!, 'new'), ['add', '4', '+']);
  // 第二行只有新增：左半边是空占位（不是把下一行上下文挤上来）。
  assert.deepEqual(sideOf(changed[1]!, 'old'), ['empty', '', '']);
  assert.deepEqual(sideOf(changed[1]!, 'new'), ['add', '5', '+']);
});

test('上下文行左右各带自己的行号，右侧标 dup（窄容器下 CSS 会隐藏它）', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  const ctx = rowsOf(html, 'ctx');
  assert.equal(ctx.length, 2);
  // del 只推进旧号、add 只推进新号 → 第二段上下文的旧 5 / 新 6。
  assert.deepEqual(sideOf(ctx[0]!, 'old'), ['ctx', '3', '']);
  assert.deepEqual(sideOf(ctx[0]!, 'new'), ['ctx', '3', '']);
  assert.deepEqual(sideOf(ctx[1]!, 'old'), ['ctx', '5', '']);
  assert.deepEqual(sideOf(ctx[1]!, 'new'), ['ctx', '6', '']);
  assert.equal(ctx[0]!.cells.find((cell) => cell.side === 'new')!.dup, true);
});

test('左右两侧是分开的 class（红绿底色由 CSS 按侧提供），且代码里不含 diff 前缀', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  assert.equal((html.match(/udiff-side old del/g) ?? []).length, 1);
  assert.equal((html.match(/udiff-side new add/g) ?? []).length, 2);
  assert.equal((html.match(/udiff-side old empty/g) ?? []).length, 1, '一条纯新增行要给左侧留空占位');
  // 前缀剥进 gutter，代码列只留正文 —— 否则会与 gutter 的 +/- 重复成「++」。
  assert.equal(/udiff-side (old del|new add)[\s\S]{0,220}?<code>[+-]/.test(html), false, '代码列不应残留 +/- 前缀');
  assert.ok(html.includes('= <span class="hl-n">3</span>'), html);
});

test('文件头 / hunk 头 / 元信息整行铺满（colspan=2），多文件 diff 才分得清边界', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  const rows = parseRows(html);
  assert.equal(rows.filter((row) => row.cls.includes('file')).length, 3, 'diff --git / --- / +++');
  assert.equal(rows.filter((row) => row.cls.includes('hunk')).length, 1);
  assert.equal(rows.filter((row) => row.cls.includes('meta')).length, 1, 'index 行进 meta');
  // 这三类都不该落进左右某一侧 —— 它们是整幅表宽的横带。
  for (const row of rows.filter((item) => item.full !== null)) assert.equal(row.cells.length, 0);
});

test('按文件后缀做语法高亮（同一份 diff 换文件时切换语言）', () => {
  const html = renderUnifiedDiff(SAMPLE);
  assert.ok(html);
  // .ts → typescript：const 是关键字。若解析不出路径会退化成纯文本，这里必须命中。
  assert.ok(html.includes('hl-k'), '应当带上高亮 token');
});

test('纯新增文件：每行都在右侧、左侧全是空占位，旧行号不出现', () => {
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
  const changed = rowsOf(html, 'change');
  assert.deepEqual(
    changed.map((row) => sideOf(row, 'new')),
    [
      ['add', '1', '+'],
      ['add', '2', '+'],
    ],
  );
  assert.deepEqual(
    changed.map((row) => sideOf(row, 'old')),
    [
      ['empty', '', ''],
      ['empty', '', ''],
    ],
  );
  assert.equal((html.match(/udiff-side old del/g) ?? []).length, 0);
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
  // 上限数的是「源 diff 的行数」：3 个文件头 + 1 个 hunk + 1996 增行。
  assert.equal((html.match(/udiff-side new add/g) ?? []).length, 1996);
  assert.equal(rowsOf(html, 'more').length, 1);
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
  assert.equal(rowsOf(html, 'file').length, 3, '只有 diff --git / --- / +++ 三行是文件头');
  const changed = rowsOf(html, 'change');
  assert.deepEqual(sideOf(changed[0]!, 'old'), ['del', '1', '-']);
  assert.deepEqual(sideOf(changed[0]!, 'new'), ['add', '1', '+']);
});

test('删多于加：多出来的删除行右侧留空占位，不把后续上下文挤上去', () => {
  const html = renderUnifiedDiff(
    [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,4 +1,2 @@',
      '-old one',
      '-old two',
      '-old three',
      '+new one',
      ' tail',
    ].join('\n'),
  );
  assert.ok(html);
  const changed = rowsOf(html, 'change');
  assert.equal(changed.length, 3);
  assert.deepEqual(
    changed.map((row) => sideOf(row, 'new')),
    [
      ['add', '1', '+'],
      ['empty', '', ''],
      ['empty', '', ''],
    ],
  );
  // 上下文行必须自己占一行（旧 4 / 新 2），而不是被塞进上面某个空占位。
  const ctx = rowsOf(html, 'ctx');
  assert.deepEqual(sideOf(ctx[0]!, 'old'), ['ctx', '4', '']);
  assert.deepEqual(sideOf(ctx[0]!, 'new'), ['ctx', '2', '']);
});

test('表头只在同时给了两侧文案时出现', () => {
  assert.equal(renderUnifiedDiff(SAMPLE, { oldSide: '原始' })?.includes('udiff-row head'), false);
  const html = renderUnifiedDiff(SAMPLE, { oldSide: '原始', newSide: '改动后' });
  assert.ok(html);
  assert.ok(html.includes('udiff-row head'));
  assert.ok(html.includes('原始'));
  assert.ok(html.includes('改动后'));
});
