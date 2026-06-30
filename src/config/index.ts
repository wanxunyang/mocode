import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * 按优先级加载配置文件并回填 process.env:
 *   候选(文件内升序、后者覆盖前者):~/.mocode/config(全局)→ <cwd>/.mocode/config → <cwd>/.env(兼容旧用法)。
 *   合并后只回填 process.env 里**尚未设置**的键——shell 里 export 的环境变量永远优先。
 * 故 `mocode` 可在任意目录 / 任意终端启动:全局配置(~/.mocode/config)兜底,项目级文件按需覆盖。
 */
function loadEnvFiles(): void {
  const candidates = [
    path.join(os.homedir(), '.mocode', 'config'),
    path.join(process.cwd(), '.mocode', 'config'),
    path.join(process.cwd(), '.env'),
  ];
  const fromFiles: Record<string, string> = {};
  for (const p of candidates) {
    try {
      Object.assign(fromFiles, dotenv.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      // 文件不存在或不可读:跳过
    }
  }
  for (const [k, v] of Object.entries(fromFiles)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFiles();

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
  /** 后台反思 pass 总开关。关掉则只靠手动 /reflect + 机会主义 memory_update。 */
  autoReflect: boolean;
  /** 每 N 个轮次触发一次后台反思 pass(与 agent 并发,不阻塞)。默认 5。 */
  reflectEveryN: number;
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
      `\n[config] 缺少 ${key}。运行 \`mocode config\` 初始化,或在 ~/.mocode/config / <cwd>/.env 中设置(参考 .env.example)。\n`
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
- 若当前目录存在 .codegraph/(已建代码索引),理解/定位代码、查调用链、看改动影响面时必须先 codegraph 再动手:run_command 跑 codegraph explore "<符号或问题>"(一次拿相关符号源码 + 调用路径)或 codegraph node <符号或文件>(单符号源码 + 调用者)。不要逐文件 glob/read_file/grep 去拼凑理解——那是 codegraph 已替你做完的事。仅当 codegraph 找不到、未索引、要看刚改的最新内容、或改单个已知小文件时才用 read_file/grep/glob。详见 use_skill codegraph。
- run_command 按平台执行(Win 用 cmd、其他用 bash);有副作用的命令(删文件、装包、git push、重置等)执行前先简述意图。
- 需要训练数据之外的最新信息(新版本、新闻、实时数据、最新 API)时用 web_search 联网搜索,不要凭记忆答可能过时的内容。
- 要读取某个具体 URL 的内容(搜索结果里的链接、用户给的 URL)时用 web_fetch 抓取;它只抓静态 HTML,JS 渲染页面拿不到正文时改用 web_search(其结果自带清洗后的正文)。
- 遇到需要用户决策的岔路(多种实现方案、不确定用户意图、需要额外信息才能继续),调 ask_human 列出选项让用户选(用户也可选"自定义输入"自由作答)。不要在任务明确、能自行决定时频繁打扰用户;用户取消后换方案或基于已有信息推进,不原地重复问。

## 失败处理
- 工具以字符串返回错误(edit_file 未匹配或不唯一、run_command 非零退出码等)。先分析根因,调整后重试,不要原样重发同一条调用。
- 命令报错时把真实输出读进去再判断,别跳过。

## 安全与边界
- 不可逆或外向操作(删除、覆盖既有文件、推送、请求外部服务)执行前向用户确认,除非已获明确授权。
- 只在授权范围内操作;不确定就问,别猜。

## 记忆(跨会话长期事实)
- 系统提示已注入「记忆索引」(仅 id/标题/摘要)。需要某条正文时调 memory_search(传 id 或关键词)取;memory_list 看全部索引。
- 遇到非显然、跨会话有用的事实/决策/坑(架构约定、易踩坑、用户偏好、已做决策),用 memory_save 存——只存长期稳定项,不存当前 bug / 临时文件 / 未决 TODO。
- 发现已存记忆过时或与新事实矛盾,用 memory_update(id, …) 原地纠正(别新建重复条);明确失效的用 memory_forget(id) 归档。
- 存前先 memory_search 看是否已有同类条,避免重复。宁可少记,不记正确废话。
- 后台反思 pass 会定期从会话里挖掘并整理记忆(无需你手动),但你主动存的关键事实更可靠。

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
  autoReflect: process.env.AUTO_REFLECT !== 'false',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  sessionDir: path.join(process.cwd(), '.mocode', 'sessions'),
  searchApiKey: process.env.ANYSEARCH_API_KEY,
  searchBaseUrl: process.env.ANYSEARCH_BASE_URL || 'https://api.anysearch.com',
};
