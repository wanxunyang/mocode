import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../types.js';

// ---------- edit_file ----------
export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Make a precise string replacement in a file. old_string must occur exactly once in the file and match exactly (including indentation/newlines). Use write_file for new files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'The original text to be replaced; must match exactly' },
      new_string: { type: 'string', description: 'The new text to replace it with' },
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
