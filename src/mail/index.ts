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

// ── 配置(env 直读:与 MOCODE_APPROVAL_TIMEOUT_MS 同款,改文件/环境后下个介入即生效)──

export interface MailConfig {
  enabled: boolean;
  /** 发提醒前的静默等待毫秒,默认 5 分钟。 */
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
        idleMs: numEnv('MOCODE_MAIL_IDLE_MS', 5 * 60_000),
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
  /** 去重:已据此邮件 resolve 过(按 UID),防同封重复应答。 */
  seen: Set<string>;
  settled: (result: InterventionResult) => void;
}

const pending = new Map<string, PendingIntervention>();

function newId(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 位十六进制,如 A1B2C3D4
}

// ── 邮件正文 / 主题 ─────────────────────────────────────────────────────────

/** 主题前缀,回复解析靠它定位待决介入。 */
export const MAIL_SUBJECT_PREFIX = '[mocode]';

export function buildSubject(id: string, title: string): string {
  const oneLine = title.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${MAIL_SUBJECT_PREFIX} ${id} ${oneLine}`.trim();
}

/**
 * 构造提醒邮件正文(纯文本)。choice 列出编号选项;input 提示直接回复文本。
 * 编号与面板选项顺序一致(含权限面板,故 1=允许一次、末项=拒绝)。
 */
export function buildBody(cfg: MailConfig, p: Pick<PendingIntervention, 'id' | 'req'>): string {
  const lines: string[] = [];
  lines.push('mocode 在执行任务时暂停,等待你的决定。');
  lines.push('');
  lines.push(`问题: ${p.req.title}`);
  if (p.req.detail) {
    lines.push('');
    lines.push(p.req.detail);
  }
  const options = optionPairs(p.req);
  lines.push('');
  if (options.length > 0) {
    lines.push('直接回复本邮件,在正文第一行写选项编号即可继续:');
    lines.push('');
    for (let i = 0; i < options.length; i++) {
      const { label, detail } = options[i];
      lines.push(`  ${i + 1}. ${label}`);
      // 选项详情(取舍/含义)单独缩进一行,让用户不看终端也能凭邮件做决定。
      if (detail) lines.push(`      ${detail}`);
    }
    lines.push('');
    lines.push(`例如回复: 1`);
  } else {
    lines.push('直接回复本邮件,在正文写下你的答复即可继续(自由文本)。');
  }
  lines.push('');
  lines.push(`介入编号: ${p.id}(无需手填,直接回复本邮件即可)`);
  lines.push(`本邮件由 mocode 发往 ${cfg.to},仅接受来自该地址的回复。`);
  return lines.join('\n');
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

async function sendMail(cfg: MailConfig, subject: string, text: string): Promise<void> {
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
    await transporter.sendMail({ from: cfg.user, to: cfg.to, subject, text });
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

/**
 * 从回复邮件的主题 + 正文解析介入编号与意图。
 *  - 主题优先匹配 [mocode] <ID>;主题缺失时从正文找形如 ID:XXXX 的 8 位十六进制。
 *  - 选项:正文首个有效 token 是 1..n 的数字;自由文本取正文首行。
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

  const cleaned = firstReplyLine(body);
  const numMatch = /^(\d{1,2})\b/.exec(cleaned);
  const option = numMatch ? Number(numMatch[1]) : 0;
  if (optionCount > 0 && option >= 1 && option <= optionCount) {
    return { id, kind: 'choice', option, text: '' };
  }
  if (optionCount === 0 && cleaned) {
    return { id, kind: 'text', option: 0, text: cleaned };
  }
  // choice 场景给了越界数字或无法识别:交给调用方判断(此处仍返回 id,便于回退)。
  if (optionCount > 0 && option >= 1) return { id, kind: 'choice', option, text: '' };
  return null;
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

/**
 * 读取 INBOX 当前 uidNext(下一封新邮件的起始 UID)作为水位基线,失败返 0。
 * 用 STATUS 命令取(免 SELECT/加锁),163 等服务端兼容性比 client.mailbox 更好。
 */
async function fetchInboxUidNext(client: import('imapflow').ImapFlow): Promise<number> {
  try {
    const status = (await client.status('INBOX', { uidNext: true })) as { uidNext?: number } | false;
    return status ? (status.uidNext ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * 自管理短连接地 best-effort 预取一次 uidNext(用于发信前精确设定水位,
 * 把自发自收的提醒自身排除)。任何失败/超时都静默返 0,绝不阻断发信。
 */
async function probeUidNextBestEffort(cfg: MailConfig): Promise<number> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    tls: { rejectUnauthorized: true },
  });
  try {
    // 整个探测限 8s:超时或任何异常都静默返 0,绝不阻断发信(finally 会关闭连接)。
    return await Promise.race([
      (async () => {
        await client.connect();
        return fetchInboxUidNext(client);
      })(),
      new Promise<number>((resolve) => {
        const t = setTimeout(() => resolve(0), 8000);
        t.unref?.();
      }),
    ]);
  } catch {
    return 0;
  } finally {
    await client.logout().catch(() => {});
  }
}

async function pollOnce(): Promise<void> {
  const cfg = getMailConfig();
  if (!cfg || polling || pending.size === 0) return;
  polling = true;
  try {
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapSecure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      tls: { rejectUnauthorized: true },
    });
    await client.connect();
    try {
      // 懒初始化水位:首次轮询时以"当前 uidNext"为基线,跳过全部历史邮件
      // (含刚自发自收的提醒本身),只处理此后到达的回复。水位与发信解耦。
      let uidNext = 0;
      for (const p of pending.values()) {
        if (p.watermark !== 0) continue;
        if (uidNext === 0) uidNext = await fetchInboxUidNext(client);
        if (uidNext > 0) p.watermark = uidNext - 1;
      }
      if (uidNext === 0) {
        // STATUS 没取到:回退到加锁后读 mailbox;仍取不到则本轮放弃,下轮重试。
        const lock = await client.getMailboxLock('INBOX');
        try {
          const mailbox = client.mailbox as { uidNext?: number } | false;
          uidNext = mailbox ? (mailbox.uidNext ?? 0) : 0;
          for (const p of pending.values()) {
            if (p.watermark === 0 && uidNext > 0) p.watermark = uidNext - 1;
          }
        } finally {
          lock.release();
        }
      }
      if (uidNext <= 0) return;

      const lock = await client.getMailboxLock('INBOX');
      try {
        // 只拉「水位之后、当前最后一封」的新邮件,不限已读/未读——回复经网页端常被自动
        // 标已读,只搜未读会漏接。'*' 是当前最后一封;range 为水位+1 到 uidNext-1。
        for (const p of [...pending.values()]) {
          if (p.watermark <= 0) continue;
          const start = p.watermark + 1;
          const end = uidNext - 1;
          if (start > end) continue; // 这轮没有比水位更新的邮件
          const messages = client.fetch(`${start}:${end}`, { uid: true, source: true });
          for await (const message of messages) {
            const key = String(message.uid);
            if (p.seen.has(key) || message.source == null) continue;
            // 推进水位:无论是否命中,这封已扫过,下轮不再重复拉(IMAP expunge 后 UID 仍单调)。
            p.watermark = Math.max(p.watermark, Number(message.uid));
            let parsed: Awaited<ReturnType<typeof simpleParser>>;
            try {
              parsed = await simpleParser(message.source);
            } catch {
              continue;
            }
            const from = Array.isArray(parsed.from) ? parsed.from[0]?.text : parsed.from?.text;
            if (!isTrustedSender(from, cfg)) continue;
            const subject = parsed.subject ?? '';
            const body = (parsed.text ?? '').trim();
            const handled = routeReply(p, subject, body, key);
            if (handled) {
              await client.messageFlagsAdd(key, ['\\Seen'], { uid: true }).catch(() => {});
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  } finally {
    polling = false;
    stopPollingIfIdle();
  }
}

/** 把一封回复路由到对应待决介入并 resolve。 */
/**
 * 尝试用一封回复满足指定待决介入。命中并 resolve 返 true。
 * 主题里带 id 优先;主题被改时回退用正文里的「介入编号: XXXX」。
 */
function routeReply(p: PendingIntervention, subject: string, body: string, messageKey: string): boolean {
  if (p.seen.has(messageKey)) return false;
  const optionCount = normalizedOptions(p.req).length;
  const parsed = parseReply(subject, body, optionCount);
  if (!parsed || parsed.id !== p.id) return false;
  p.seen.add(messageKey);
  const result = toInterventionResult(p, parsed);
  if (!result) return false; // 越界选项:忽略,继续等待有效回复
  pending.delete(p.id);
  p.settled(result);
  // 邮件到达时若本地面板仍开着,等价于用户在面板上做了同一选择,收起它。
  dismissActiveIntervention(result);
  return true;
}

/** ParsedReply → InterventionResult;choice 越界返 null。 */
function toInterventionResult(p: PendingIntervention, parsed: ParsedReply): InterventionResult | null {
  if (parsed.kind === 'text') {
    return { action: 'submitted', value: parsed.text };
  }
  const options = normalizedOptions(p.req);
  const label = options[parsed.option - 1];
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
    seen: new Set(),
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
 * 发信前 best-effort 预取水位(成功即可精确排除自发自收的提醒本身);
 * 预取失败也照发,水位由轮询首次运行时懒初始化兜底。
 */
async function notifyByMail(
  cfg: MailConfig,
  id: string,
  req: InterventionRequest,
  p: PendingIntervention,
  isSettled: () => boolean,
): Promise<void> {
  // 取的是"下一封的 UID":水位设为 uidNext-1,随后到达的提醒自身 UID 即 uidNext,
  // 会被排除在抓取范围(watermark+1=uidNext 起)之外,只处理其后真正的用户回复。
  const uidNext = await probeUidNextBestEffort(cfg);
  if (isSettled()) return;
  if (uidNext > 0) p.watermark = uidNext - 1;

  pending.set(id, p);
  try {
    await sendMail(cfg, buildSubject(id, req.title), buildBody(cfg, p));
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
