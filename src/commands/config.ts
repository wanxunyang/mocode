import * as readline from 'node:readline';
import { CONFIG_PATH, readConfigFile, writeConfigKeys } from '../config/file.js';

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(q, (ans) => resolve(ans.trim()));
  });
}

/**
 * 首跑配置向导:交互填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,写 ~/.mocode/config。
 * 只交互三键、保留文件里其它键(MAX_TOKENS / CONTEXT_WINDOW_TOKENS / MOCODE_THEME 等)。
 * prompt 全纯文本(readline 光标按字符算,不能含 ANSI)。
 * 由 index.ts 在 `mocode config` 时动态加载,故不 import config/index.ts(避免缺配置时 requireEnv
 * 直接退出);只 import config/file.ts(纯 I/O 叶子,无 env 校验 / process.exit)。
 */
export async function runConfigWizard(): Promise<void> {
  const cur = readConfigFile();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`mocode 配置向导 — 写入 ${CONFIG_PATH}(Ctrl+C 取消)\n`);

  const baseURLIn = await ask(
    rl,
    `LLM_BASE_URL${cur.LLM_BASE_URL ? ` [${cur.LLM_BASE_URL}]` : ''}(如 https://open.bigmodel.cn/api/v3): `,
  );
  const baseURL = baseURLIn || cur.LLM_BASE_URL || '';
  if (!baseURL) {
    console.error('\n[config] LLM_BASE_URL 不能为空,已取消。');
    rl.close();
    process.exit(1);
  }

  const apiKeyIn = await ask(
    rl,
    `LLM_API_KEY${cur.LLM_API_KEY ? ' [已设置,回车保留]' : ''}: `,
  );
  const apiKey = apiKeyIn || cur.LLM_API_KEY || '';
  if (!apiKey) {
    console.error('\n[config] LLM_API_KEY 不能为空,已取消。');
    rl.close();
    process.exit(1);
  }

  const modelIn = await ask(
    rl,
    `LLM_MODEL${cur.LLM_MODEL ? ` [${cur.LLM_MODEL}]` : ''}(回车默认 gpt-4o-mini): `,
  );
  const model = modelIn || cur.LLM_MODEL || 'gpt-4o-mini';

  rl.close();

  // 合并:保留其它键,只覆盖三键。
  writeConfigKeys({
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: apiKey,
    LLM_MODEL: model,
  });

  console.log(`\n已写入 ${CONFIG_PATH}。现在运行 \`mocode\` 即可启动(任意目录、任意终端)。`);
}
