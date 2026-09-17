/**
 * 浏览器侧 i18n 运行时。
 * - `t(key, vars)` 取当前语言的译文，支持 {name} 占位符注入。
 * - 语言状态持久化到 localStorage（与主题一致，首屏即时生效），并在切换时同步写回主进程（~/.mocode/config 的 MOCODE_LANGUAGE）。
 * - `onLangChange` 订阅语言变更；渲染层据此重绘画布 + 静态文案。
 * - `applyStaticI18n` 处理 index.html 里的 `data-i18n*` 静态标记。
 */
import {
  LOCALES,
  zhCN,
  DEFAULT_LANG,
  normalizeLang,
  type LocaleKey,
  type SupportedLang,
} from './locales.js';

// 渲染层只需要从这一个入口取 i18n 能力；把字典里的常量与类型一并转出去，
// 免得每个消费方都要同时 import './index.js' 和 './locales.js'。
export {
  LOCALES,
  LANG_NAMES,
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  normalizeLang,
  type LocaleKey,
  type SupportedLang,
} from './locales.js';

const LANG_KEY = 'mocode-work-language';

function readStoredLang(): SupportedLang {
  try {
    return normalizeLang(localStorage.getItem(LANG_KEY));
  } catch {
    return DEFAULT_LANG;
  }
}

let lang: SupportedLang = readStoredLang();
const subscribers = new Set<(lang: SupportedLang) => void>();

/** 当前语言。 */
export function getLang(): SupportedLang {
  return lang;
}

/** 翻译：`t('key', { name: 'x' })`。当前语言缺译时回退 zh-CN，再缺则回退 key 本身。 */
export function t(key: LocaleKey, vars?: Record<string, string | number>): string {
  const table = LOCALES[lang] ?? zhCN;
  let value: string = table[key] ?? zhCN[key] ?? (key as string);
  if (vars) {
    for (const [name, raw] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(raw));
    }
  }
  return value;
}

/** 订阅语言变更；返回取消订阅函数。 */
export function onLangChange(cb: (lang: SupportedLang) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * 设置语言：写 localStorage + 同步主进程配置（MOCODE_LANGUAGE），并通知所有订阅者。
 * 主进程桥接不可用时（如测试环境）静默降级到仅本地。
 */
export function setLang(next: SupportedLang): void {
  const resolved = normalizeLang(next);
  if (resolved === lang) return;
  lang = resolved;
  try {
    localStorage.setItem(LANG_KEY, resolved);
  } catch { /* 无 localStorage 则仅本次生效 */ }
  // 同步到 mocode 配置，使终端与其它界面保持一致；桥接缺失不阻断本地切换。
  try {
    const bridge = (window as unknown as { mocodeWork?: { setLanguage?: (l: string) => void } }).mocodeWork;
    bridge?.setLanguage?.(resolved);
  } catch { /* ignore */ }
  for (const cb of subscribers) cb(resolved);
}

/**
 * 从主进程下发的配置语言初始化。仅当本地没有显式偏好时采纳，
 * 否则以本地 localStorage 为准（用户可能在设置里临时切过）。
 * 真的换了语言就照常通知订阅者 —— 首屏是「冷启动 + 配置里写着 en-US」这条路径下
 * 唯一一次语言变更，不通知的话模块加载期缓存过的文案（状态行等）会停在默认语言。
 */
export function initLangFromConfig(configLang: string | null | undefined): void {
  const stored = (() => {
    try { return localStorage.getItem(LANG_KEY); } catch { return null; }
  })();
  if (stored) return;
  const resolved = normalizeLang(configLang);
  if (resolved === lang) return;
  lang = resolved;
  try { localStorage.setItem(LANG_KEY, resolved); } catch { /* ignore */ }
  for (const cb of subscribers) cb(resolved);
}

/** 把 index.html 中的 `data-i18n*` 标记刷成当前语言。可指定根节点局部刷新。 */
export function applyStaticI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as LocaleKey;
    if (el.hasAttribute('data-i18n-html')) el.innerHTML = t(key);
    else el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    if (el.dataset.i18nTitle) el.title = t(el.dataset.i18nTitle as LocaleKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    if (el.dataset.i18nAria) el.setAttribute('aria-label', t(el.dataset.i18nAria as LocaleKey));
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    if (el.dataset.i18nPlaceholder) (el as HTMLInputElement).placeholder = t(el.dataset.i18nPlaceholder as LocaleKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-value]').forEach((el) => {
    if (el.dataset.i18nValue) (el as HTMLInputElement).value = t(el.dataset.i18nValue as LocaleKey);
  });
}
