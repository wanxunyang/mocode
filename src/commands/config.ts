import * as readline from 'node:readline';
import { CONFIG_PATH, readConfigFile, writeConfigKeys } from '../config/file.js';
import { guessMailHosts } from '../mail/providers.js';
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

  const apiKeyIn = await ask(rl, `LLM_API_KEY${cur.LLM_API_KEY ? t('config.keySet') : ''}: `);
  const apiKey = apiKeyIn || cur.LLM_API_KEY || '';
  if (!apiKey) {
    console.error(t('config.required', { key: 'LLM_API_KEY' }));
    rl.close();
    process.exit(1);
  }

  const modelIn = await ask(rl, `LLM_MODEL${cur.LLM_MODEL ? ` [${cur.LLM_MODEL}]` : ''}${t('config.modelDefault')}: `);
  const model = modelIn || cur.LLM_MODEL || 'gpt-4o-mini';

  // ── 可选:人工介入超时邮件通知(SMTP 发提醒 + IMAP 收回复)。回车跳过即不启用。──
  const mail = await collectMailConfig(rl, cur, ask);

  rl.close();

  // 合并:保留其它键,只覆盖向导管理的键。
  writeConfigKeys({
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: apiKey,
    LLM_MODEL: model,
    ...mail,
  });

  console.log(t('config.done', { path: CONFIG_PATH }));
}

/** 常见邮箱主机由 mail/providers.ts 统一维护(向导与 /mail setup 共用)。 */

/**
 * 询问邮件通知配置。返回待写入的键(值为 null 表示删除/不写)。
 * 已配置时显示现状;首个问题回车(空)表示跳过,保留既有配置不变。
 */
async function collectMailConfig(
  rl: readline.Interface,
  cur: Record<string, string>,
  ask: (rl: readline.Interface, q: string) => Promise<string>,
): Promise<Record<string, string | null>> {
  const already = !!(cur.MOCODE_MAIL_USER && cur.MOCODE_SMTP_HOST && cur.MOCODE_IMAP_HOST);
  const enableIn = await ask(
    rl,
    already ? `\n${t('config.mailEnabled')} ${t('config.mailEnablePrompt')}: ` : `\n${t('config.mailPrompt')}: `,
  );
  // 空回答:未配置→不启用(不写键);已配置→原样保留(不返回任何邮件键)。
  if (!enableIn) return {};
  const enable = /^(y|yes|是|1|true|on)$/i.test(enableIn);
  if (!enable) {
    // 显式关闭:写 MOCODE_MAIL_ENABLED=false,其余凭据保留在文件里不删。
    return { MOCODE_MAIL_ENABLED: 'false' };
  }

  const user =
    (await ask(rl, `${t('config.mailUser')}${cur.MOCODE_MAIL_USER ? ` [${cur.MOCODE_MAIL_USER}]` : ''}: `)) ||
    cur.MOCODE_MAIL_USER ||
    '';
  const preset = guessMailHosts(user);
  const defSmtp = cur.MOCODE_SMTP_HOST ?? preset?.smtp ?? '';
  const defImap = cur.MOCODE_IMAP_HOST ?? preset?.imap ?? '';

  const pass =
    (await ask(rl, `${t('config.mailPass')}${cur.MOCODE_MAIL_PASS ? t('config.keySet') : ''}: `)) ||
    cur.MOCODE_MAIL_PASS ||
    '';
  const smtpHost = (await ask(rl, `${t('config.mailSmtp')}${defSmtp ? ` [${defSmtp}]` : ''}: `)) || defSmtp;
  const imapHost = (await ask(rl, `${t('config.mailImap')}${defImap ? ` [${defImap}]` : ''}: `)) || defImap;

  if (!user || !pass || !smtpHost || !imapHost) {
    console.log(t('config.mailIncomplete'));
    return {};
  }

  return {
    MOCODE_MAIL_ENABLED: 'true',
    MOCODE_MAIL_USER: user,
    MOCODE_MAIL_PASS: pass,
    MOCODE_MAIL_TO: cur.MOCODE_MAIL_TO ?? user,
    MOCODE_SMTP_HOST: smtpHost,
    MOCODE_IMAP_HOST: imapHost,
    MOCODE_SMTP_PORT: cur.MOCODE_SMTP_PORT ?? '465',
    MOCODE_IMAP_PORT: cur.MOCODE_IMAP_PORT ?? '993',
  };
}
