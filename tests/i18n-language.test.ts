/**
 * i18n 语言解析单测。
 *
 * 背景:默认语言曾由系统 locale 决定(中文 Windows → zh-CN),导致新装用户一开就是中文界面;
 * locale 无法识别时更是硬编码兜底 zh-CN。现在改为**只认显式配置**:
 *   - MOCODE_LANGUAGE / ~/.mocode/config 的值(经 detectLanguage 归一)优先;
 *   - 未配置或值无法识别(如 fr-FR、C.UTF-8、空串)→ DEFAULT_LANGUAGE(en);
 *   - 系统 locale 完全不再参与判定(本文件用 zh_CN 环境变量锁死这条不变量)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LANGUAGE, detectLanguage, getLanguage, normalizeLanguage, setLanguage, t } from '../src/i18n/index.js';

test('DEFAULT_LANGUAGE 为 en(新装用户默认英文界面)', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
});

test('detectLanguage: 未配置 / 空值 / 无法识别时落 en', () => {
  assert.equal(detectLanguage(), 'en');
  assert.equal(detectLanguage(undefined), 'en');
  assert.equal(detectLanguage(null), 'en');
  assert.equal(detectLanguage(''), 'en');
  assert.equal(detectLanguage('   '), 'en');
  assert.equal(detectLanguage('fr-FR'), 'en'); // 非中英 → 落默认值,不再兜底 zh-CN
  assert.equal(detectLanguage('C.UTF-8'), 'en');
});

test('detectLanguage: 不再读取系统 locale(zh_CN 环境下仍为 en)', () => {
  const saved = { LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG };
  process.env.LC_ALL = 'zh_CN.UTF-8';
  process.env.LC_MESSAGES = 'zh_CN.UTF-8';
  process.env.LANG = 'zh_CN.UTF-8';
  try {
    assert.equal(detectLanguage(), 'en');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('detectLanguage: 显式配置归一(zh / zh-* → zh-CN,en / en-* → en)', () => {
  assert.equal(detectLanguage('zh-CN'), 'zh-CN');
  assert.equal(detectLanguage('zh'), 'zh-CN');
  assert.equal(detectLanguage('zh_TW'), 'zh-CN');
  assert.equal(detectLanguage('en'), 'en');
  assert.equal(detectLanguage('en-US'), 'en');
  assert.equal(detectLanguage('  EN  '), 'en'); // 大小写 / 空白容错
});

test('normalizeLanguage: 只认中英,其余返回 null', () => {
  assert.equal(normalizeLanguage('ja-JP'), null);
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(undefined), null);
});

test('setLanguage 后 UI 文案同步切换(回复语言不进提示词,由模型按用户提问自动识别)', () => {
  try {
    setLanguage('en');
    assert.equal(getLanguage(), 'en');
    assert.equal(t('language.changed'), 'Language switched to English.');

    setLanguage('zh-CN');
    assert.equal(getLanguage(), 'zh-CN');
    assert.equal(t('language.changed'), '语言已切换为中文。');
  } finally {
    setLanguage(DEFAULT_LANGUAGE);
  }
});

test('t: 两种语言字典 key 齐备(zh-CN 与 en 均命中,不回退)', () => {
  const keys = ['common.none', 'commands.language', 'welcome.gettingStarted', 'permission.allow'] as const;
  for (const lang of ['en', 'zh-CN'] as const) {
    setLanguage(lang);
    for (const key of keys) {
      const value = t(key);
      assert.ok(value.length > 0, `${lang} 缺 key: ${key}`);
      assert.ok(!value.includes('{'), `${key} 参数未被替换: ${value}`);
    }
  }
  setLanguage(DEFAULT_LANGUAGE);
});
