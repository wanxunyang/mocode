/**
 * 主进程侧 i18n 助手。主进程里任何会触达用户的中文提示都应改用 `tMain`，
 * 这样语言切换后 host 启动失败、模型切换等系统消息也能随之本地化。
 * 语言来源：调用方显式传入 > process.env.MOCODE_LANGUAGE（由 ~/.mocode/config 注入）。
 */
import { LOCALES, zhCN, normalizeLang, type LocaleKey } from './locales.js';

export function tMain(key: LocaleKey, vars?: Record<string, string | number>, langInput?: string): string {
  const lang = normalizeLang(langInput ?? process.env.MOCODE_LANGUAGE);
  const table = LOCALES[lang] ?? zhCN;
  let value: string = table[key] ?? zhCN[key] ?? (key as string);
  if (vars) {
    for (const [name, raw] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(raw));
    }
  }
  return value;
}
