import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../types.js';

// ---------- edit_file ----------
export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '对文件做精确字符串替换。old_string 必须在文件中唯一出现且完全匹配(含缩进/换行)。新建文件请用 write_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: '要被替换的原文,须精确匹配' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args) {
    const path = String(args.path);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    const full = resolve(path);
    const data = await readFile(full, 'utf8');
    const count = data.split(oldStr).length - 1;
    if (count === 0) {
      return `错误:在 ${path} 中未找到 old_string。请先 read_file 确认实际内容。`;
    }
    if (count > 1) {
      return `错误:old_string 在 ${path} 中出现 ${count} 次,不唯一。请加入更多上下文使其唯一。`;
    }
    // 用函数形式替换,避免 new_string 里的 $ 被当特殊模式
    const updated = data.replace(oldStr, () => newStr);
    await writeFile(full, updated, 'utf8');
    return `已在 ${path} 中完成 1 处替换。`;
  },
};
