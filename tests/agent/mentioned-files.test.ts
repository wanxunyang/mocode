/**
 * 已知名文件提示(短路径优化)的确定性提取器单测。
 *
 * 关键边界:
 *  - 存在性过滤是硬门槛:任务文本提到的文件必须真实存在于 cwd 下才注入;
 *  - 扩展名白名单挡掉 "step 3." / "v1.2" 这类数字尾巴误报;
 *  - 反引号包裹的路径(可能含目录)与裸文件名都支持;
 *  - 上限 5 个,空结果零注入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMentionedFilesReminder, extractMentionedFiles } from '../../src/agent/mentioned-files.js';

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mocode-mentioned-files-'));
  writeFileSync(path.join(root, 'config.js'), 'export const X = 1;\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'util.ts'), 'export const Y = 2;\n');
  return root;
}

test('任务文本点名的存在文件被提取并生成提醒', () => {
  const root = workspace();
  const files = extractMentionedFiles('config.js 里 MAX_RETRIES 是字符串,请修复。', root);
  assert.deepEqual(files, ['config.js']);
  const reminder = buildMentionedFilesReminder('config.js 里 MAX_RETRIES 是字符串,请修复。', root);
  assert.match(reminder, /config\.js/);
  assert.match(reminder, /read_file/);
});

test('不存在的文件不注入(存在性过滤)', () => {
  const root = workspace();
  assert.deepEqual(extractMentionedFiles('settings.js 里的值不对。', root), []);
  assert.equal(buildMentionedFilesReminder('settings.js 里的值不对。', root), '');
});

test('数字尾巴与非法扩展名被排除', () => {
  const root = workspace();
  assert.deepEqual(extractMentionedFiles('先看 step 3. 再看 v1.2 的说明。', root), []);
});

test('反引号包裹的带目录路径命中', () => {
  const root = workspace();
  assert.deepEqual(extractMentionedFiles('请看 `src/util.ts` 里的导出。', root), ['src/util.ts']);
});

test('多个文件去重且上限 5 个', () => {
  const root = workspace();
  for (let i = 1; i <= 7; i++) writeFileSync(path.join(root, `mod${i}.ts`), 'export {}\n');
  const text = 'mod1.ts mod2.ts mod3.ts mod4.ts mod5.ts mod6.ts mod7.ts 都要改。';
  const files = extractMentionedFiles(text, root);
  assert.equal(files.length, 5);
  assert.equal(new Set(files).size, 5);
});

test('空文本零注入', () => {
  const root = workspace();
  assert.deepEqual(extractMentionedFiles('', root), []);
  assert.equal(buildMentionedFilesReminder('', root), '');
});
