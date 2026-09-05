import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool, ToolRisk } from '../tools/types.js';
import { promptIntervention, type InterventionResult } from '../ui/intervention.js';
import { config } from '../config/index.js';
import { readConfigFile, updateConfigKey } from '../config/file.js';
import { getSandboxRoot } from '../sandbox/index.js';
import { t } from '../i18n/index.js';

export type PermissionScope = 'once' | 'session' | 'project';

export interface PermissionGrant {
  tool: string;
  fingerprint: string;
  scope: PermissionScope;
  projectRoot?: string;
}

export interface PermissionCheckOptions {
  projectRoot?: string;
  /** Test seam; production uses the normal intervention panel. */
  prompt?: (request: Parameters<typeof promptIntervention>[0]) => Promise<InterventionResult>;
  /** Tests may keep project grants in memory instead of touching the user profile. */
  persistProjectGrant?: boolean;
}

const PERMISSIONS_PATH = path.join(os.homedir(), '.mocode', 'permissions.json');
const PERMISSIONS_VERSION = 3;
let permanentGrants: PermissionGrant[] = [];
let permanentToolAllows = new Set<string>();
let permanentLoaded = false;
const sessionGrants: PermissionGrant[] = [];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function canonicalProjectRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * computer 工具的 type/key 文本内容审查:
 * 命中 URL / 密码形态 / 支付关键词时,无论是否已授权都强制 once 级确认——
 * 这类文本是「把内容敲进任意应用」的载体,不能因 session/项目授权而放行后续所有输入。
 * 纯函数,独立可单测。
 */
export function computerTextNeedsReview(text: string): boolean {
  const s = text.toLowerCase();
  if (/https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i.test(s)) return true;
  if (/\b(pass(word)?|passwd|pwd|secret|token|api[_-]?key|credential)\b\s*[:=]/i.test(s)) return true;
  if (/\b(card\s*number|cvv|cvc|expiry)\b/i.test(s)) return true;
  // CJK 关键词没有 \b 词边界概念(\b 只在 \w 与非 \w 之间成立,中文不是 \w),用普通子串匹配。
  if (/信用卡|卡号|密码|支付|付款|验证码/.test(s)) return true;
  return false;
}

/** A grant is bound to the actual command or logical resources, never merely a tool name. */
export function permissionFingerprint(tool: Tool, args: Record<string, unknown>): string {
  let subject: unknown;
  if (tool.name === 'run_command' && typeof args.command === 'string') {
    subject = { command: args.command.trim() };
  } else if (tool.name === 'computer') {
    // computer:坐标/文本每次不同,进指纹会让每次点击都弹窗(功能上等同不可用)。
    // 按动作粒度授权:允许一次 left_click = 本会话允许任意坐标的左键。
    subject = { computer: typeof args.action === 'string' ? args.action : 'unknown' };
  } else {
    let resources: string[] | undefined;
    try {
      resources = tool.capabilities?.resources?.(args).filter(Boolean).sort();
    } catch {
      resources = undefined;
    }
    // File mutations may be granted by their concrete resource. Coarse resources such as
    // "workspace" must retain arguments so task/process-like calls cannot become tool-wide.
    subject = resources?.length && typeof args.path === 'string' ? { resources } : stable(args);
  }
  return crypto.createHash('sha256').update(JSON.stringify(subject)).digest('hex');
}

function validGrant(value: unknown): value is PermissionGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as PermissionGrant;
  return (
    typeof grant.tool === 'string' &&
    typeof grant.fingerprint === 'string' &&
    grant.fingerprint.length > 0 &&
    (grant.scope === 'project' || grant.scope === 'session' || grant.scope === 'once')
  );
}

