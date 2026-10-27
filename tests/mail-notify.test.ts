/**
 * 邮件远程介入的纯函数契约:
 *  - parseReply:从回复邮件主题/正文解析介入 id 与选项序号 / 自由文本;
 *  - normalizedOptions:InterventionRequest 选项归一;
 *  - extractAddress:发件人地址提取(白名单比对用);
 *  - getMailConfig:必填缺失即未启用,MOCODE_MAIL_ENABLED=false 显式关闭。
 * 不连真实 SMTP/IMAP(网络层为动态 import,本文件不触发)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReply,
  normalizedOptions,
  optionPairs,
  firstReplyLine,
  extractAddress,
  getMailConfig,
  resetMailConfigCache,
  buildSubject,
  buildBody,
  MAIL_SUBJECT_PREFIX,
} from '../src/mail/index.js';
import { guessMailHosts } from '../src/mail/providers.js';
import type { InterventionRequest } from '../src/ui/intervention.js';

const choiceReq: InterventionRequest = {
  type: 'choice',
  title: 'q',
  options: ['允许一次', { label: '拒绝' }, { label: '本次会话允许' }],
};
const inputReq: InterventionRequest = { type: 'input', title: 'q' };

test('normalizedOptions: 字符串与对象混合、空白项被滤除', () => {
  assert.deepEqual(normalizedOptions(choiceReq), ['允许一次', '拒绝', '本次会话允许']);
  assert.deepEqual(normalizedOptions(inputReq), []);
  assert.deepEqual(normalizedOptions({ type: 'choice', title: 'x', options: ['a', '  ', { label: 'b' }] }), ['a', 'b']);
});

test('optionPairs: 保留每个选项的 detail 供邮件正文展示', () => {
  const req: InterventionRequest = {
    type: 'choice',
    title: 'q',
    options: [{ label: '允许', detail: '放行本次命令' }, { label: '拒绝' }, '纯字符串'],
  };
  assert.deepEqual(optionPairs(req), [
    { label: '允许', detail: '放行本次命令' },
    { label: '拒绝' },
    { label: '纯字符串' },
  ]);
});

test('buildBody: 选项详情逐行列出,用户不看终端也能凭邮件取舍', () => {
  const cfg = {
    enabled: true,
    idleMs: 1,
    pollMs: 1,
    smtpHost: 's',
    smtpPort: 465,
    smtpSecure: true,
    imapHost: 'i',
    imapPort: 993,
    imapSecure: true,
    user: 'a@example.com',
    pass: 'x',
    to: 'a@example.com',
  };
  const req: InterventionRequest = {
    type: 'choice',
    title: '是否删除?',
    detail: '影响 3 个文件',
    options: [
      { label: '允许', detail: '放行本次删除' },
      { label: '拒绝', detail: '中止操作' },
    ],
  };
  const body = buildBody(cfg, { id: 'ABCD1234', req });
  assert.match(body, /1\. 允许/);
  assert.match(body, /放行本次删除/);
  assert.match(body, /2\. 拒绝/);
  assert.match(body, /中止操作/);
  assert.match(body, /影响 3 个文件/);
});

test('firstReplyLine: 跳过引用/邮件头/签名分隔,取用户真正写的首行', () => {
  const body = ['>', '> 在 2026-10-26,you@163.com 写道:', '> 原问题', '', '2', '一些补充说明'].join('\n');
  assert.equal(firstReplyLine(body), '2');
  // 行首残留 > 也去掉
  assert.equal(firstReplyLine('> 1\n'), '1');
  // 纯引用没有真实内容 → 空串
  assert.equal(firstReplyLine('> 原邮件\n> 发件人: x'), '');
});

test('buildSubject: 前缀 + 8 位 id + 单行标题', () => {
  const s = buildSubject('A1B2C3D4', '多行\n标题');
  assert.ok(s.startsWith(`${MAIL_SUBJECT_PREFIX} A1B2C3D4 `));
  assert.ok(!s.includes('\n'));
});

test('parseReply: 主题带 id + 正文首行数字 → choice', () => {
  const r = parseReply(`${MAIL_SUBJECT_PREFIX} A1B2C3D4 问题`, '2\n多余解释', 3);
  assert.deepEqual(r, { id: 'A1B2C3D4', kind: 'choice', option: 2, text: '' });
});

test('parseReply: 引用前缀 ">" 与 "Re:" 噪声下仍识别数字', () => {
  const r = parseReply(`${MAIL_SUBJECT_PREFIX} a1b2c3d4 q`, '> > 1', 3);
  assert.equal(r?.id, 'A1B2C3D4'); // 小写归一
  assert.equal(r?.kind, 'choice');
  assert.equal(r?.option, 1);
});

test('parseReply: 主题缺 id 时从正文 "介入编号: XXXX" 回退', () => {
  const r = parseReply('回复: 随便的主题', '好的\n介入编号: DEADBEEF\n继续', 0);
  assert.equal(r?.id, 'DEADBEEF');
  assert.equal(r?.kind, 'text');
  assert.equal(r?.text, '好的');
});

test('parseReply: input 类无选项时取正文首行为自由文本', () => {
  const r = parseReply(`${MAIL_SUBJECT_PREFIX} 00112233 q`, '这是我的答复', 0);
  assert.deepEqual(r, { id: '00112233', kind: 'text', option: 0, text: '这是我的答复' });
});

test('parseReply: choice 越界数字 → 仍返回 id(交给路由判定无效),不伪造合法选项', () => {
  const r = parseReply(`${MAIL_SUBJECT_PREFIX} 00112233 q`, '9', 2);
  assert.equal(r?.id, '00112233');
  assert.equal(r?.kind, 'choice');
  assert.equal(r?.option, 9);
});

test('parseReply: 完全无 id → null', () => {
  assert.equal(parseReply('普通邮件', '1', 3), null);
});

test('extractAddress: 从 Name <a@b> 与裸地址取邮箱', () => {
  assert.equal(extractAddress('Foo <foo@example.com>'), 'foo@example.com');
  assert.equal(extractAddress('foo@example.com'), 'foo@example.com');
});

test('guessMailHosts: 常见邮箱后缀推导 SMTP/IMAP,未知域名返 undefined', () => {
  assert.deepEqual(guessMailHosts('user@gmail.com'), { smtp: 'smtp.gmail.com', imap: 'imap.gmail.com' });
  assert.deepEqual(guessMailHosts('user@qq.com'), { smtp: 'smtp.qq.com', imap: 'imap.qq.com' });
  assert.equal(guessMailHosts('user@example.org'), undefined);
});

test('getMailConfig: 必填缺失 → null(未启用)', () => {
  resetMailConfigCache();
  // 共享进程:只增删本用例触碰的键,绝不整体替换 process.env(会污染并发跑的其它测试文件)。
  const keys = [
    'MOCODE_MAIL_ENABLED',
    'MOCODE_MAIL_USER',
    'MOCODE_MAIL_PASS',
    'MOCODE_SMTP_HOST',
    'MOCODE_IMAP_HOST',
    'MOCODE_MAIL_TO',
    'MOCODE_MAIL_IDLE_MS',
  ];
  const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]));
  const restore = (): void => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetMailConfigCache();
  };
  for (const k of keys) delete process.env[k];
  try {
    assert.equal(getMailConfig(), null);

    process.env.MOCODE_MAIL_USER = 'a@example.com';
    process.env.MOCODE_MAIL_PASS = 'secret';
    process.env.MOCODE_SMTP_HOST = 'smtp.example.com';
    process.env.MOCODE_IMAP_HOST = 'imap.example.com';
    resetMailConfigCache();
    const cfg = getMailConfig();
    assert.ok(cfg);
    assert.equal(cfg?.enabled, true);
    assert.equal(cfg?.to, 'a@example.com'); // 缺省收件人 = user
    assert.equal(cfg?.idleMs, 5 * 60_000); // 默认 5 分钟
    assert.equal(cfg?.smtpPort, 465);
    assert.equal(cfg?.imapPort, 993);

    // 自定义静默阈值
    process.env.MOCODE_MAIL_IDLE_MS = '1000';
    resetMailConfigCache();
    assert.equal(getMailConfig()?.idleMs, 1000);
    // 非法值回退默认
    process.env.MOCODE_MAIL_IDLE_MS = '0';
    resetMailConfigCache();
    assert.equal(getMailConfig()?.idleMs, 5 * 60_000);

    // 显式关闭
    process.env.MOCODE_MAIL_ENABLED = 'false';
    resetMailConfigCache();
    assert.equal(getMailConfig(), null);
  } finally {
    restore();
  }
});
