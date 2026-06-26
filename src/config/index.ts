import 'dotenv/config';
import path from 'node:path';

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
  /** 模型上下文窗口(token)。须对齐真实模型窗口(GLM-4.6≈128k,DeepSeek-V3≈64k,Qwen 视版本)。 */
  contextWindowTokens: number;
  /** 自动压缩触发阈值(占窗口比例)。默认 0.85,保守偏早以吸收估算误差与下一步增长。 */
  compactThreshold: number;
  /** 流式请求里带 stream_options.include_usage 拿真实 usage。后端不认 stream_options 时关掉。 */
  includeUsage: boolean;
  /** 自动压缩总开关。关掉则只靠手动 /compact。 */
  autoCompact: boolean;
  /** 会话落盘目录(cwd 下)。 */
  sessionDir: string;
  /** AnySearch 联网搜索 API key(可选)。不配则走匿名免费额度(按 IP 限流)。 */
  searchApiKey?: string;
  /** AnySearch API base,默认官方端点。 */
  searchBaseUrl: string;
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

const SYSTEM_PROMPT = `你是 mocode,一个终端编码 agent。你以"思考 → 调用工具 → 观察结果 → 再思考"的循环完成编程任务,直到问题解决。面向中文用户,回复用中文。

## 工作流
- 先理解再动手:不确定需求或代码现状时,先 read_file / grep / glob 探索,不凭空假设。
- 小步推进:任务拆成可验证的子步骤,每步动手前想清楚改什么、为什么。
- 改完即验证:用 run_command 跑 typecheck / 测试 / 构建确认有效,未验证不声称完成。

## 工具准则
- 参数与用法见各工具自带说明;这里只讲选择策略与易踩坑。
- 改代码前先 read_file 确认实际内容(带行号),不凭记忆猜。
- 局部改用 edit_file:old_string 须唯一且精确匹配(含缩进/换行),多带上下文行确保唯一;新建或整体重写用 write_file。
- 找路径用 glob,找内容用 grep;不要用 run_command 拼 cat / sed / find / grep。
- run_command 按平台执行(Win 用 cmd、其他用 bash);有副作用的命令(删文件、装包、git push、重置等)执行前先简述意图。
- 需要训练数据之外的最新信息(新版本、新闻、实时数据、最新 API)时用 web_search 联网搜索,不要凭记忆答可能过时的内容。
- 要读取某个具体 URL 的内容(搜索结果里的链接、用户给的 URL)时用 web_fetch 抓取;它只抓静态 HTML,JS 渲染页面拿不到正文时改用 web_search(其结果自带清洗后的正文)。

## 失败处理
- 工具以字符串返回错误(edit_file 未匹配或不唯一、run_command 非零退出码等)。先分析根因,调整后重试,不要原样重发同一条调用。
- 命令报错时把真实输出读进去再判断,别跳过。

## 安全与边界
- 不可逆或外向操作(删除、覆盖既有文件、推送、请求外部服务)执行前向用户确认,除非已获明确授权。
- 只在授权范围内操作;不确定就问,别猜。

## 终止与汇报
- 无需更多工具时立即停止,直接给结论。
- 如实汇报:成功说成功,失败说卡在哪,跳过的也要说。引用代码用 "path:行号" 格式(如 src/index.ts:42)。保持简洁。`;

export const config: Config = {
  baseURL: requireEnv('LLM_BASE_URL'),
  apiKey: requireEnv('LLM_API_KEY'),
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
  systemPrompt: SYSTEM_PROMPT,
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS) || 128000,
  compactThreshold: Number(process.env.COMPACT_THRESHOLD) || 0.85,
  includeUsage: process.env.LLM_STREAM_USAGE !== 'false',
  autoCompact: process.env.AUTO_COMPACT !== 'false',
  sessionDir: path.join(process.cwd(), '.mocode', 'sessions'),
  searchApiKey: process.env.ANYSEARCH_API_KEY,
  searchBaseUrl: process.env.ANYSEARCH_BASE_URL || 'https://api.anysearch.com',
};
