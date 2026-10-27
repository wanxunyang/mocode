/**
 * 邮件远程介入命令组:/mail · /mail setup · /mail test · /mail on|off
 *
 *  - /mail         查看配置与启用状态(不回显密码)
 *  - /mail setup   在 REPL 内交互式配置账号/应用密码/SMTP/IMAP(常见邮箱主机自动推导)
 *  - /mail test    发一封测试邮件 + IMAP 登录自检,验证 SMTP/IMAP 连通性
 *  - /mail on|off  启停邮件提醒;运行时立即生效并持久化到全局配置
 *
 * 与 `mocode config` 向导写同一份全局配置(~/.mocode/config),两条入口等价;
 * 这里用介入面板的 input 模式逐项收集,无需退出 TUI。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { t } from '../../i18n/index.js';
import { readConfigFile, writeConfigKeys, updateConfigKey } from '../../config/file.js';
import { getMailStatus, sendTestMail, resetMailConfigCache } from '../../mail/index.js';
import { guessMailHosts } from '../../mail/providers.js';
import { promptIntervention, type InterventionResult } from '../../ui/intervention.js';
import { unhandled, next, type CommandHandler } from './types.js';

function maskSecret(s: string): string {
  return s ? '••••••' : '';
}

/** 弹一个单行输入面板;取消返回 null,提交返回去空白文本(空串=接受默认的语义由调用方按 seed 判断)。 */
async function askInput(title: string, detail: string, seed = ''): Promise<string | null> {
  const res: InterventionResult = await promptIntervention({ type: 'input', title, detail, seed });
  if (res.action === 'cancelled') return null;
  return (res.value ?? '').trim();
}

/** /mail:配置与状态概览。 */
function renderStatus(): string {
  resetMailConfigCache(); // 读最新 env/配置,不被本进程缓存钉住
  const { cfg, enabled } = getMailStatus();
  const lines: string[] = [];
  if (!cfg) {
    lines.push(`${ui.dim}${t('mail.notConfigured')}${ui.reset}`, `${ui.dim}${t('mail.howToConfigure')}${ui.reset}`);
    return lines.join('\n') + '\n';
  }
  const state = enabled ? `${ui.green}${t('mail.stateOn')}${ui.reset}` : `${ui.yellow}${t('mail.stateOff')}${ui.reset}`;
  lines.push(`${ui.accent}${t('mail.title')}${ui.reset}  ${state}`);
  lines.push(`  ${t('mail.fieldAccount')}: ${cfg.user}`);
  lines.push(`  ${t('mail.fieldTo')}: ${cfg.to}`);
  lines.push(`  ${t('mail.fieldPassword')}: ${maskSecret(cfg.pass)}`);
  lines.push(
    `  SMTP: ${cfg.smtpHost}:${cfg.smtpPort}${cfg.smtpSecure ? ' (TLS)' : ''}    IMAP: ${cfg.imapHost}:${cfg.imapPort}${cfg.imapSecure ? ' (TLS)' : ''}`,
  );
  lines.push(
    `  ${t('mail.fieldTiming', { idle: Math.round(cfg.idleMs / 1000), poll: Math.round(cfg.pollMs / 1000) })}`,
  );
  lines.push('');
  lines.push(`${ui.dim}/mail setup · /mail test · /mail on · /mail off${ui.reset}`);
  return lines.join('\n') + '\n';
}

function isMailLine(line: string): boolean {
  return line === '/mail' || line.startsWith('/mail ');
}

