// 常见邮箱域名 → SMTP/IMAP 主机预设。
// 纯数据叶子:config 向导(src/commands/config.ts)与 /mail setup 斜杠命令共用,
// 避免在两个交互入口各维护一份域名表。

export interface MailProviderPreset {
  match: RegExp;
  smtp: string;
  imap: string;
}

export const MAIL_PROVIDERS: MailProviderPreset[] = [
  { match: /@gmail\.com$/i, smtp: 'smtp.gmail.com', imap: 'imap.gmail.com' },
  { match: /@(qq|foxmail)\.com$/i, smtp: 'smtp.qq.com', imap: 'imap.qq.com' },
  { match: /@163\.com$/i, smtp: 'smtp.163.com', imap: 'imap.163.com' },
  { match: /@126\.com$/i, smtp: 'smtp.126.com', imap: 'imap.126.com' },
  { match: /@(outlook|hotmail|live)\.com$/i, smtp: 'smtp.office365.com', imap: 'outlook.office365.com' },
  { match: /@(?:.*\.)?sina\.com$/i, smtp: 'smtp.sina.com', imap: 'imap.sina.com' },
];

/** 按邮箱账号后缀猜 SMTP/IMAP 主机;未知域名返回 undefined,交给用户手填。 */
export function guessMailHosts(user: string): { smtp: string; imap: string } | undefined {
  const hit = MAIL_PROVIDERS.find((p) => p.match.test(user));
  return hit ? { smtp: hit.smtp, imap: hit.imap } : undefined;
}
