// 邮件远程介入(SMTP 发提醒 + IMAP 轮询回复)。
//
// 设计:
//  - 本地能答就不碰邮箱:promptWithMail 先弹本地 TUI 面板;只有超过提醒阈值仍无人应答时,
//    才发一封带编号选项的提醒邮件并惰性启动 IMAP 轮询。本地先答则零网络连接。
//  - 一封邮件 = 一个待决介入(pending Map,key=短 id)。用户回复数字=选中选项;
//    权限类只认 1=允许 / 2=拒绝,映射回本地化选项 label,与既有 prompt 契约零改动。
//  - 发件人白名单:只接受配置邮箱(MOCODE_MAIL_FROM/USER)自己发来的回复,防第三方伪造放行。
//  - best-effort:任何邮件/网络失败都不影响本地面板与主任务,仅放弃该远程通道。
//  - 轮询定时器 .unref():不吊住进程退出;无待决介入时自动停止,不做无谓轮询。

import crypto from 'node:crypto';
import type { InterventionRequest, InterventionResult } from '../ui/intervention.js';
import { promptIntervention, dismissActiveIntervention } from '../ui/intervention.js';
import { t } from '../i18n/index.js';

// ── 配置(env 直读:与 MOCODE_APPROVAL_TIMEOUT_MS 同款,改文件/环境后下个介入即生效)──

export interface MailConfig {
  enabled: boolean;
  /** 发提醒前的静默等待毫秒,默认 1 分钟。 */
  idleMs: number;
  /** IMAP 轮询间隔毫秒,默认 15s。 */
  pollMs: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  user: string;
  pass: string;
  /** 收件人(通常 = user);发件人白名单也用它。 */
  to: string;
}