function loadPermanent(): PermissionGrant[] {
  if (permanentLoaded) return permanentGrants;
  permanentLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(PERMISSIONS_PATH, 'utf8')) as {
      version?: unknown;
      grants?: unknown[];
      alwaysAllowTools?: unknown[];
    };
    permanentGrants = Array.isArray(parsed.grants)
      ? parsed.grants.filter(validGrant).filter((grant) => grant.scope === 'project')
      : [];
    // Only the explicit v3 field enables broad grants. The retired legacy allowForever
    // field remains ignored so upgrades cannot silently restore old authorization.
    permanentToolAllows =
      parsed.version === PERMISSIONS_VERSION && Array.isArray(parsed.alwaysAllowTools)
        ? new Set(parsed.alwaysAllowTools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0))
        : new Set();
  } catch {
    permanentGrants = [];
    permanentToolAllows = new Set();
  }
  return permanentGrants;
}

function savePermanent(): void {
  try {
    fs.mkdirSync(path.dirname(PERMISSIONS_PATH), { recursive: true });
    const data = {
      version: PERMISSIONS_VERSION,
      grants: permanentGrants,
      alwaysAllowTools: [...permanentToolAllows].sort(),
    };
    fs.writeFileSync(PERMISSIONS_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // A failed persistence write must never turn into broader authorization.
  }
}

export function getToolRisk(tool: Tool): ToolRisk {
  return tool.risk ?? 'safe';
}

function summarizeArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.path === 'string') lines.push(t('permission.path', { value: args.path }));
  if (typeof args.command === 'string') lines.push(t('permission.command', { value: args.command }));
  if (typeof args.action === 'string') {
    // computer 工具:动作名 + 坐标/文本预览(文本截断防长串刷屏)。
    const parts: string[] = [args.action];
    if (Array.isArray(args.coordinate)) parts.push(`@(${args.coordinate.join(', ')})`);
    if (typeof args.text === 'string' && args.text) {
      const preview = args.text.slice(0, 80);
      parts.push(`"${preview}${args.text.length > 80 ? '…' : ''}"`);
    }
    lines.push(t('permission.computerAction', { value: parts.join(' ') }));
  }
  if (typeof args.prompt === 'string') {
    const preview = args.prompt.slice(0, 100);
    lines.push(t('permission.task', { value: `${preview}${args.prompt.length > 100 ? '…' : ''}` }));
  }
  return lines.length ? lines.join('\n') : t('permission.noArgs');
}

function matches(grant: PermissionGrant, tool: string, fingerprint: string, projectRoot: string): boolean {
  return (
    grant.tool === tool &&
    grant.fingerprint === fingerprint &&
    (grant.scope !== 'project' || grant.projectRoot === projectRoot)
  );
}

