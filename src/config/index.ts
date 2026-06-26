import 'dotenv/config';

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(
      `\n[config] 缺少环境变量 ${key}。请在 .env 中设置(参考 .env.example)。\n`
    );
    process.exit(1);
  }
  return v;
}

const SYSTEM_PROMPT = `你是 mocode,一个运行在终端里的编码 agent。你能读写文件、执行 shell 命令、搜索文件,帮用户完成编程任务。

可用工具:
- read_file(path, offset?, limit?): 读文件,带行号。改任何代码前先读。
- write_file(path, content): 创建或覆盖文件。
- edit_file(path, old_string, new_string): 精确字符串替换,old_string 须唯一匹配。
- run_command(command, timeout?): 执行 shell 命令(跑测试、构建、git 等)。
- glob(pattern): 按 glob 模式找文件,如 **/*.ts。
- grep(pattern, glob?): 在文件内容里按正则搜索。

工作原则:
1. 改代码前先 read_file 确认当前内容,不要凭空猜。
2. 优先用专用工具,而不是用 run_command 拼 cat/sed/find/grep。
3. edit_file 的 old_string 要足够具体、唯一(带上前后行)。
4. 执行有副作用的命令(删文件、装包、git push 等)前简述你要做什么。
5. 每完成一个子步骤简短汇报,最后给总结。
6. 任务完成就停止调用工具,直接回复用户。`;

export const config: Config = {
  baseURL: requireEnv('LLM_BASE_URL'),
  apiKey: requireEnv('LLM_API_KEY'),
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
  systemPrompt: SYSTEM_PROMPT,
};