function numEnv(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let cached: MailConfig | null | undefined;

/** 读取邮件配置。必填项(SMTP/IMAP host、账号、密码、收件人)缺失即视为未启用。 */
export function getMailConfig(): MailConfig | null {
  if (cached !== undefined) return applyEnabled(cached);
  const user = (process.env.MOCODE_MAIL_USER ?? '').trim();
  const pass = (process.env.MOCODE_MAIL_PASS ?? '').trim();
  const smtpHost = (process.env.MOCODE_SMTP_HOST ?? '').trim();
  const imapHost = (process.env.MOCODE_IMAP_HOST ?? '').trim();
  const to = (process.env.MOCODE_MAIL_TO ?? user).trim();
  const ready = !!user && !!pass && !!smtpHost && !!imapHost && !!to;
  const cfg: MailConfig | null = ready
    ? {
        enabled: true,
        idleMs: numEnv('MOCODE_MAIL_IDLE_MS', 60_000),
        pollMs: numEnv('MOCODE_MAIL_POLL_MS', 15_000),
        smtpHost,
        smtpPort: numEnv('MOCODE_SMTP_PORT', 465),
        smtpSecure: process.env.MOCODE_SMTP_SECURE !== 'false',
        imapHost,
        imapPort: numEnv('MOCODE_IMAP_PORT', 993),
        imapSecure: process.env.MOCODE_IMAP_SECURE !== 'false',
        user,
        pass,
        to,
      }
    : null;
  cached = cfg;
  return applyEnabled(cfg);
}

/** MOCODE_MAIL_ENABLED=false 时即便凭据完整也不启用。 */
function applyEnabled(cfg: MailConfig | null): MailConfig | null {
  if (!cfg) return null;
  return process.env.MOCODE_MAIL_ENABLED === 'false' ? null : cfg;
}

/** 测试/重配置用:清空 env 缓存(/mail on|off 改 env 后调用)。 */
export function resetMailConfigCache(): void {
  cached = undefined;
}

/**
 * 忽略启用开关,只看凭据是否完整(/mail test 与状态展示用):
 * 返回 {cfg: 完整凭据, enabled: 开关是否打开}。凭据缺失 cfg=null。
 */
export function getMailStatus(): { cfg: Omit<MailConfig, 'enabled'> | null; enabled: boolean } {
  resetMailConfigCache();
  const enabledCfg = getMailConfig();
  if (enabledCfg) return { cfg: enabledCfg, enabled: true };
  // 被开关关掉时 getMailConfig 返 null,临时放开探测凭据是否其实完整。
  const saved = process.env.MOCODE_MAIL_ENABLED;
  delete process.env.MOCODE_MAIL_ENABLED;
  resetMailConfigCache();
  const probe = getMailConfig();
  if (saved === undefined) delete process.env.MOCODE_MAIL_ENABLED;
  else process.env.MOCODE_MAIL_ENABLED = saved;
  resetMailConfigCache();
  return { cfg: probe, enabled: false };
}

// ── 待决介入注册表 ──────────────────────────────────────────────────────────

interface PendingIntervention {
  id: string;
  req: InterventionRequest;
  /**
   * UID 水位:只处理提醒发出后到达的邮件(UID > watermark)。
   * 不依赖 \\Seen 标志——回复经网页/客户端时常常已被自动标已读,
   * 只搜未读会漏接(线上实测)。0 = 尚未取到水位(跳过本轮,等待初始化)。
   */
  watermark: number;
  /** 提醒邮件发出时刻(ms),水位未知时据此按日期范围找回回复。 */
  sentAt: number;

  /**
   * 本介入提醒邮件的 Message-ID(小写、无尖括号)。
   * 注意:163/Coremail 会**改写** Message-ID(实测改成 <uuid@163.com>),
   * 故这条只对其他保留自定义头的服务端有效;163 上靠 isSelfReminder() 正文标记兜底。
   */
  selfMessageId: string | null;
  /**
   * 从收件箱里那份"提醒副本"读到的**真实** Message-ID(服务端改写后的)。
   * 用户回复的 In-Reply-To 指向它,是移除主题编号后最可靠的归属依据。
   * 轮询第一次遇到本介入的提醒副本时回填。
   */
  actualMessageId: string | null;
  settled: (result: InterventionResult) => void;
}

const pending = new Map<string, PendingIntervention>();

function newId(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 位十六进制,如 A1B2C3D4
}

// ── 邮件正文 / 主题 ─────────────────────────────────────────────────────────

/** 主题前缀,回复解析靠它定位待决介入。 */
export const MAIL_SUBJECT_PREFIX = '[mocode]';

/**
 * 提醒邮件的机器可读首行标记。163/Coremail 会改写 Message-ID,没法靠 header 认出
 * "提醒自己",故用这行固定标记(含介入编号)在轮询里识别并跳过。
 * 用户真实回复不会以此开头;标记与语言无关,中英文界面都不会误判。
 */
function reminderMark(id: string): string {
  return `[mocode-intervention: ${id}]`;
}

/** 本地时间 "YYYY-MM-DD HH:mm"(邮件里给人看,不带时区噪声)。 */
function formatTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildSubject(title: string): string {
  const oneLine = title.replace(/\s+/g, ' ').trim().slice(0, 60);
  const tag = t('mail.subjectTag');
  // 主题不带介入编号:编号对用户没有信息量,且会顶在标题最显眼处。
  // 回复归属改由 In-Reply-To(提醒真实 Message-ID)/正文引用/单待决兜底判定。
  return `${MAIL_SUBJECT_PREFIX} ${tag} · ${oneLine}`.trim();
}

/**
 * 构造提醒邮件正文(纯文本,兼作邮件客户端的降级展示)。
 * 分段式排版:问题 / 背景 / 选项 / 怎么回复 / 其他信息,让用户在手机上也能一眼看懂。
 * 编号与面板选项顺序一致(含权限面板,故 1=允许一次、末项=拒绝)。
 */
export function buildBody(cfg: MailConfig, p: Pick<PendingIntervention, 'id' | 'req'>): string {
  const options = optionPairs(p.req);
  const idle = Math.max(1, Math.round(cfg.idleMs / 1000));
  const lines: string[] = [];
  lines.push(reminderMark(p.id));
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(` ${t('mail.bodyTitle')}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push(t('mail.bodyIntro', { idle }));
  lines.push('');
  lines.push(`■ ${t('mail.bodyProblem')}`);
  for (const l of p.req.title.split(/\r?\n/)) lines.push(`  ${l}`);
  if (p.req.detail && p.req.detail.trim()) {
    lines.push('');
    lines.push(`■ ${t('mail.bodyBackground')}`);
    for (const l of p.req.detail.split(/\r?\n/)) lines.push(`  ${l}`);
  }
  if (options.length > 0) {
    lines.push('');
    lines.push(`■ ${t('mail.bodyOptions')}`);
    for (let i = 0; i < options.length; i++) {
      const { label, detail } = options[i];
      lines.push(`  ${i + 1}. ${label}`);
      // 选项详情(取舍/含义)单独缩进一行,让用户不看终端也能凭邮件做决定。
      if (detail) lines.push(`     ${detail}`);
    }
  }
  lines.push('');
  lines.push(`■ ${t('mail.bodyReply')}`);
  const reply =
    options.length > 0
      ? t('mail.bodyReplyChoice', { example: '1', marker: MAIL_SUBJECT_PREFIX })
      : t('mail.bodyReplyInput');
  for (const l of reply.split('\n')) lines.push(`  ${l}`);
  lines.push('');
  lines.push(`■ ${t('mail.bodyMeta')}`);
  lines.push(`  ${t('mail.bodyMetaId')}: ${p.id}`);
  lines.push(`  ${t('mail.bodyMetaCwd')}: ${process.cwd()}`);
  lines.push(`  ${t('mail.bodyMetaTime')}: ${formatTime(new Date())}`);
  lines.push('');
  lines.push(t('mail.bodyTrusted', { to: cfg.to }));
  lines.push(t('mail.bodyFooter'));
  return lines.join('\n');
}

/** HTML 转义:标题/详情/选项都来自模型,绝不能原样塞进邮件 HTML。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 构造 HTML 版提醒邮件(网页/手机客户端优先渲染这版,纯文本作为降级)。
 * 只用行内样式 + table 布局:邮件客户端普遍不支持 <style>/flex/grid。
 */
export function buildHtmlBody(cfg: MailConfig, p: Pick<PendingIntervention, 'id' | 'req'>): string {
  const options = optionPairs(p.req);
  const idle = Math.max(1, Math.round(cfg.idleMs / 1000));
  const esc = escapeHtml;
  const sectionLabel = (text: string): string =>
    `<div style="font-size:12px;letter-spacing:.06em;color:#6b7280;margin:0 0 8px">${esc(text)}</div>`;

  const optionRows = options
    .map((o, i) => {
      const detail = o.detail
        ? `<div style="font-size:13px;line-height:1.6;color:#6b7280;margin-top:4px">${esc(o.detail)}</div>`
        : '';
      return `<tr>
        <td style="vertical-align:top;padding:10px 12px;border-top:1px solid #f1f5f9;width:44px">
          <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:12px;background:#eef2ff;color:#4338ca;font-size:13px;font-weight:600">${i + 1}</span>
        </td>
        <td style="vertical-align:top;padding:10px 12px 10px 0;border-top:1px solid #f1f5f9">
          <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.5">${esc(o.label)}</div>
          ${detail}
        </td>
      </tr>`;
    })
    .join('');

  const replyBox =
    options.length > 0
      ? `<div style="background:#eef2ff;border:1px solid #e0e7ff;border-radius:10px;padding:14px 16px;margin:22px 0 0">
          <div style="font-size:13px;font-weight:600;color:#3730a3;margin-bottom:6px">${esc(t('mail.bodyReply'))}</div>
          <div style="font-size:13px;line-height:1.8;color:#374151">${esc(t('mail.htmlReplyChoice', { marker: MAIL_SUBJECT_PREFIX }))}</div>
          <div style="margin-top:10px;font-family:Consolas,Menlo,monospace;font-size:20px;font-weight:700;color:#4338ca;background:#ffffff;border:1px dashed #c7d2fe;border-radius:8px;padding:8px 14px;display:inline-block">1</div>
        </div>`
      : `<div style="background:#eef2ff;border:1px solid #e0e7ff;border-radius:10px;padding:14px 16px;margin:22px 0 0">
          <div style="font-size:13px;font-weight:600;color:#3730a3;margin-bottom:6px">${esc(t('mail.bodyReply'))}</div>
          <div style="font-size:13px;line-height:1.8;color:#374151">${esc(t('mail.bodyReplyInput'))}</div>
        </div>`;

  const detailBlock = p.req.detail?.trim()
    ? `<div style="margin:0 0 20px">
        ${sectionLabel(t('mail.bodyBackground'))}
        <div style="font-size:14px;line-height:1.8;color:#374151;white-space:pre-wrap">${esc(p.req.detail)}</div>
      </div>`
    : '';

  const optionsBlock =
    options.length > 0
      ? `<div style="margin:0 0 4px">
          ${sectionLabel(t('mail.bodyOptions'))}
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#ffffff">${optionRows}</table>
        </div>`
      : '';

  return `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f3f4f6">
  <div style="max-width:640px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
    <div style="background:#111827;padding:18px 24px">
      <div style="font-size:11px;letter-spacing:.18em;color:#9ca3af">MOCODE</div>
      <div style="font-size:19px;font-weight:600;color:#ffffff;margin-top:4px">${esc(t('mail.htmlTitle'))}</div>
    </div>
    <div style="padding:24px 24px 22px">
      <div style="font-size:15px;line-height:1.75;color:#374151;margin:0 0 20px">${esc(t('mail.bodyIntro', { idle }))}</div>
      <div style="background:#f9fafb;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;padding:14px 16px;margin:0 0 20px">
        ${sectionLabel(t('mail.bodyProblem'))}
        <div style="font-size:17px;font-weight:600;line-height:1.5;color:#111827">${esc(p.req.title)}</div>
      </div>
      ${detailBlock}
      ${optionsBlock}
      ${replyBox}
      <div style="border-top:1px solid #e5e7eb;margin:22px 0 14px"></div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr><td style="font-size:12px;color:#9ca3af;padding:2px 0">${esc(t('mail.bodyMetaId'))}</td><td style="font-size:12px;color:#6b7280;padding:2px 0;text-align:right;font-family:Consolas,Menlo,monospace">${esc(p.id)}</td></tr>
        <tr><td style="font-size:12px;color:#9ca3af;padding:2px 0">${esc(t('mail.bodyMetaCwd'))}</td><td style="font-size:12px;color:#6b7280;padding:2px 0;text-align:right;word-break:break-all">${esc(process.cwd())}</td></tr>
        <tr><td style="font-size:12px;color:#9ca3af;padding:2px 0">${esc(t('mail.bodyMetaTime'))}</td><td style="font-size:12px;color:#6b7280;padding:2px 0;text-align:right">${esc(formatTime(new Date()))}</td></tr>
      </table>
      <div style="font-size:11px;color:#9ca3af;line-height:1.8;margin-top:12px">${esc(t('mail.bodyTrusted', { to: cfg.to }))}<br>${esc(t('mail.bodyFooter'))}</div>
    </div>
  </div>
</body></html>`;
}

/** 选项的 label + 可选详情(choice 用);字符串选项或 input 模式无详情。 */
export function optionPairs(req: InterventionRequest): Array<{ label: string; detail?: string }> {
  if (req.type !== 'choice' || !Array.isArray(req.options)) return [];
  const out: Array<{ label: string; detail?: string }> = [];
  for (const o of req.options) {
    if (typeof o === 'string') {
      const label = o.trim();
      if (label) out.push({ label });
    } else {
      const label = (o?.label ?? '').trim();
      if (!label) continue;
      const detail = o?.detail?.trim();
      out.push(detail ? { label, detail } : { label });
    }
  }
  return out;
}

/** 把 InterventionRequest.options 归一为 label 字符串数组(choice 用);input 返 []。 */
export function normalizedOptions(req: InterventionRequest): string[] {
  return optionPairs(req).map((o) => o.label);
}

// ── SMTP 发送 ───────────────────────────────────────────────────────────────

/** 生成提醒邮件的确定性 Message-ID(无尖括号),便于轮询识别并跳过自发自收的提醒本身。 */
function selfMessageId(id: string, user: string): string {
  const domain = user.includes('@') ? user.split('@')[1] : 'localhost';
  return `mocode-${id.toLowerCase()}@${domain}`;
}

/** 归一化 Message-ID:去尖括号/空白、转小写。 */
function normMessageId(raw: string | undefined | null): string {
  return (raw ?? '')
    .trim()
    .replace(/^<+|>+$/g, '')
    .toLowerCase();
}

async function sendMail(
  cfg: MailConfig,
  subject: string,
  text: string,
  messageId: string,
  html?: string,
): Promise<void> {
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: { user: cfg.user, pass: cfg.pass },
    // 连接/发送各 10s 超时,避免挂死主任务的 Promise 竞态。
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transporter.sendMail({
      from: cfg.user,
      to: cfg.to,
      subject,
      text,
      // 同时给 text + html:客户端优先渲染 HTML,不支持时自动降级到纯文本。
      ...(html ? { html } : {}),
      // 显式钉死 Message-ID(加回尖括号):保留自定义 Message-ID 的服务端可据此识别
      // "提醒本身";163 会改写它,故另有 isSelfReminder 正文标记兜底。
      messageId: `<${messageId}>`,
    });
  } finally {
    transporter.close();
  }
}

// ── 回复解析(纯函数,便于单测)──────────────────────────────────────────────

export interface ParsedReply {
  id: string;
  kind: 'choice' | 'text';
  /** choice=选中的选项序号(1 起);text 时为 0。 */
  option: number;
  text: string;
}

export interface ReplyIntent {
  kind: 'choice' | 'text';
  /** choice=选中的选项序号(1 起);text 时为 0。 */
  option: number;
  text: string;
}

/**
 * 只解析"用户想要什么"(编号或自由文本),不关心属于哪一次介入。
 * 归属由 resolvePending 依据主题/引用头/正文编号/单待决兜底判定。
 */
export function parseIntent(body: string, optionCount: number): ReplyIntent | null {
  const cleaned = firstReplyLine(body);
  const numMatch = /^(\d{1,2})\b/.exec(cleaned);
  const option = numMatch ? Number(numMatch[1]) : 0;
  if (optionCount > 0 && option >= 1) return { kind: 'choice', option, text: '' };
  if (optionCount === 0 && cleaned) return { kind: 'text', option: 0, text: cleaned };
  return null;
}

/**
 * 从回复邮件的主题 + 正文解析介入编号与意图。
 *  - 主题优先匹配 [mocode] <ID>(兼容旧版提醒);缺失时从正文找"介入编号: XXXX"。
 *  - 选项:正文首个有效 token 是数字;自由文本取正文首行。
 * 无法解析出 id 返 null。
 */
export function parseReply(subject: string, body: string, optionCount: number): ParsedReply | null {
  const subjectMatch = new RegExp(`${escapeRegExp(MAIL_SUBJECT_PREFIX)}\\s*([0-9A-Fa-f]{8})`, 'i').exec(subject ?? '');
  let id = subjectMatch?.[1]?.toUpperCase();
  if (!id) {
    const bodyMatch = /(?:介入编号|ID)\s*[:：]?\s*([0-9A-Fa-f]{8})/i.exec(body ?? '');
    id = bodyMatch?.[1]?.toUpperCase();
  }
  if (!id) return null;
  const intent = parseIntent(body, optionCount);
  if (!intent) return null;
  return { id, ...intent };
}

/** 一封回复邮件用于归属判定所需的元信息。 */
export interface ReplyMeta {
  subject: string;
  body: string;
  /** 回复引用的原邮件 Message-ID(mailparser 的 inReplyTo)。 */
  inReplyTo?: string | null;
  /** 引用链(References 头)。 */
  references?: string[] | null;
}

/** resolvePending 只需要这三个字段(便于单测)。 */
export type PendingKey = Pick<PendingIntervention, 'id' | 'actualMessageId' | 'selfMessageId'>;

/**
 * 判定一封回复属于哪个待决介入。顺序(强 → 弱):
 *  1. 主题里的旧式编号 `[mocode] <ID>`(兼容历史提醒邮件);
 *  2. In-Reply-To / References 命中提醒的 Message-ID(可能是服务端改写后的真实 ID);
 *  3. 正文引用了"介入编号: XXXX"(客户端把原文引用下来时);
 *  4. 只有一个待决介入 → 就是它(绝大多数场景:agent 被该介入阻塞)。
 * 无法唯一确定时返 null,宁可不处理也不猜错选项。
 */
export function resolvePending<T extends PendingKey>(pendings: T[], meta: ReplyMeta): T | null {
  const subjectId = new RegExp(`${escapeRegExp(MAIL_SUBJECT_PREFIX)}\\s*([0-9A-Fa-f]{8})\\b`, 'i')
    .exec(meta.subject ?? '')?.[1]
    ?.toUpperCase();
  if (subjectId) return pendings.find((p) => p.id === subjectId) ?? null;

  const refs = new Set<string>();
  for (const raw of [meta.inReplyTo, ...(meta.references ?? [])]) {
    const n = normMessageId(raw);
    if (n) refs.add(n);
  }
  if (refs.size > 0) {
    const hit = pendings.find(
      (p) => (!!p.actualMessageId && refs.has(p.actualMessageId)) || (!!p.selfMessageId && refs.has(p.selfMessageId)),
    );
    if (hit) return hit;
  }

  const bodyId = /(?:介入编号|ID)\s*[:：]\s*([0-9A-Fa-f]{8})\b/i.exec(meta.body ?? '')?.[1]?.toUpperCase();
  if (bodyId) return pendings.find((p) => p.id === bodyId) ?? null;

  return pendings.length === 1 ? pendings[0] : null;
}

/**
 * 从回复正文里取"用户真正写的第一行"。网页/客户端回复会自动带上原文引用块
 * (">" 行、"在 ... 写道:"、"发件人:"、"原邮件"、签名分隔 "-- ")。
 * 规则:
 *  - 行首引用符 ">" 先剥掉;纯选项数字(如 "> 1")即便在引用行里也采信——
 *    很多手机端回复会把光标放进引用块里写数字;
 *  - 文字行若原本带 ">"(引用块里的原文)则跳过,避免把原问题当自由文本回复;
 *  - 邮件头/署名等噪声行一律跳过。
 */
export function firstReplyLine(body: string): string {
  const noise =
    /^(?:在[^。\n]{0,80}(?:写道|wrote):|"[^"]*"\s*<[^>]*>\s*(?:写道|wrote):|发件人[:：]|收件人[:：]|主题[:：]|时间[:：]|日期[:：]|date:|from:|to:|subject:|sent:|-{2,}$|_{3,}$|原邮件|原始邮件|回复:?$|re:?$)/i;
  for (const raw of (body ?? '').split(/\r?\n/)) {
    const wasQuoted = /^\s*>/.test(raw);
    const line = raw.replace(/^[>\s]+/, '').trim();
    if (!line) continue;
    if (noise.test(line)) continue;
    // 纯选项数字(可带 ". "、")" 等标点):无论是否在引用块里都采信。
    const digits = /^(\d{1,2})/.exec(line);
    if (digits && /^\d{1,2}[\s.。:：)]*$/.test(line)) return digits[1];
    // 自由文本:只采信用户自己写的非引用行。
    if (!wasQuoted) return line;
  }
  return '';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 发件人是否为受信地址(白名单 = 配置的收件邮箱本身,大小写不敏感)。 */
function isTrustedSender(from: string | undefined, cfg: MailConfig): boolean {
  if (!from) return false;
  const addr = extractAddress(from).toLowerCase();
  return addr === cfg.to.toLowerCase() || addr === cfg.user.toLowerCase();
}

/** 从 "Name <a@b.com>" 或裸地址里取出邮箱部分。 */
export function extractAddress(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

/**
 * 这封邮件是不是我们自己发出的提醒(回投到收件箱)而不是用户回复?
 *  - 正文首个非空行(允许被引用的 ">")是 `[mocode-intervention: <ID>]` 标记。
 * 用户回复只会以自己写的内容开头,不会被误判;标记与语言无关,对 163(改写
 * Message-ID)同样有效。公开以便单元测试。
 */
export function isSelfReminder(p: Pick<PendingIntervention, 'id'>, body: string): boolean {
  const first = (body ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[>\s]+/, '').trim())
    .find((l) => l.length > 0);
  return !!first && first.includes(reminderMark(p.id));
}

// ── IMAP 轮询 ───────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

/** 惰性启动轮询:已有定时器或无待决介入时不重复启动。 */
function ensurePolling(): void {
  const cfg = getMailConfig();
  if (!cfg || pollTimer) return;
  const timer = setInterval(() => {
    void pollOnce().catch(() => {});
  }, cfg.pollMs);
  timer.unref?.(); // 关键:不吊住进程退出(对齐 idle-guard 教训)
  pollTimer = timer;
  void pollOnce().catch(() => {}); // 立即先查一次
}

/** 无待决介入时停止轮询(全部应答/取消后回收句柄)。 */
function stopPollingIfIdle(): void {
  if (pollTimer && pending.size === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 同步停止(退出钩子用):清定时器。IMAP 客户端为每轮短连接,无需额外关闭。 */
export function stopMailPollerSync(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 邮件 IMAP 连接工厂(与 /mail test 同参数)。 */
function connectImap(cfg: MailConfig): Promise<import('imapflow').ImapFlow> {
  let ctor: typeof import('imapflow').ImapFlow;
  return import('imapflow').then(({ ImapFlow }) => {
    ctor = ImapFlow;
    const client = new ctor({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapSecure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      tls: { rejectUnauthorized: true },
    });
    return client.connect().then(() => client);
  });
}

/**
 * 读取 INBOX 当前**最高一封邮件的 UID**(空邮箱返 0),作为水位基线。
 * 不依赖 STATUS uidNext——163 邮箱实测 STATUS/SELECT 都不返回 uidNext(只给
 * messages/unseen),改用 IMAP `UID SEARCH *`(`search({uid:'*'}, {uid:true})`),
 * 各主流服务端都支持。必须在已 open/lock INBOX 的连接上调用。
 */
async function fetchHighestUid(client: import('imapflow').ImapFlow): Promise<number> {
  try {
    const r = await client.search({ uid: '*' }, { uid: true });
    const last = Array.isArray(r) ? r[r.length - 1] : undefined;
    return typeof last === 'number' && Number.isFinite(last) ? last : 0;
  } catch {
    return 0;
  }
}

/**
 * 自管理短连接地 best-effort 预取一次"发信前最高 UID"(用于精确设定水位,
 * 把自发自收的提醒自身排除:水位 = 当前最高,提醒自身 UID > 水位时才被处理,
 * 而它发出后下一轮水位会先被它推进——因此实际靠"发信前快照 + 下轮增量"语义)。
 * 任何失败/超时都静默返 0,绝不阻断发信。
 */
async function probeHighestUidBestEffort(cfg: MailConfig): Promise<number> {
  // 连接/查询放在独立 IIFE 里:超时只是放弃等待,后台任务自己收尾(lock/logout),
  // 故 client 句柄不跨 await 暴露给外层,避免类型窄化与悬挂连接。
  const attempt = (async (): Promise<number> => {
    let client: import('imapflow').ImapFlow | null = null;
    try {
      client = await connectImap(cfg);
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fetchHighestUid(client);
      } finally {
        lock.release();
      }
    } finally {
      await client?.logout().catch(() => {});
    }
  })();
  attempt.catch(() => {}); // 超时后后台任务若最终失败,不要变成 unhandled rejection
  const timeout = new Promise<number>((resolve) => {
    const t = setTimeout(() => resolve(0), 8000);
    t.unref?.();
  });
  try {
    const highest = await Promise.race([attempt, timeout]);
    return Number.isFinite(highest) && highest > 0 ? highest : 0;
  } catch {
    return 0;
  }
}

/** 最近一次轮询的诊断快照(/mail 状态页展示,排障用;不含敏感信息)。 */
export interface MailPollState {
  at: number;
  highest: number;
  candidates: number;
  handled: number;
  /** 最近一次跳过的原因:空=未跳过。ambiguous=多个待决介入无法归属。 */
  skipped: 'sender' | 'self' | 'parse' | 'ambiguous' | null;
  error: string | null;
}

let lastPoll: MailPollState = { at: 0, highest: 0, candidates: 0, handled: 0, skipped: null, error: null };

/** 只读诊断快照:让用户在 TUI 里看到"轮询有没有真的在跑、跑到哪一步"。 */
export function getMailPollState(): Readonly<MailPollState> {
  return lastPoll;
}

/** 当前待决介入数(/mail 状态页展示;>0 才会有轮询在跑)。 */
export function pendingInterventionCount(): number {
  return pending.size;
}

/**
 * 列出本轮要检查的候选 UID(升序),取所有待决介入的公共下界。
 *  - 水位全部已知:直接 `UID SEARCH <min(watermark)+1>:*`,无时间上限,晚几天的回复也能收。
 *  - 任一水位未知(发信前预取失败):退化为"最早发信日回溯 1 天"的日期搜索,
 *    绝不把 watermark 直接设成当前最高——那会把发信后立刻到达的回复永久跳过。
 */
async function candidateUids(client: import('imapflow').ImapFlow, list: PendingIntervention[]): Promise<number[]> {
  const watermarks = list.map((p) => p.watermark);
  const known = watermarks.every((w) => w > 0);
  const query = known
    ? { uid: `${Math.min(...watermarks) + 1}:*` }
    : { since: new Date(Math.min(...list.map((p) => p.sentAt)) - 24 * 3600_000) };
  const found = await client.search(query, { uid: true });
  const uids = Array.isArray(found) ? found : [];
  const floor = known ? Math.min(...watermarks) : 0;
  return uids
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > floor)
    .sort((a, b) => a - b);
}

async function pollOnce(): Promise<void> {
  const cfg = getMailConfig();
  if (!cfg || polling || pending.size === 0) return;
  polling = true;
  const state: MailPollState = { at: Date.now(), highest: 0, candidates: 0, handled: 0, skipped: null, error: null };
  lastPoll = state;
  try {
    const { simpleParser } = await import('mailparser');
    const client = await connectImap(cfg);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // 当前最高 UID(163 不支持 STATUS uidNext,用 UID SEARCH * 取)。
        const highest = await fetchHighestUid(client);
        state.highest = highest;
        if (highest <= 0) return; // 空邮箱或服务端异常:本轮无可拉取,下轮重试。

        // 全局扫一遍候选:一封回复只处理一次,归属靠 resolvePending 判定。
        const list = [...pending.values()];
        const uids = await candidateUids(client, list);
        state.candidates = uids.length;
        for (const uid of uids) {
          // 单封按 UID 取(第三参 { uid: true } 不可省,否则 range 被当序列号)。
          const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true }).catch(() => null);
          if (!fetched || !fetched.source) continue;
          let parsed: Awaited<ReturnType<typeof simpleParser>>;
          try {
            parsed = await simpleParser(fetched.source);
          } catch {
            state.skipped = 'parse';
            continue; // 不推进水位:下轮重试这封,别把不可解析的邮件当已处理
          }
          // 解析成功才推进水位:这封已纳入判断,下轮不再重复拉取。
          for (const q of pending.values()) q.watermark = Math.max(q.watermark, uid);

          const from = Array.isArray(parsed.from) ? parsed.from[0]?.text : parsed.from?.text;
          if (!isTrustedSender(from, cfg)) {
            state.skipped = 'sender';
            continue;
          }
          const subject = parsed.subject ?? '';
          const body = (parsed.text ?? '').trim();

          // 先认"提醒自己的副本":命中则记下服务端改写后的真实 Message-ID
          // (用户回复的 In-Reply-To 指向它),并跳过,绝不当成用户答复。
          const owner = [...pending.values()].find(
            (q) =>
              (!!q.selfMessageId && normMessageId(parsed.messageId) === q.selfMessageId) || isSelfReminder(q, body),
          );
          if (owner) {
            if (!owner.actualMessageId) owner.actualMessageId = normMessageId(parsed.messageId) || null;
            state.skipped = 'self';
            continue;
          }

          const refs = (Array.isArray(parsed.references) ? parsed.references : [parsed.references]).filter(
            (r): r is string => typeof r === 'string',
          );
          const meta = { subject, body, inReplyTo: parsed.inReplyTo ?? null, references: refs };
          const target = resolvePending([...pending.values()], meta);
          if (!target) {
            // 多个待决介入且无法归属:宁可不动,也不猜错选项。
            state.skipped = 'ambiguous';
            continue;
          }
          if (routeReply(target, body)) {
            state.handled++;
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  } catch (e) {
    // 以前这里静默吞错,导致"邮件到了却什么都不发生"。留痕到诊断快照,便于 /mail 查看。
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    polling = false;
    stopPollingIfIdle();
  }
}

/**
 * 尝试用一封回复满足指定待决介入。命中并 resolve 返 true。
 * 归属由 resolvePending 决定,这里只把正文解析成意图(编号/自由文本)。
 */
function routeReply(p: PendingIntervention, body: string): boolean {
  const intent = parseIntent(body, normalizedOptions(p.req).length);
  if (!intent) return false;
  const result = toInterventionResult(p, intent);
  if (!result) return false; // 越界选项:忽略,继续等待有效回复
  pending.delete(p.id);
  p.settled(result);
  // 邮件到达时若本地面板仍开着,等价于用户在面板上做了同一选择,收起它。
  dismissActiveIntervention(result);
  return true;
}

/** ReplyIntent → InterventionResult;choice 越界返 null。 */
function toInterventionResult(p: PendingIntervention, intent: ReplyIntent): InterventionResult | null {
  if (intent.kind === 'text') {
    return { action: 'submitted', value: intent.text };
  }
  const options = normalizedOptions(p.req);
  const label = options[intent.option - 1];
  if (!label) return null;
  return { action: 'selected', value: label };
}

// ── 中介:本地面板 + 超时邮件,先应答者胜 ───────────────────────────────────

/**
 * 弹本地介入面板;若 idleMs 内无人应答,发提醒邮件并启动 IMAP 轮询。
 * 本地按键与邮件回复谁先到用谁,后到者被 settled 守卫忽略。邮件未配置/发送失败时
 * 退化为纯本地面板(行为等同 promptIntervention)。
 */
export function promptWithMail(req: InterventionRequest): Promise<InterventionResult> {
  const cfg = getMailConfig();
  // 未配置邮件:直接走原面板,零额外行为。
  if (!cfg) return promptIntervention(req);

  const id = newId();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const p: PendingIntervention = {
    id,
    req,
    watermark: 0,
    sentAt: Date.now(),
    selfMessageId: null,
    actualMessageId: null,
    settled: () => {},
  };

  const result = new Promise<InterventionResult>((resolve) => {
    const finish = (r: InterventionResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.delete(id);
      stopPollingIfIdle();
      resolve(r);
    };
    p.settled = finish;

    // 本地面板:用户按键 → finish;我们 race 它。
    const local = promptIntervention(req).then((r) => finish(r));

    // 超时仍未决 → 取 UID 水位 → 发提醒 → 启动轮询。
    timer = setTimeout(() => {
      if (settled) return;
      void notifyByMail(cfg, id, req, p, () => settled);
    }, cfg.idleMs);
    timer.unref?.();

    // local 拒绝(理论上不 reject)兜底:避免 unhandled rejection。
    local.catch(() => finish({ action: 'cancelled' }));
  });

  return result;
}

/**
 * 超时后发提醒邮件并把待决项挂进轮询。isSettled 用于在异步预取/发信期间
 * 检测用户是否已在终端作答,若是则放弃。发信绝不因 IMAP 失败而被阻断:
 * 发信前 best-effort 预取"当前最高 UID"作为水位;预取失败也照发,轮询退化为
 * "发信时间之后"的日期搜索(不会跳过发信后立即到达的回复)。
 * 提醒自身靠 isSelfReminder(正文特征)+ Message-ID 在轮询中被跳过。
 */
async function notifyByMail(
  cfg: MailConfig,
  id: string,
  req: InterventionRequest,
  p: PendingIntervention,
  isSettled: () => boolean,
): Promise<void> {
  // 发信前快照"当前最高 UID":水位之下全是历史邮件;提醒自身 UID 虽高于水位,
  // 但会被 isSelfReminder/Message-ID 判断跳过,只处理其后真正的用户回复。
  const highest = await probeHighestUidBestEffort(cfg);
  if (isSettled()) return;
  if (highest > 0) p.watermark = highest;
  p.sentAt = Date.now();
  p.selfMessageId = selfMessageId(id, cfg.user);

  pending.set(id, p);
  try {
    await sendMail(cfg, buildSubject(req.title), buildBody(cfg, p), p.selfMessageId, buildHtmlBody(cfg, p));
  } catch {
    // 发信失败:撤销注册,避免空等;本地面板仍在,用户可终端作答。
    pending.delete(id);
    stopPollingIfIdle();
    return;
  }
  if (isSettled()) {
    // 发信期间用户已在终端作答:撤销注册即可,无需再轮询。
    pending.delete(id);
    stopPollingIfIdle();
    return;
  }
  ensurePolling();
}

// ── 连通性自检(/mail test)──────────────────────────────────────────────────

export interface MailTestResult {
  ok: boolean;
  smtp: 'ok' | 'fail';
  imap: 'ok' | 'fail' | 'skipped';
  error?: string;
}

/**
 * 发一封测试邮件到配置邮箱,并尝试 IMAP 登录自检(不依赖刚发的信已送达)。
 * 仅当配置完整时可调用;任一步失败都在对应字段标记并返回原因,不抛错。
 */
export async function sendTestMail(): Promise<MailTestResult> {
  // 用状态探测取完整凭据:即便当前被 /mail off 关闭,也允许发测试信验证配置。
  const { cfg: statusCfg } = getMailStatus();
  if (!statusCfg) {
    return { ok: false, smtp: 'fail', imap: 'skipped', error: 'mail-not-configured' };
  }
  // 测试信无视启用开关,补 enabled 字段以满足内部连接函数的 MailConfig 形参。
  const cfg: MailConfig = { ...statusCfg, enabled: true };
  const result: MailTestResult = { ok: false, smtp: 'fail', imap: 'skipped' };
  try {
    const stamp = new Date().toISOString();
    await sendMail(
      cfg,
      `${MAIL_SUBJECT_PREFIX} test ${stamp}`,
      [
        '这是一封来自 mocode 的测试邮件。',
        '如果你收到了它,说明 SMTP 发送配置正确。',
        `时间: ${stamp}`,
        '',
        '人工介入提醒也会发到这个邮箱;直接回复提醒邮件即可让 mocode 继续执行。',
      ].join('\n'),
      // 测试信也要显式 Message-ID(与提醒邮件同款),避免服务端留空导致后续排障困难。
      `mocode-test-${Date.now().toString(36)}@${cfg.user.includes('@') ? cfg.user.split('@')[1] : 'localhost'}`,
    );
    result.smtp = 'ok';
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
  try {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapSecure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      tls: { rejectUnauthorized: true },
    });
    await client.connect();
    await client.mailboxOpen('INBOX');
    await client.logout().catch(() => {});
    result.imap = 'ok';
  } catch (e) {
    result.imap = 'fail';
    result.error = result.error ?? (e instanceof Error ? e.message : String(e));
  }
  result.ok = result.smtp === 'ok' && result.imap === 'ok';
  return result;
}
