/**
 * AGENTS.md 注入瘦身(方案A)单测:filterAgentsSectionsForInjection 纯函数。
 * 覆盖:目录结构/扩展点压缩成指针行、英文标题变体、其余章节逐字保留、
 * preamble/H3 子层不受影响、无章节文件原样返回、草稿指引随 buildAgentsImportSection 注入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAgentsSectionsForInjection } from '../src/config/index.js';

test('filterAgentsSections: 中文「目录结构/扩展点」整段压缩成一行指针,其余章节逐字保留', () => {
  const md = [
    '# AGENTS.md — mocode 项目记忆',
    '',
    '## 项目',
    'mocode:终端 TUI 编码 agent。',
    '',
    '## 命令',
    '- 安装:`npm install`',
    '',
    '## 目录结构',
    '- `src/index.ts`:CLI 入口',
    '- `src/agent/`:agent 循环',
    '',
    '## 约定',
    '- 纯 ESM,import 带 .js。',
    '',
    '## 扩展点',
    '- 加内置工具:builtins/ 新建文件。',
  ].join('\n');

  const out = filterAgentsSectionsForInjection(md);

  // 两章节整段被压缩,正文不再出现
  assert.ok(!out.includes('CLI 入口'), '目录结构正文应被剔除');
  assert.ok(!out.includes('agent 循环'), '目录结构正文应被剔除');
  assert.ok(!out.includes('builtins/ 新建文件'), '扩展点正文应被剔除');
  // 指针行出现两次
  assert.equal((out.match(/\(not injected — read_file AGENTS\.md on demand\)/g) ?? []).length, 2);
  // 常驻章节逐字保留
  assert.ok(out.includes('# AGENTS.md — mocode 项目记忆'));
  assert.ok(out.includes('## 项目'));
  assert.ok(out.includes('mocode:终端 TUI 编码 agent。'));
  assert.ok(out.includes('- 安装:`npm install`'));
  assert.ok(out.includes('## 约定'));
  assert.ok(out.includes('纯 ESM,import 带 .js。'));
});

test('filterAgentsSections: 英文标题变体(Directory Structure / Extension Points / Project Layout)同样压缩', () => {
  const md = [
    '# Project',
    '',
    '## Project Layout',
    'src/ contains everything.',
    '',
    '## Commands',
    '- `npm run build`',
    '',
    '## Extension points',
    'Add tools in builtins/.',
    '',
    '## Directory Structure',
    '- src/tools: tool registry',
  ].join('\n');
  const out = filterAgentsSectionsForInjection(md);
  assert.ok(!out.includes('src/ contains everything.'));
  assert.ok(!out.includes('Add tools in builtins/.'));
  assert.ok(!out.includes('tool registry'));
  assert.ok(out.includes('## Commands'));
  assert.ok(out.includes('- `npm run build`'));
  assert.equal((out.match(/\(not injected — read_file AGENTS\.md on demand\)/g) ?? []).length, 3);
});

test('filterAgentsSections: 无章节/无命中文件原样返回(仅空白规整)', () => {
  const plain = 'just some facts\nno headings at all';
  assert.equal(filterAgentsSectionsForInjection(plain), plain);

  const noIndexed = ['## 项目', '内容', '', '## 约定', '内容2'].join('\n');
  assert.equal(filterAgentsSectionsForInjection(noIndexed), noIndexed.trim());
});

test('filterAgentsSections: 压缩段后续章节终止索引,连续多段不被连坐', () => {
  const md = [
    '## 目录结构',
    '- 目录A',
    '## 命令',
    '- `npm test`',
    '## 扩展点',
    '- 接缝B',
    '## 约定',
    '- 约定C',
  ].join('\n');
  const out = filterAgentsSectionsForInjection(md);
  assert.ok(!out.includes('目录A'));
  assert.ok(!out.includes('接缝B'));
  assert.ok(out.includes('## 命令'));
  assert.ok(out.includes('- `npm test`'));
  assert.ok(out.includes('## 约定'));
  assert.ok(out.includes('- 约定C'));
});

test('filterAgentsSections: H3 深层标题不触发/不中断索引状态', () => {
  const md = ['## 目录结构', '### 子目录', '- 内容X', '## 约定', '- 约定Y'].join('\n');
  const out = filterAgentsSectionsForInjection(md);
  assert.ok(!out.includes('内容X'));
  assert.ok(!out.includes('### 子目录'));
  assert.ok(out.includes('- 约定Y'));
});

test('filterAgentsSections: 标题带编号或后缀(目录结构(monorepo))同样命中', () => {
  const md = ['## 目录结构(monorepo)', '- 内容Z', '## 项目', '项目内容'].join('\n');
  const out = filterAgentsSectionsForInjection(md);
  assert.ok(!out.includes('内容Z'));
  assert.ok(out.includes('项目内容'));
  assert.ok(out.includes('目录结构(monorepo): (not injected'));
});
