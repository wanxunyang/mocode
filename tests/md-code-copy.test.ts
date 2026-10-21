// markdown 代码块「复制」按钮:渲染元数据(相对行/按钮列/原文)+ content 段命中查询。
//
// 不触盘、不读 stdin、不写剪贴板(复制动作在 layout 鼠标层,这里只验证纯函数与缓冲索引)。
// 测试形态:编译到 dist-tests/ 后 node --test。

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { renderMarkdown, renderMarkdownWithMeta } from '../src/ui/markdown.js';
import * as content from '../src/ui/content.js';
import { stripAnsi, displayWidth } from '../src/ui/render.js';
import { setLanguage, getLanguage, type Language } from '../src/i18n/index.js';

let savedLang: Language;
beforeEach(() => {
  savedLang = getLanguage();
  setLanguage('zh-CN');
});
afterEach(() => {
  content.reset();
  setLanguage(savedLang);
});

const fence = (lang: string, code: string): string => `\`\`\`${lang}\n${code}\n\`\`\``;

describe('renderMarkdownWithMeta 代码块元数据', () => {
  it('产出 header/代码相对行、复制按钮列区间与代码原文', () => {
    const md = fence('ts', 'const a = 1;\nconst b = 2;');
    const { lines, codeBlocks } = renderMarkdownWithMeta(md, 60);

    assert.equal(codeBlocks.length, 1);
    const block = codeBlocks[0];
    assert.equal(block.lang, 'ts');
    assert.equal(block.code, 'const a = 1;\nconst b = 2;');
    // header 行含语言名,且右侧出现「复制」按钮(剥 ANSI 后)
    const header = stripAnsi(lines[block.headerLine]);
    assert.match(header, /ts/);
    assert.match(header, /❐/);
    // 按钮(` ❐ `,宽 3)贴右端:结束列 == 视口列宽,区间半开 [start,end)
    assert.ok(block.buttonColStart >= 0);
    assert.equal(block.buttonColEnd - block.buttonColStart, 3);
    assert.equal(block.buttonColEnd, 60);
    assert.equal(displayWidth(header), 60);
    // 代码物理行紧随 header
    assert.equal(block.codeStartLine, block.headerLine + 1);
    assert.equal(block.codeEndLine, block.headerLine + 2);
    // 无语言块也保留 header(承载按钮)
    const noLang = renderMarkdownWithMeta(fence('', 'echo hi'), 40);
    assert.equal(noLang.codeBlocks.length, 1);
    assert.match(stripAnsi(noLang.lines[noLang.codeBlocks[0].headerLine]), /❐/);
    // 与旧 renderMarkdown 物理行一致
    assert.deepEqual(lines, renderMarkdown(md, 60));
  });

  it('窄窗放不下按钮时按钮列置 -1(不顶屏溢出)', () => {
    const md = fence('typescript', 'x');
    const { lines, codeBlocks } = renderMarkdownWithMeta(md, 8);
    const block = codeBlocks[0];
    for (const line of lines) assert.ok(displayWidth(stripAnsi(line)) <= 8);
    assert.equal(block.buttonColStart, -1);
    assert.equal(block.buttonColEnd, -1);
  });

  it('多个代码块各自记录相对行与原文', () => {
    const md = `${fence('js', 'a()')}\n\n正文\n\n${fence('py', 'b()')}`;
    const { codeBlocks } = renderMarkdownWithMeta(md, 50);
    assert.equal(codeBlocks.length, 2);
    assert.equal(codeBlocks[0].code, 'a()');
    assert.equal(codeBlocks[1].code, 'b()');
    assert.ok(codeBlocks[1].headerLine > codeBlocks[0].codeEndLine);
  });
});

describe('content 段代码块命中', () => {
  it('setLines 后按绝对行 + 按钮列命中复制并返回原文', () => {
    const md = fence('ts', 'const v = 42;');
    const { lines, codeBlocks } = renderMarkdownWithMeta(md, 60);
    content.beginSegment();
    content.setLines(lines, md, codeBlocks);
    content.commitSegment();

    const block = codeBlocks[0];
    // 命中按钮
    const hit = content.codeBlockCopyAt(block.headerLine, block.buttonColStart);
    assert.ok(hit);
    assert.equal(hit?.code, 'const v = 42;');
    assert.equal(hit?.headerAbs, block.headerLine);
    // 半开区间:最后一格命中,结束列本身不命中
    assert.ok(content.codeBlockCopyAt(block.headerLine, block.buttonColEnd - 1));
    assert.equal(content.codeBlockCopyAt(block.headerLine, block.buttonColEnd), null);
    // 点 header 左侧语言名 → 不命中按钮
    assert.equal(content.codeBlockCopyAt(block.headerLine, 2), null);
    // 点代码行 → 不命中按钮
    assert.equal(content.codeBlockCopyAt(block.codeStartLine, block.buttonColStart), null);
  });

  it('resize reflow 后按新列宽重新计算按钮位置', () => {
    const md = fence('ts', 'const v = 42;');
    content.beginSegment();
    content.setLines(renderMarkdown(md, 80), md, renderMarkdownWithMeta(md, 80).codeBlocks);
    content.commitSegment();

    content.reflowMarkdown(40, (src, cols) => renderMarkdownWithMeta(src, cols));
    const meta40 = renderMarkdownWithMeta(md, 40);
    const hit = content.codeBlockCopyAt(meta40.codeBlocks[0].headerLine, meta40.codeBlocks[0].buttonColStart);
    assert.ok(hit);
    assert.equal(hit?.code, 'const v = 42;');
  });
});

describe('围栏解析:一个复制区不得分裂成多个', () => {
  const blocksOf = (md: string) => renderMarkdownWithMeta(md, 60).codeBlocks;

  it('4 反引号外层包 3 反引号示例 → 1 个块,内层原样保留', () => {
    const md = '````md\n# T\n```ts\nconst a=1;\n```\nend\n````\n\n后文';
    const blocks = blocksOf(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, '# T\n```ts\nconst a=1;\n```\nend');
  });

  it('3 反引号外层包带语言的同类内层围栏 → 1 个块', () => {
    const md = '```md\n# T\n```ts\nconst a=1;\n```\nend\n```';
    const blocks = blocksOf(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, '# T\n```ts\nconst a=1;\n```\nend');
  });

  it('CRLF 换行也能识别围栏,原文不带 \\r', () => {
    const blocks = blocksOf('```ts\r\nconst a=1;\r\n```\r\n');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lang, 'ts');
    assert.equal(blocks[0].code, 'const a=1;');
  });

  it('列表项内缩进围栏:复制原文剥掉围栏缩进', () => {
    const blocks = blocksOf('1. step\n   ```bash\n   npm i\n   ```\n2. next');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, 'npm i');
  });

  it('代码内部空行不拆块', () => {
    const blocks = blocksOf('```ts\na\n\n\nb\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, 'a\n\n\nb');
  });

  it('流式未闭合围栏仍是 1 个块;补全闭合后块数不变', () => {
    assert.equal(blocksOf('```ts\na\nb').length, 1);
    assert.equal(blocksOf('```ts\na\nb\n``').length, 1);
    assert.equal(blocksOf('```ts\na\nb\n```').length, 1);
  });

  it('真正相邻的两个代码块仍是 2 个', () => {
    const blocks = blocksOf('```a\n1\n```\n\n```b\n2\n```');
    assert.equal(blocks.length, 2);
    assert.deepEqual(
      blocks.map((b) => b.code),
      ['1', '2'],
    );
  });
});
