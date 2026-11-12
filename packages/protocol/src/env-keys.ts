/**
 * 用户级配置键清单 —— 「哪些 env 键允许从配置文件回填进进程环境」的单一事实源。
 *
 * 为什么需要这份清单：work-app（Electron GUI）没有 shell 环境，可配置项只能来自
 * ~/.mocode/config 与 <项目>/.mocode/config 的回填。它此前自己维护了一份 30 键白名单，
 * 而 core 实际读取 106 个 env 键——差集里全是用户级开关
 * （MOCODE_COMPUTER_USE_ENABLED、MOCODE_FRONTEND_TOOLS_ENABLED、MOCODE_MEMORY_PROACTIVE、
 * MOCODE_REQUEST_MAX_KB、MOCODE_ROUTER_*、MOCODE_CU_*、HTTP(S)_PROXY…）：
 * 写进配置文件也不生效，而且**没有任何提示**。
 *
 * 为什么仍然保留白名单、而不是「不过滤、全部回填」：
 *   ① 一个 work-app 进程服务多个项目空间，项目 A 的 .env 键会漏到项目 B 的 host 里；
 *   ② 任意 .env 键（DATABASE_URL 之类）会被 run_command 的子进程继承。
 * 所以策略是**完备的显式白名单**：`tests/config/env-keys.test.ts` 扫描 src/ 里所有
 * process.env 读取点，出现清单外的新键就红——靠测试防漂移，不靠人记。
 *
 * 消费方：packages/work-app 的 loadMocodeConfig（回填过滤器）。
 */

/**
 * 进程/宿主内部键：由运行时自己设置，配置文件里写了也**不**回填
 * （回填会让「受监管 Worker」「测试不派生子进程」这类语义被磁盘配置篡改）。
 */
export const INTERNAL_ENV_KEYS: readonly string[] = [
  'PATH',
  'LOCALAPPDATA',
  'DEBUG',
  'MOCODE_SUPERVISED_WORKER',
  'MOCODE_WORKER_ID',
  'MOCODE_NO_SPAWN',
];