export async function checkPermission(
  tool: Tool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  options: PermissionCheckOptions = {},
): Promise<'allow' | 'deny'> {
  if (!config.permissionEnabled || getToolRisk(tool) === 'safe') return 'allow';
  if (signal?.aborted) return 'deny';

  loadPermanent();
  if (permanentToolAllows.has(tool.name)) return 'allow';

  // computer 的 type/key 命中敏感内容(URL/密码/支付)时强制 once 级确认:
  // 不看任何授权缓存,也不提供 session/项目/永久授权选项——这类文本是「敲进任意应用」的载体,
  // 一旦放行不该沿用到下一次输入。
  const forceOnce =
    tool.name === 'computer' &&
    (args.action === 'type' || args.action === 'key') &&
    typeof args.text === 'string' &&
    computerTextNeedsReview(args.text);

  const fingerprint = permissionFingerprint(tool, args);
  const projectRoot = canonicalProjectRoot(options.projectRoot ?? getSandboxRoot() ?? process.cwd());
  if (!forceOnce) {
    if (sessionGrants.some((grant) => matches(grant, tool.name, fingerprint, projectRoot))) return 'allow';
    if (permanentGrants.some((grant) => matches(grant, tool.name, fingerprint, projectRoot))) return 'allow';
  }

  // CI/pipes must fail closed. Operators can deliberately restore unattended behavior.
  if (!process.stdin.isTTY && !config.permissionNonInteractiveAllow && !options.prompt) return 'deny';
  if (signal?.aborted) return 'deny';

  const onceOption = t('permission.allow');
  const sessionOption = t('permission.allowSessionResource');
  const projectOption = t('permission.allowProjectResource');
  const alwaysOption = t('permission.allowForever');
  const denyOption = t('permission.deny');
  const dangerous = getToolRisk(tool) === 'dangerous';
  const choices = forceOnce
    ? [onceOption, denyOption]
    : [onceOption, sessionOption, projectOption, alwaysOption, denyOption];

  // 新手首次审批引导:第一次弹出确认面板时附一段说明(每个用户只出现一次,
  // ~/.mocode/config 的 onboarding_approval_hint 标记;读写失败静默,不阻断审批)。
  let detail = summarizeArgs(args) + (dangerous ? `\n\n${t('permission.dangerWarning')}` : '');
  if (forceOnce) detail += `\n\n${t('permission.computerSensitiveReview')}`;
  const ONBOARDING_KEY = 'onboarding_approval_hint';
  try {
    if (!readConfigFile()[ONBOARDING_KEY]) {
      detail += `\n\n${t('permission.firstTimeHint')}`;
      updateConfigKey(ONBOARDING_KEY, '1');
    }
  } catch {
    // 标记读/写失败 → 视为未展示过:多提示一次无害,少提示也只是回归现状。
  }

  const result = await (options.prompt ?? promptIntervention)({
    type: 'choice',
    title: dangerous
      ? t('permission.dangerTitle', { tool: tool.name })
      : t('permission.confirmTitle', { tool: tool.name }),
    detail,
    options: choices,
    allowCustom: false,
    // dangerous 默认落在「拒绝」:面板一弹出就高亮"允许一次"时,用户顺手回车就把命令放出去了。
    // 放行必须是一次明确的选择(↑↓ 移到某一项,或按数字键),而不是默认项的惯性。
    defaultIndex: dangerous ? choices.indexOf(denyOption) : 0,
  });
  if (signal?.aborted || result.action === 'cancelled' || result.value === denyOption) return 'deny';

  if (result.value === sessionOption) {
    sessionGrants.push({ tool: tool.name, fingerprint, scope: 'session' });
  } else if (result.value === projectOption) {
    const grant: PermissionGrant = { tool: tool.name, fingerprint, scope: 'project', projectRoot };
    permanentGrants = permanentGrants.filter((item) => !matches(item, tool.name, fingerprint, projectRoot));
    permanentGrants.push(grant);
    if (options.persistProjectGrant !== false) savePermanent();
  } else if (result.value === alwaysOption) {
    permanentToolAllows.add(tool.name);
    if (options.persistProjectGrant !== false) savePermanent();
  }
  return 'allow';
}

export function revokePermanentAllow(toolName: string, fingerprint?: string): void {
  loadPermanent();
  permanentGrants = permanentGrants.filter(
    (grant) => grant.tool !== toolName || (fingerprint !== undefined && grant.fingerprint !== fingerprint),
  );
  if (fingerprint === undefined) permanentToolAllows.delete(toolName);
  savePermanent();
}

export function revokePermanentToolAllow(toolName: string): void {
  loadPermanent();
  permanentToolAllows.delete(toolName);
  savePermanent();
}

export function listPermanentGrants(): PermissionGrant[] {
  return loadPermanent().map((grant) => ({ ...grant }));
}

export function listPermanentToolAllows(): string[] {
  loadPermanent();
  return [...permanentToolAllows].sort();
}

/** Compatibility API: returns tools having any persistent resource or tool-wide grant. */
export function listPermanentAllow(): string[] {
  loadPermanent();
  return [...new Set([...permanentGrants.map((grant) => grant.tool), ...permanentToolAllows])].sort();
}

export function clearSessionPermissionGrants(): void {
  sessionGrants.length = 0;
}

export function resetPermissionGrantsForTests(): void {
  sessionGrants.length = 0;
  permanentGrants = [];
  permanentToolAllows = new Set();
  permanentLoaded = true;
}
