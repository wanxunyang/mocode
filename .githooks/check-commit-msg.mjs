#!/usr/bin/env node
// 提交信息必须只含英文：出现 CJK 字符即拒绝。
//
// 规则来源：AGENTS.md「约定」里的 commit message 英文条款（万 2026-11-15 定的硬规则）。
// 只拦 CJK（中日韩文字与全角标点）：这类字符一定是"写成了中文"，而 em dash、弯引号
// 之类的英文排版符号不该被误伤。
//
// 临时绕过：git commit --no-verify。
import fs from 'node:fs';

const COMMENT = /^#/;
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

const file = process.argv[2];
if (!file) process.exit(0);

let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch {
  // 读不到就别拦：钩子的职责是风格，不是让提交莫名其妙失败。
  process.exit(0);
}

const lines = raw.split(/\r?\n/);
const offenders = [];
for (const [index, line] of lines.entries()) {
  if (COMMENT.test(line)) continue; // git 自己写的帮助注释不参与检查
  const hit = line.match(CJK);
  if (hit) offenders.push({ line: index + 1, ch: hit[0], text: line });
}

if (offenders.length === 0) process.exit(0);

const first = offenders[0];
process.stderr.write(
  [
    '',
    '  commit message must be in English (no CJK characters).',
    '',
    `  line ${first.line}: ${first.text.trim()}`,
    `  offending character: ${JSON.stringify(first.ch)}`,
    '',
    '  Rule: AGENTS.md §约定 — commit messages are English only.',
    '  The message subject and body both count; code comments and docs stay Chinese.',
    '',
    '  Bypass once with: git commit --no-verify',
    '',
    '',
  ].join('\n'),
);
process.exit(1);