export const mailCommands: CommandHandler[] = [
  // 组内更具体的子命令排在前:setup → test → on/off → 兜底状态。
  async (ctx) => {
    if (ctx.line !== '/mail setup' && ctx.line !== '/mail config') return unhandled();

    const cur = readConfigFile();
    // 1) 账号(预填现值)
    const user = await askInput(t('mail.setupAccount'), t('mail.setupAccountHint'), cur.MOCODE_MAIL_USER ?? '');
    if (user === null) {
      layout.contentWrite(`${ui.dim}${t('mail.setupCancelled')}${ui.reset}\n`);
      return next();
    }
    if (!user) {
      layout.contentWrite(`${ui.yellow}${t('mail.setupNeedAccount')}${ui.reset}\n`);
      return next();
    }

    // 2) 应用密码(本地终端输入,会回显;预填值仅在保留时用,不展示明文)
    const pass = await askInput(t('mail.setupPass'), t('mail.setupPassHint'), '');
    if (pass === null) {
      layout.contentWrite(`${ui.dim}${t('mail.setupCancelled')}${ui.reset}\n`);
      return next();
    }
    const finalPass = pass || cur.MOCODE_MAIL_PASS || '';
    if (!finalPass) {
      layout.contentWrite(`${ui.yellow}${t('mail.setupNeedPass')}${ui.reset}\n`);
      return next();
    }

    // 3) SMTP / IMAP:按账号后缀猜默认,允许覆盖
    const guessed = guessMailHosts(user);
    const smtpDefault = cur.MOCODE_SMTP_HOST ?? guessed?.smtp ?? '';
    const imapDefault = cur.MOCODE_IMAP_HOST ?? guessed?.imap ?? '';
    const smtpHost = (await askInput(t('mail.setupSmtp'), t('mail.setupHostHint'), smtpDefault)) ?? null;
    if (smtpHost === null) {
      layout.contentWrite(`${ui.dim}${t('mail.setupCancelled')}${ui.reset}\n`);
      return next();
    }
    const finalSmtp = smtpHost || smtpDefault;
    const imapHost = (await askInput(t('mail.setupImap'), t('mail.setupHostHint'), imapDefault)) ?? null;
    if (imapHost === null) {
      layout.contentWrite(`${ui.dim}${t('mail.setupCancelled')}${ui.reset}\n`);
      return next();
    }
    const finalImap = imapHost || imapDefault;
    if (!finalSmtp || !finalImap) {
      layout.contentWrite(`${ui.yellow}${t('mail.setupNeedHosts')}${ui.reset}\n`);
      return next();
    }

    // 4) 持久化(合并写,保留其它键)+ 写 env 让本会话立即生效。
    writeConfigKeys({
      MOCODE_MAIL_ENABLED: 'true',
      MOCODE_MAIL_USER: user,
      MOCODE_MAIL_PASS: finalPass,
      MOCODE_MAIL_TO: cur.MOCODE_MAIL_TO ?? user,
      MOCODE_SMTP_HOST: finalSmtp,
      MOCODE_IMAP_HOST: finalImap,
      MOCODE_SMTP_PORT: cur.MOCODE_SMTP_PORT ?? '465',
      MOCODE_IMAP_PORT: cur.MOCODE_IMAP_PORT ?? '993',
    });
    Object.assign(process.env, {
      MOCODE_MAIL_ENABLED: 'true',
      MOCODE_MAIL_USER: user,
      MOCODE_MAIL_PASS: finalPass,
      MOCODE_MAIL_TO: process.env.MOCODE_MAIL_TO ?? user,
      MOCODE_SMTP_HOST: finalSmtp,
      MOCODE_IMAP_HOST: finalImap,
    });
    resetMailConfigCache();
    layout.contentWrite(`${ui.green}${t('mail.setupSaved')}${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}${t('mail.setupTestHint')}${ui.reset}\n`);
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/mail test') return unhandled();
    const { cfg } = getMailStatus();
    if (!cfg) {
      layout.contentWrite(`${ui.dim}${t('mail.notConfigured')} ${t('mail.howToConfigure')}${ui.reset}\n`);
      return next();
    }
    layout.contentWrite(`${ui.dim}${t('mail.testing')}${ui.reset}\n`);
    void sendTestMail().then((r) => {
      if (r.smtp === 'ok' && r.imap === 'ok') {
        layout.contentWrite(`${ui.green}${t('mail.testOk')}${ui.reset}\n`);
      } else {
        const parts = [
          `SMTP ${r.smtp === 'ok' ? 'OK' : 'FAIL'}`,
          `IMAP ${r.imap === 'ok' ? 'OK' : r.imap === 'skipped' ? 'SKIP' : 'FAIL'}`,
        ];
        layout.contentWrite(`${ui.yellow}${t('mail.testFail', { parts: parts.join(' · ') })}${ui.reset}\n`);
        if (r.error) layout.contentWrite(`${ui.dim}${r.error}${ui.reset}\n`);
      }
    });
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/mail on' && ctx.line !== '/mail off') return unhandled();
    const { cfg } = getMailStatus();
    if (!cfg) {
      layout.contentWrite(`${ui.dim}${t('mail.notConfigured')} ${t('mail.howToConfigure')}${ui.reset}\n`);
      return next();
    }
    const enable = ctx.line === '/mail on';
    // 运行时立即生效(下一个介入即采用):写 env + 清邮件模块缓存;并持久化到全局配置。
    process.env.MOCODE_MAIL_ENABLED = enable ? 'true' : 'false';
    resetMailConfigCache();
    updateConfigKey('MOCODE_MAIL_ENABLED', enable ? 'true' : 'false');
    layout.contentWrite(
      enable ? `${ui.green}${t('mail.enabledNow')}${ui.reset}\n` : `${ui.yellow}${t('mail.disabledNow')}${ui.reset}\n`,
    );
    return next();
  },
  (ctx) => {
    if (!isMailLine(ctx.line)) return unhandled();
    // /mail 或无法识别的子参数:都显示状态,并对未知子参数给一行用法提示。
    if (ctx.line.trim() !== '/mail') {
      layout.contentWrite(`${ui.dim}${t('mail.unknownSub')}${ui.reset}\n`);
    }
    layout.contentWrite(renderStatus());
    return next();
  },
];
