import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyWrittenFile } from '../../verification/postconditions.js';
import type { Tool } from '../types.js';

// ---------- edit_file ----------
export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace a string in a file. old_string must occur exactly once and match exactly (including indentation/newlines). Copy old_string verbatim from a fresh read_file result for this path; do not reconstruct it from memory or summaries. Use write_file for new files.',
  risk: 'confirm',
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

    // 行尾归一化:read_file 用 split(/\r?\n/) 输出纯 LF,LLM 据此构造的 old_string/new_string
    // 也是 LF;但本工具原样读文件(CRLF 保留),直接精确匹配会在 CRLF 文件上必败(文件 \r\n 对不上
    // old_string 的 \n)。故匹配/计数在归一化(LF)文本上做,写回时按文件原始行尾风格还原,
    // 不把 CRLF 文件悄悄换成 LF(只含 LF 的纯 LF 文件 norm===data,行为完全不变)。
    const norm = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normOld = oldStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normNew = newStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const count = norm.split(normOld).length - 1;
    if (count === 0) {
      return `错误:在 ${path} 中未找到 old_string。不要重试相同参数；请先 read_file 读取目标区域，再从返回内容逐字复制新的 old_string 后重试。`;
    }
    if (count > 1) {
      return `错误:old_string 在 ${path} 中出现 ${count} 次,不唯一。请加入更多上下文使其唯一。`;
    }
    // 用函数形式替换,避免 new_string 里的 $ 被当特殊模式
    const updated = norm.replace(normOld, () => normNew);

    // 检测原始行尾风格,写回时还原(存在 \r\n 即视为 CRLF 文件;纯 LF 文件保持 LF)
    const out = data.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
    await writeFile(full, out, 'utf8');
    const postcondition = await verifyWrittenFile(full, out);
    if (postcondition.status === 'failed') {
      return {
        status: 'error',
        code: 'POSTCONDITION_FAILED',
        retryable: true,
        output: postcondition.diagnostics
          .map((item) => `[${item.code ?? 'V0_FAILED'}] ${item.file ?? path}: ${item.message}`)
          .join('\n'),
      };
    }
    return `已在 ${path} 中完成 1 处替换 (sha256=${postcondition.actualHash})。`;
  },
};
