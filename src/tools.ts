import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import fg from 'fast-glob';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
}

const MAX_FILE_LINES = 2000;
const MAX_OUTPUT = 20000;
const MAX_RESULTS = 100;

const IGNORE = ['**/node_modules/**', '**/.git/**'];

// ---------- read_file ----------
const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取文件内容,返回带行号的文本。改代码前先读。可选 offset(起始行,1-based,默认1)和 limit(行数,默认2000)。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径,相对工作目录' },
      offset: { type: 'integer', description: '起始行号(1-based),默认1' },
      limit: { type: 'integer', description: '最大读取行数,默认2000' },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = String(args.path);
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? MAX_FILE_LINES);
    const data = await readFile(resolve(path), 'utf8');
    const lines = data.split(/\r?\n/);
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n');
    if (end < lines.length) {
      return body + `\n\n... (${lines.length - end} 行未显示,共 ${lines.length} 行)`;
    }
    return body || '(空文件)';
  },
};

// ---------- write_file ----------
const writeFileTool: Tool = {
  name: 'write_file',
  description: '创建或覆盖文件,自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const path = String(args.path);
    const content = String(args.content);
    const full = resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return `已写入 ${path} (${content.length} 字符)`;
  },
};

// ---------- edit_file ----------
const editFileTool: Tool = {
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

// ---------- run_command ----------
const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '执行 shell 命令,返回合并的 stdout+stderr。默认超时 120 秒。用于跑测试、构建、git 等。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令(单行)' },
      timeout: { type: 'integer', description: '超时毫秒,默认120000' },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = String(args.command);
    const timeout = Number(args.timeout ?? 120000);
    return new Promise<string>((done) => {
      const isWin = process.platform === 'win32';
      const child = spawn(
        isWin ? 'cmd.exe' : 'bash',
        isWin ? ['/c', command] : ['-c', command],
        { cwd: process.cwd() }
      );
      let out = '';
      let finished = false;
      const finish = (s: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done(s);
      };
      const onChunk = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (e) => finish(`执行失败: ${e.message}`));
      child.on('close', (code) => {
        let r = out.trim();
        if (out.length >= MAX_OUTPUT) r += '\n...(输出已截断)';
        finish(`[退出码 ${code}]\n${r || '(无输出)'}`);
      });
      const timer = setTimeout(() => {
        child.kill();
        finish(`[超时,已终止]\n${out.trim()}`);
      }, timeout);
    });
  },
};

// ---------- glob ----------
const globTool: Tool = {
  name: 'glob',
  description:
    '按 glob 模式查找文件路径(如 **/*.ts)。返回匹配列表(自动排除 node_modules / .git)。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式,如 **/*.ts 或 src/**/*.json' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const files = await fg(pattern, {
      cwd: process.cwd(),
      onlyFiles: true,
      dot: true,
      ignore: IGNORE,
    });
    if (files.length === 0) return '无匹配文件';
    const shown = files.slice(0, 200);
    let out = shown.join('\n');
    if (files.length > 200) out += `\n... (共 ${files.length} 个,仅显示前 200)`;
    return out;
  },
};

// ---------- grep ----------
const grepTool: Tool = {
  name: 'grep',
  description:
    '在文件内容里按正则搜索,返回 file:line: 匹配行。默认递归搜索当前目录(排除 node_modules/.git)。可选 glob 限定文件类型。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      glob: { type: 'string', description: '可选,限定文件 glob,如 *.ts' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const g = String(args.glob ?? '**/*');
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return `错误:非法正则 ${pattern}: ${e instanceof Error ? e.message : String(e)}`;
    }
    const files = await fg(g, {
      cwd: process.cwd(),
      onlyFiles: true,
      dot: true,
      ignore: IGNORE,
    });
    const results: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (results.length >= MAX_RESULTS) break;
      let content: string;
      try {
        content = await readFile(resolve(f), 'utf8');
      } catch {
        continue; // 跳过无法读的文件(二进制/权限)
      }
      scanned++;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${f}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= MAX_RESULTS) break;
        }
      }
    }
    if (results.length === 0) return `无匹配(扫描了 ${scanned} 个文件)`;
    let out = results.join('\n');
    if (results.length >= MAX_RESULTS) out += `\n...(结果达到 ${MAX_RESULTS} 条上限)`;
    return out;
  },
};

// ---------- 注册表与调度器 ----------
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  globTool,
  grepTool,
];

export async function executeTool(name: string, argsRaw: string): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `错误:未知工具 "${name}"`;
  let args: Record<string, unknown>;
  try {
    args = argsRaw.trim() ? JSON.parse(argsRaw) : {};
  } catch {
    return `错误:工具 ${name} 的 arguments 不是合法 JSON: ${argsRaw}`;
  }
  try {
    return await tool.execute(args);
  } catch (e) {
    return `错误:工具 ${name} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}