/** 可由 ~/.mocode/config、项目 .mocode/config 或 .env 提供的用户级键。 */
export const USER_CONFIG_ENV_KEYS: readonly string[] = [
  // ── 模型与请求 ──
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_STREAM_USAGE',
  'CONTEXT_WINDOW_TOKENS',
  'MAX_TOKENS',
  'MAX_STEPS',
  'ANTHROPIC_PROMPT_CACHE',
  'ANTHROPIC_VERSION',
  'REASONING_EFFORT',
  'SANDBOX_ROOT',
  'MOCODE_SHELL',
  'MOCODE_MODE',
  'MOCODE_TOOL_POLICY',
  'MOCODE_PERSONA',
  'MOCODE_KEEPALIVE_MS',
  'MOCODE_RG_PATH',
  'MOCODE_NO_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  // ── 上下文与压缩 ──
  'AUTO_COMPACT',
  'MOCODE_CONTEXT_OPTIMIZE',
  'MOCODE_CONTEXT_RELPRUNE',
  'MOCODE_LIFECYCLE',
  'MOCODE_BUDGET_SCHEDULER',
  'MOCODE_LOW_PRESSURE_RATIO',
  'MOCODE_MAX_COMPACTED_BYTES',
  'MOCODE_COMPACT_FORK',
  'MOCODE_REQUEST_MAX_KB',
  'MOCODE_REQUEST_LIMIT_CACHE',
  'MOCODE_TOKEN_CALIBRATION_CACHE',
  'MOCODE_TOOL_CLEARING',
  'MOCODE_READ_DEDUP',
  'MOCODE_MAX_SNAPSHOT_TURNS',
  'MOCODE_ROLLBACK_CACHE_MB',
  // ── 记忆 ──
  'MEMORY_ENABLED',
  'AUTO_REFLECT',
  'REFLECT_EVERY_N',
  'MOCODE_REFLECT_MAX_PER_SESSION',
  'MOCODE_MEMORY_PROACTIVE',
  'MOCODE_MEMORY_TURN_RECALL',
  'MOCODE_MEMORY_EPISODIC',
  'MOCODE_MEMORY_CONSOLIDATE',
  'MOCODE_MEMORY_COMPACT_HANDOFF',
  'MOCODE_CONSOLIDATE_MAX_PER_SESSION',
  'MOCODE_RECALL_MS',
  'MOCODE_EXIT_REFLECT_WAIT_MS',
  'MOCODE_AUTO_GC',
  // ── 工具与门控 ──
  'MOCODE_SUBAGENT_ENABLED',
  'SUB_AGENT_MAX_STEPS',
  'SUB_AGENT_MAX_DEPTH',
  'SUB_AGENT_CONCURRENCY',
  'MOCODE_COMPUTER_USE_ENABLED',
  'MOCODE_FRONTEND_TOOLS_ENABLED',
  'MOCODE_BROWSER_ALLOW_REMOTE',
  'MOCODE_CU_VISION_KEEP',
  'MOCODE_CU_VISION_BATCH',
  'MOCODE_CU_MAX_EDGE',
  'MOCODE_CU_DIFF_THRESHOLD',
  'MOCODE_FLOW_TRACE',
  'MOCODE_IMAGE_AGE_TURNS',
  'MOCODE_MAX_IMAGE_BYTES',
  'MOCODE_WEB_FETCH_PROXY',
  'SKILLS_DIRS',
  'ANYSEARCH_API_KEY',
  'ANYSEARCH_BASE_URL',
  // ── 工具路由 ──
  'MOCODE_ROUTER_ENABLED',
  'MOCODE_ROUTER_MODE',
  'MOCODE_ROUTER_CONFIDENCE_MIN',
  'MOCODE_ROUTER_CONFIDENCE_MIN_MCP',
  'MOCODE_ROUTER_JEV_BASE_URL',
  'MOCODE_ROUTER_JEV_API_KEY',
  'MOCODE_ROUTER_JEV_MODEL',
  // ── 权限与审批 ──
  'MOCODE_PERMISSION',
  'MOCODE_PERMISSION_NON_INTERACTIVE_ALLOW',
  'MOCODE_CONFIRM_SEND',
  'MOCODE_APPROVAL_TIMEOUT_MS',
  // ── MCP ──
  'MCP_CONFIG_PATH',
  'MCP_SERVERS',
  'MOCODE_MCP_ENABLED',
  // ── 后台任务 / 调度 / 编排 ──
  'MOCODE_JOB_MAX_MS',
  'MOCODE_JOB_MAX_TOKENS',
  'MOCODE_SUPERVISE_NO_MINIMIZE',
  'MOCODE_SUPERVISE_NO_TERMINAL',
  'MOCODE_MAX_TRACE_BYTES',
  // ── 界面 / 通知 / 邮件 ──
  'MOCODE_THEME',
  'MOCODE_LANGUAGE',
  'MOCODE_CATALOG_TTL_HOURS',
  'MOCODE_PET_PORT',
  'MOCODE_NOTIFY_WEBHOOK',
  'MOCODE_NOTIFY_CHAT_ID',
  'MOCODE_MAIL_ENABLED',
  'MOCODE_MAIL_USER',
  'MOCODE_MAIL_PASS',
  'MOCODE_MAIL_TO',
  'MOCODE_SMTP_HOST',
  'MOCODE_SMTP_SECURE',
  'MOCODE_IMAP_HOST',
  'MOCODE_IMAP_SECURE',
];

/** 白名单全集（用户级 + 内部键），供「src 里出现的键是否已被归类」的自检使用。 */
export const ALL_KNOWN_ENV_KEYS: readonly string[] = [...USER_CONFIG_ENV_KEYS, ...INTERNAL_ENV_KEYS];

/** 该键是否允许从配置文件回填（消费方过滤器用；O(1) 查表由调用方自建）。 */
export function isUserConfigEnvKey(key: string): boolean {
  return USER_CONFIG_ENV_KEYS.includes(key);
}