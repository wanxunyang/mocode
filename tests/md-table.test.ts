// markdown 表格:emoji 宽度对齐 + 单元格内 `\|` / 反引号内 `|` 不拆列。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../src/ui/markdown.js';
import { charWidth, displayWidth, stripAnsi } from '../src/ui/render.js';

const plain = (md: string, cols = 60): string[] => renderMarkdown(md, cols).map(stripAnsi);

describe('markdown 表格', () => {
  it('常见 emoji 按 2 格计宽,文本呈现符号仍为 1 格', () => {
    for (const cp of [0x2705, 0x274c, 0x2b50, 0x2728, 0x2753]) assert.equal(charWidth(cp), 2, cp.toString(16));
    for (const cp of [0x2714, 0x26a0]) assert.equal(charWidth(cp), 1, cp.toString(16));
  });

  it('含 emoji 的表格所有行显示宽度一致', () => {
    const lines = plain('| 项 | 状态 |\n|---|---|\n| 构建 | ✅ 通过 |\n| 测试 | ❌ 失败 |');
    const widths = new Set(lines.filter((l) => l.length > 0).map((l) => displayWidth(l)));
    assert.equal(widths.size, 1, [...widths].join(','));
  });

  it('`\\|` 与反引号内的 | 留在同一单元格,不多出列', () => {
    const lines = plain('| 写法 | 说明 |\n|---|---|\n| `a \\| b` | 管道符 |\n| `ls | grep x` | 管道 |');
    const widths = new Set(lines.filter((l) => l.length > 0).map((l) => displayWidth(l)));
    assert.equal(widths.size, 1);
    const top = lines[0];
    assert.equal(top.split('┬').length, 2, '应只有 2 列');
    assert.ok(lines.some((l) => l.includes('a | b')));
    assert.ok(lines.some((l) => l.includes('ls | grep x')));
  });

  it('分隔行列数少于表头(模型常见写法)仍渲染成表格,所有行等宽', () => {
    const lines = plain(
      '| 名称 | 类型 | 说明 |\n|------|------|\n| alpha | string | 第一个字段 |\n| beta | number | 第二个字段 |',
    );
    assert.ok(lines[0].startsWith('┌'), lines[0]);
    assert.equal(lines[0].split('┬').length, 3, '应保留表头的 3 列');
    const widths = new Set(lines.filter((l) => l.length > 0).map((l) => displayWidth(l)));
    assert.equal(widths.size, 1, [...widths].join(','));
    assert.ok(lines.some((l) => l.includes('第二个字段')));
  });

  it('分隔行列数多于表头:以表头列数为准', () => {
    const lines = plain('| A | B |\n|---|---|---|\n| 1 | 2 |');
    assert.ok(lines[0].startsWith('┌'));
    assert.equal(lines[0].split('┬').length, 2);
  });

  it('单列表格、紧凑写法、单独 `:` 对齐格都能渲染', () => {
    assert.ok(plain('| 唯一的列 |\n|------|\n| 第一行 |')[0].startsWith('┌'));
    assert.ok(plain('|名称|类型|说明|\n|-|-|-|\n|alpha|string|第一个字段|')[0].startsWith('┌'));
    assert.ok(plain('| 左对齐 | 居中 | 右对齐 |\n|:------|:|------:|\n| a | b | 1 |')[0].startsWith('┌'));
  });

  it('非法分隔行仍是普通文本;不带 | 的 --- 不误判为表格', () => {
    assert.ok(!plain('| A | B |\n| ~ | == |\n| 1 | 2 |')[0].startsWith('┌'));
    assert.ok(!plain('标题 | 说明\n---\n正文')[0].startsWith('┌'));
  });

  it('分隔行漏写竖线导致粘连(--:----:)仍渲染成表格', () => {
    const lines = plain('| a | b | c |\n| -- | --:----: | ---: |\n| 1 | 2 | 3 |');
    assert.ok(lines[0].startsWith('┌'), lines.join('\n'));
    assert.equal(lines[0].split('┬').length, 3);
  });

  it('缺/多单元格的行不破坏表格', () => {
    const lines = plain('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| 4 |');
    const widths = new Set(lines.filter((l) => l.length > 0).map((l) => displayWidth(l)));
    assert.equal(widths.size, 1);
  });

  it('无分隔行 / 非法分隔行的竖线行逐行显示,不糊成一行', () => {
    const g3 = plain('| A | B |\n| 1 | 2 |\n| 3 | 4 |');
    assert.deepEqual(g3, ['| A | B |', '| 1 | 2 |', '| 3 | 4 |']);
    const g4 = plain('| A | B |\n| ~ | == |\n| 1 | 2 |');
    assert.deepEqual(g4, ['| A | B |', '| ~ | == |', '| 1 | 2 |']);
  });

  it('引用块里的表格渲染成表格,每行带 │ 前缀且不超宽', () => {
    const cols = 40;
    const lines = plain('> | 引用 A | 引用 B |\n> | ------ | ------ |\n> | 1 | 2 |\n> | 3 | 4 |', cols);
    assert.ok(lines[0].includes('┌'), lines.join('\n'));
    assert.ok(
      lines.every((l) => l.includes('│')),
      lines.join('\n'),
    );
    assert.ok(lines.some((l) => l.includes('├')));
    assert.ok(lines.some((l) => l.includes('└')));
    assert.ok(lines.every((l) => displayWidth(l) <= cols));
    assert.ok(lines.some((l) => l.includes('引用 A')) && lines.some((l) => l.includes('3')));
  });

  it('后随 U+FE0F 的窄符号按 2 格计(⚠️ ✔️ ❤️),裸符号仍 1 格', () => {
    assert.equal(displayWidth('\u26a0\ufe0f'), 2);
    assert.equal(displayWidth('\u2714\ufe0f'), 2);
    assert.equal(displayWidth('\u2764\ufe0f'), 2);
    assert.equal(displayWidth('\u26a0'), 1);
    assert.equal(displayWidth('\u2705\ufe0f'), 2, '本身已是 2 格的不叠加');
  });

  it('ZWJ 序列 / 区域旗帜 / 肤色修饰符各算一个字形(2 格),不逐码点累加', () => {
    assert.equal(displayWidth('\u{1F468}\u200D\u{1F4BB}'), 2, '👨‍💻');
    assert.equal(displayWidth('\u{1F469}\u200D\u{1F467}'), 2, '👩‍👧');
    assert.equal(displayWidth('\u{1F1E8}\u{1F1F3}'), 2, '🇨🇳');
    assert.equal(displayWidth('\u{1F44D}\u{1F3FD}'), 2, '👍🏽');
    assert.equal(displayWidth('\u0031\ufe0f\u20e3'), 2, '1️⃣');
    assert.equal(displayWidth('\u{1F44D}'), 2, '裸 emoji 不变');
  });

  it('含 ZWJ / 旗帜 / 肤色 emoji 的表格所有行等宽', () => {
    const lines = plain(
      '| 写法 | 含义 |\n|---|---|\n| 👨\u200D💻 | ZWJ 组合 |\n| 👩\u200D👧 | 家庭 |\n| 🇨🇳 | 区域旗帜 |\n| 👍🏽 | 肤色修饰 |',
    );
    const widths = new Set(lines.filter((l) => l.length > 0).map((l) => displayWidth(l)));
    assert.equal(widths.size, 1, [...widths].join(','));
  });

  it('含 ⚠️ 的表格所有行等宽', () => {
    const lines = plain('| 特性 | 方案 C |\n|---|:-:|\n| emoji | ⚠️ |\n| CJK | ✅ |\n| 窄终端 | ⚠️ |');
    const widths = new Set(lines.filter((l) => l.length > 0).map((l) => displayWidth(l)));
    assert.equal(widths.size, 1, [...widths].join(','));
  });

  it('引用块里表格前后的普通引用行保持原样', () => {
    const lines = plain('> 前言\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n> 结语');
    assert.ok(lines[0].includes('前言'));
    assert.ok(lines.some((l) => l.includes('┌')));
    assert.ok(lines[lines.length - 1].includes('结语'));
  });
});
