// 已知文件提示(短路径优化)的**确定性提取器**。
//
// 背景(eval trace 实测):任务文本里已点名目标文件时,弱指令遵循模型(flash/低思考档)
// 仍会先 grep/glob "确认位置",白烧一个完整模型往返;而把「直接读它」写进**任务文本**
// (近因位置)后模型立刻照做——系统提示中段的同义规则对它几乎无效。
//
// 因此这里只做机械提取 + 存在性过滤,不做语义判断:
//   1. 从用户文本里抓「看起来像文件」的 token(反引号包裹或裸词,带代码扩展名);
//   2. 按 cwd 解析并要求真实存在(误报如 "step 3."、"v1.2" 被扩展名白名单和存在性双双挡掉);
//   3. 去重、上限 5 个,空结果 = 零注入。
// 提示只说「这些文件已知,直接读」——不禁止探索,复杂任务不受影响。
import { existsSync } from 'node:fs';
import path from 'node:path';

const FILE_TOKEN_RE = /(?:`([^`\n]+)`|([\w./\\-]+))\.([A-Za-z][A-Za-z0-9]{0,7})/g;

const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'json',
  'md',
  'py',
  'go',
  'rs',
  'java',
  'rb',
  'php',
  'css',
  'scss',
  'html',
  'yaml',
  'yml',
  'toml',
  'sh',
  'sql',
  'vue',
  'svelte',
]);

const MAX_MENTIONED_FILES = 5;

export function buildMentionedFilesReminder(userText: string, cwd: string): string {
  const files = extractMentionedFiles(userText, cwd);
  if (files.length === 0) return '';
  return (
    `Files named in this request (verified present in the workspace): ${files.join(', ')} — ` +
    'read_file them directly as your first action; do not grep/glob to locate these files first.'
  );
}

export function extractMentionedFiles(userText: string, cwd: string): string[] {
  if (!userText) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of userText.matchAll(FILE_TOKEN_RE)) {
    const token = `${match[1] ?? match[2]}.${match[3]}`.replace(/\\/g, '/');
    if (token.length > 200 || seen.has(token)) continue;
    if (!CODE_EXTENSIONS.has(match[3].toLowerCase())) continue;
    const candidate = path.isAbsolute(token) ? token : path.resolve(cwd, token);
    if (!existsSync(candidate)) continue;
    seen.add(token);
    found.push(token);
    if (found.length >= MAX_MENTIONED_FILES) break;
  }
  return found;
}
