// skill 信任门禁(执行面的安全前置)。
// 来源策略:
//  - builtin:恒信任(随 mocode 发布)。
//  - user(~/.claude|.mocode/skills):免门禁(用户自己放的)。
//  - project(<cwd>/.mocode/skills):很可能来自 git clone,首次使用执行面时一次性确认;
//    记录 sha256(SKILL.md + scripts/** + references/**),内容变更 → 失效重问。
//
// 非 TTY(管道 / CI / host 嵌入)严格失败关闭:未信任的 project skill 执行面一律拒绝,
// 对齐 Snyk 关于注册表 skill 携带恶意载荷的数据(设计文档 §1.4)。

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Skill } from './discover.js';
import { promptIntervention } from '../ui/intervention.js';
import * as layout from '../ui/layout.js';

const TRUST_PATH = join(homedir(), '.mocode', 'skill-trust.json');

interface TrustRecord {
  hash: string;
  trustedAt: number;
}

let trustCache: Record<string, TrustRecord> | null = null;

function loadTrust(): Record<string, TrustRecord> {
  if (trustCache) return trustCache;
  try {
    const parsed = JSON.parse(readFileSync(TRUST_PATH, 'utf8'));
    trustCache = parsed && typeof parsed === 'object' ? (parsed as Record<string, TrustRecord>) : {};
  } catch {
    trustCache = {};
  }
  return trustCache;
}

function saveTrust(rec: Record<string, TrustRecord>): void {
  trustCache = rec;
  try {
    mkdirSync(dirname(TRUST_PATH), { recursive: true });
    writeFileSync(TRUST_PATH, JSON.stringify(rec, null, 2));
  } catch {
    // 写入失败(权限 / 只读 home)不阻断,仅本次会话内存态生效。
  }
}

/** 递归收集目录下所有文件(绝对路径)。 */
function collectFiles(dir: string, out: string[]): void {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else out.push(p);
  }
}

/** 计算 skill 内容哈希(SKILL.md + scripts/** + references/**)。 */
export function computeSkillHash(skill: Skill): string {
  const h = createHash('sha256');
  const files: string[] = [skill.skillMdPath];
  for (const sub of ['scripts', 'references']) {
    const d = join(skill.dir, sub);
    if (existsSync(d)) collectFiles(d, files);
  }
  files.sort();
  for (const f of files) {
    try {
      h.update(f + '\0');
      h.update(readFileSync(f));
    } catch {
      // 单文件读失败:跳过该项(哈希覆盖其余内容,足够检测变更)。
    }
  }
  return h.digest('hex');
}

/** 该 skill 当前是否已受信任(内容未变)。非 project 来源恒 true。 */
export function isSkillTrusted(skill: Skill): boolean {
  if (skill.origin !== 'project') return true;
  const rec = loadTrust()[skill.name];
  if (!rec) return false;
  return rec.hash === computeSkillHash(skill);
}

function recordTrust(skill: Skill): void {
  const rec = loadTrust();
  rec[skill.name] = { hash: computeSkillHash(skill), trustedAt: Date.now() };
  saveTrust(rec);
}

export type TrustDecision = 'trusted' | 'once' | 'deny';

/**
 * 面向用户的信任确认。非 TTY 直接拒绝(失败关闭)。
 * 返回 'trusted'(记录哈希) / 'once'(仅本次) / 'deny'。
 */
export async function promptTrust(skill: Skill): Promise<TrustDecision> {
  if (!layout.isActive()) return 'deny';
  const res = await promptIntervention({
    type: 'choice',
    title: `信任并运行 skill "${skill.name}"?`,
    detail:
      `${skill.dir}\n` +
      `该 skill 配置了执行面(fork / scripts / allowed-tools)。首次执行需确认;` +
      `其 SKILL.md / scripts / references 内容变更后将重新询问。`,
    options: [
      { label: '信任并运行', detail: '记录内容哈希,今后自动信任' },
      { label: '仅本次运行', detail: '本会话执行一次,不记录' },
      { label: '拒绝', detail: '不执行' },
    ],
    allowCustom: false,
  });
  if (res.action === 'cancelled') return 'deny';
  const v = res.value ?? '拒绝';
  if (v.startsWith('信任')) {
    recordTrust(skill);
    return 'trusted';
  }
  if (v.startsWith('仅本次')) return 'once';
  return 'deny';
}

/**
 * 执行面前的信任检查:已信任返回 true;未信任则弹确认。
 * 非 project / 已信任 → true;未信任 project 在非 TTY → false;用户拒绝 → false。
 */
export async function ensureSkillTrust(skill: Skill): Promise<boolean> {
  if (skill.origin !== 'project') return true;
  if (isSkillTrusted(skill)) return true;
  const decision = await promptTrust(skill);
  return decision !== 'deny';
}
