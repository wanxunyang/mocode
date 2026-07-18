import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool, ToolRisk } from '../tools/types.js';
import { promptIntervention, type InterventionResult } from '../ui/intervention.js';
import { config } from '../config/index.js';
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
        .map(([key, item]) => [key, stable(item)])
    );
  }
  return value;
}

function canonicalProjectRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** A grant is bound to the actual command or logical resources, never merely a tool name. */
export function permissionFingerprint(tool: Tool, args: Record<string, unknown>): string {
  let subject: unknown;
  if (tool.name === 'run_command' && typeof args.command === 'string') {
    subject = { command: args.command.trim() };
  } else {
    let resources: string[] | undefined;
    try {
      resources = tool.capabilities?.resources?.(args).filter(Boolean).sort();
    } catch {
      resources = undefined;
    }
    // File mutations may be granted by their concrete resource. Coarse resources such as
    // "workspace" must retain arguments so task/process-like calls cannot become tool-wide.
    subject = resources?.length && typeof args.path === 'string'
      ? { resources }
      : stable(args);
  }
  return crypto.createHash('sha256').update(JSON.stringify(subject)).digest('hex');
}

function validGrant(value: unknown): value is PermissionGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as PermissionGrant;
  return typeof grant.tool === 'string'
    && typeof grant.fingerprint === 'string'
    && grant.fingerprint.length > 0
    && (grant.scope === 'project' || grant.scope === 'session' || grant.scope === 'once');
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
    permanentToolAllows = parsed.version === PERMISSIONS_VERSION && Array.isArray(parsed.alwaysAllowTools)
      ? new Set(parsed.alwaysAllowTools.filter(
        (tool): tool is string => typeof tool === 'string' && tool.length > 0
      ))
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
  if (typeof args.prompt === 'string') {
    const preview = args.prompt.slice(0, 100);
    lines.push(t('permission.task', { value: `${preview}${args.prompt.length > 100 ? '…' : ''}` }));
  }
  return lines.length ? lines.join('\n') : t('permission.noArgs');
}

function matches(grant: PermissionGrant, tool: string, fingerprint: string, projectRoot: string): boolean {
  return grant.tool === tool
    && grant.fingerprint === fingerprint
    && (grant.scope !== 'project' || grant.projectRoot === projectRoot);
}

export async function checkPermission(
  tool: Tool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  options: PermissionCheckOptions = {}
): Promise<'allow' | 'deny'> {
  if (!config.permissionEnabled || getToolRisk(tool) === 'safe') return 'allow';
  if (signal?.aborted) return 'deny';

  loadPermanent();
  if (permanentToolAllows.has(tool.name)) return 'allow';

  const fingerprint = permissionFingerprint(tool, args);
  const projectRoot = canonicalProjectRoot(options.projectRoot ?? getSandboxRoot() ?? process.cwd());
  if (sessionGrants.some((grant) => matches(grant, tool.name, fingerprint, projectRoot))) return 'allow';
  if (permanentGrants.some((grant) => matches(grant, tool.name, fingerprint, projectRoot))) return 'allow';

  // CI/pipes must fail closed. Operators can deliberately restore unattended behavior.
  if (!process.stdin.isTTY && !config.permissionNonInteractiveAllow && !options.prompt) return 'deny';
  if (signal?.aborted) return 'deny';

  const onceOption = t('permission.allow');
  const sessionOption = t('permission.allowSessionResource');
  const projectOption = t('permission.allowProjectResource');
  const alwaysOption = t('permission.allowForever');
  const denyOption = t('permission.deny');
  const dangerous = getToolRisk(tool) === 'dangerous';
  const choices = [onceOption, sessionOption, projectOption, alwaysOption, denyOption];

  const result = await (options.prompt ?? promptIntervention)({
    type: 'choice',
    title: dangerous
      ? t('permission.dangerTitle', { tool: tool.name })
      : t('permission.confirmTitle', { tool: tool.name }),
    detail: summarizeArgs(args) + (dangerous ? `\n\n${t('permission.dangerWarning')}` : ''),
    options: choices,
    allowCustom: false,
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
  permanentGrants = permanentGrants.filter((grant) =>
    grant.tool !== toolName || (fingerprint !== undefined && grant.fingerprint !== fingerprint)
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
  return [...new Set([
    ...permanentGrants.map((grant) => grant.tool),
    ...permanentToolAllows,
  ])].sort();
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
