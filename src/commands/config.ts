import * as readline from 'node:readline';
import { CONFIG_PATH, readConfigFile, writeConfigKeys } from '../config/file.js';
import { detectLanguage, setLanguage, t } from '../i18n/index.js';

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(q, (ans) => resolve(ans.trim()));
  });
}

/**
 * 首跑配置向导:交互填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,写 ~/.mocode/config。
 * 只交互三键、保留文件里其它键(MAX_TOKENS / CONTEXT_WINDOW_TOKENS / MOCODE_THEME 等)。
 * prompt 全纯文本(readline 光标按字符算,不能含 ANSI)。
 * 由 index.ts 在 `mocode config` 时动态加载,故不 import config/index.ts(避免触发 config 单例初始化 / loadEnvFiles,
 * 直接退出);只 import config/file.ts(纯 I/O 叶子,无 env 校验 / process.exit)。
 */
export async function runConfigWizard(): Promise<void> {
  const cur = readConfigFile();
  setLanguage(detectLanguage(process.env.MOCODE_LANGUAGE ?? cur.MOCODE_LANGUAGE));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`${t('config.title', { path: CONFIG_PATH })}\n`);

  const baseURLIn = await ask(
    rl,
    `LLM_BASE_URL${cur.LLM_BASE_URL ? ` [${cur.LLM_BASE_URL}]` : ''}${t('config.example')}: `,
  );
  const baseURL = baseURLIn || cur.LLM_BASE_URL || '';
  if (!baseURL) {
    console.error(t('config.required', { key: 'LLM_BASE_URL' }));
    rl.close();
    process.exit(1);
  }

  const apiKeyIn = await ask(
    rl,
    `LLM_API_KEY${cur.LLM_API_KEY ? t('config.keySet') : ''}: `,
  );
  const apiKey = apiKeyIn || cur.LLM_API_KEY || '';
  if (!apiKey) {
    console.error(t('config.required', { key: 'LLM_API_KEY' }));
    rl.close();
    process.exit(1);
  }

  const modelIn = await ask(
    rl,
    `LLM_MODEL${cur.LLM_MODEL ? ` [${cur.LLM_MODEL}]` : ''}${t('config.modelDefault')}: `,
  );
  const model = modelIn || cur.LLM_MODEL || 'gpt-4o-mini';

  rl.close();

  // 合并:保留其它键,只覆盖三键。
  writeConfigKeys({
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: apiKey,
    LLM_MODEL: model,
  });

  console.log(t('config.done', { path: CONFIG_PATH }));
}
