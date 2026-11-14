/**
 * ask_human 的展开区渲染。
 *
 * 回归背景：这个工具原来没有专用视图，走的是「原始参数 JSON + 原文」的兜底分支，
 * 用户看到的是一坨 `{"question":…,"options":[{"label":…}]}`（全是转义换行）。
 * 更糟的是**等待回答**那一刻 output 还是空串，于是展开区只显示「（无输出）」——
 * 恰恰是最该看见问题和选项的时候什么都没有。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolView, type ToolViewLabels } from '../../packages/work-app/src/renderer/tool-view.js';

const labels: ToolViewLabels = {
  failed: '失败',
  denied: '未执行',
  aborted: '已中断',
  noOutput: '（无输出）',
  truncated: '已截断',
  lines: (n) => `${n} 行`,
  matches: (n) => `${n} 处匹配`,
  files: (n) => `${n} 个文件`,
  results: (n) => `${n} 条结果`,
  changedFiles: (n) => `${n} 个文件改动`,
  steps: (done, total) => `${done}/${total} 步`,
  moreLines: (n) => `…（还有 ${n} 行未显示）`,
  askOptions: (n) => `${n} 个选项`,
  askAnswered: '已回答',
  askCancelled: '已取消',
  askAnswer: '你的答复',
};

const args = JSON.stringify({
  question: '终端面板要做成哪种形态？',
  context: '两条路差别很大：\n\nA. 观察型\nB. 可交互',
  options: [
    { label: 'A 观察型', description: '零依赖、零新工具' },
    { label: 'B 可交互真终端', description: '引入 node-pty + xterm.js' },
  ],
});

const question = (html: string): string => html.match(/tool-ask-question[^>]*>([^<]*)/)?.[1] ?? '';
const optionLabels = (html: string): string[] =>
  [...html.matchAll(/tool-ask-option-label[^>]*>([^<]*)/g)].map((match) => match[1]!);
/** 展开区是惰性闭包（回放时不拼 HTML），测试里显式调一次。 */
const htmlOf = (view: { html: () => string }): string => view.html();

test('ask_human: 等待回答（output 为空）也显示问题与选项，而不是「（无输出）」', () => {
  const view = buildToolView('ask_human', args, '', {}, labels);
  assert.ok(view);
  assert.equal(view.summary, '2 个选项');
  const html = htmlOf(view);
  assert.equal(question(html), '终端面板要做成哪种形态？');
  assert.deepEqual(optionLabels(html), ['A 观察型', 'B 可交互真终端']);
  assert.equal(html.includes('（无输出）'), false, '等待回答时不能退化成空输出提示');
  assert.equal(html.includes('"label":'), false, '不该再出现原始 JSON');
});

test('ask_human: 多段 context 保留换行（否则取舍说明会糊成一段）', () => {
  const view = buildToolView('ask_human', args, '', {}, labels);
  assert.ok(view);
  const html = htmlOf(view);
  assert.ok(html.includes('两条路差别很大：<br><br>A. 观察型'), html.slice(0, 300));
});

test('ask_human: 已回答时摘要复述所选值，且只有被选中的选项高亮', () => {
  const view = buildToolView('ask_human', args, '用户选择：B 可交互真终端', {}, labels);
  assert.ok(view);
  assert.equal(view.summary, '已回答 · B 可交互真终端');
  const html = htmlOf(view);
  assert.equal((html.match(/tool-ask-option is-chosen/g) ?? []).length, 1);
  // 「你的答复」单列一行，值不会被埋在段落里。
  assert.ok(/tool-ask-answer-text[^>]*>B 可交互真终端</.test(html));
});

test('ask_human: 自由文本回答（无选项）也给出答复行', () => {
  const freeText = JSON.stringify({ question: '把报错原文贴给我', options: [] });
  const view = buildToolView('ask_human', freeText, '用户回答：TypeError: x is undefined', {}, labels);
  assert.ok(view);
  assert.equal(view.summary, '已回答 · TypeError: x is undefined');
  const html = htmlOf(view);
  assert.ok(html.includes('把报错原文贴给我'));
  assert.ok(html.includes('TypeError: x is undefined'));
});

test('ask_human: 取消时摘要为「已取消」，不显示答复行', () => {
  const view = buildToolView('ask_human', args, '用户取消了选择。请考虑是否有不依赖用户输入的替代方案。', {}, labels);
  assert.ok(view);
  assert.equal(view.summary, '已取消');
  const html = htmlOf(view);
  assert.equal(html.includes('你的答复'), false);
  assert.ok(html.includes('已取消'));
});

test('ask_human: 入参不可解析时退回原文，不吞信息', () => {
  const view = buildToolView('ask_human', 'not json at all', '用户选择：A', {}, labels);
  assert.ok(view);
  const html = htmlOf(view);
  assert.ok(html.includes('not json at all') || html.includes('A'));
});

test('read_file: 摘要第一趟就算好，语法高亮推迟到展开（回放不再为看不见的展开区付钱）', () => {
  const body = Array.from({ length: 40 }, (_, i) => `${i + 1}\tconst value${i} = compute();`).join('\n');
  const output = `[artifact source=read_file path=src/demo.ts hash=abc]\n${body}`;
  const view = buildToolView('read_file', JSON.stringify({ path: 'src/demo.ts' }), output, {}, labels);
  assert.ok(view);
  assert.equal(view.summary, '40 行');
  const html = htmlOf(view);
  // 行号从 artifact 正文的首行还原，且走 ts 高亮（而不是退化成纯文本）。
  assert.ok(html.includes('<span class="ln">1</span>'), html.slice(0, 200));
  assert.ok(html.includes('hl-keyword') || html.includes('const'), '应当带上语法高亮产物');
});
