// 具名 Bot 存储：一个 Bot = 岗位系统提示 + 可选工具白名单 + 可选沙箱范围。
//
// 两级存储（与 AGENTS.md 发现规则同风格）：
// - 全局：~/.mocode/bots/<name>.json
// - 项目：<sandboxRoot>/.mocode/bots/<name>.json
// 合并时全局先、项目后，项目同名覆盖全局。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSandboxRoot } from '../sandbox/index.js';

export interface BotRecord {
  /** 唯一标识，kebab-case，1-32 字符。 */
  name: string;
  /** 岗位职责一句话（列表展示用）。 */
  description: string;
  /** 岗位系统提示：角色、职责、工作规范、输出要求。运行时置于基础约定之前。 */
  systemPrompt: string;
  /**
   * 工具白名单（精确工具名）。undefined / 空数组 = 不限制。
   * MCP 工具用 mcp__<server>__<tool> 全名。
   */
  tools?: string[];
  /** 沙箱范围相对路径（相对 bot 定义所在工作区）；不设 = 当前 sandboxRoot。 */
  sandboxPath?: string;
  scope: 'global' | 'project';
  createdAt: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function globalBotsDir(): string {
  return path.join(os.homedir(), '.mocode', 'bots');
}

export function projectBotsDir(): string {
  return path.join(getSandboxRoot() ?? process.cwd(), '.mocode', 'bots');
}

function botPath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`bad bot name "${name}": use 1-32 chars, lowercase letters/digits/dash, cannot start with dash`);
  }
}

/** 校验并落盘一个 bot（scope 决定写全局还是项目）。 */
export function saveBot(input: Omit<BotRecord, 'scope' | 'createdAt'> & { scope?: 'global' | 'project' }): BotRecord {
  assertValidName(input.name);
  if (!input.systemPrompt.trim()) throw new Error('bot systemPrompt must not be empty');
  const scope = input.scope ?? 'project';
  const record: BotRecord = {
    name: input.name,
    description: input.description ?? '',
    systemPrompt: input.systemPrompt,
    ...(input.tools && input.tools.length ? { tools: input.tools } : {}),
    ...(input.sandboxPath ? { sandboxPath: input.sandboxPath } : {}),
    scope,
    createdAt: new Date().toISOString(),
  };
  const dir = scope === 'global' ? globalBotsDir() : projectBotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = botPath(dir, record.name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return record;
}

function readOne(dir: string, file: string): BotRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as BotRecord;
  } catch {
    return null;
  }
}

function readDir(dir: string): BotRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BotRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const rec = readOne(dir, f);
    if (rec) out.push(rec);
  }
  return out;
}

/** 列出全部 bot（全局 + 项目，项目同名覆盖）。 */
export function listBots(): BotRecord[] {
  const byName = new Map<string, BotRecord>();
  for (const b of readDir(globalBotsDir())) byName.set(b.name, b);
  for (const b of readDir(projectBotsDir())) byName.set(b.name, b);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getBot(name: string): BotRecord | null {
  // 项目优先（覆盖语义）：先找项目再找全局。
  const project = readOne(projectBotsDir(), `${name}.json`);
  if (project) return project;
  return readOne(globalBotsDir(), `${name}.json`);
}

export function deleteBot(name: string, scope: 'global' | 'project' = 'project'): boolean {
  assertValidName(name);
  try {
    fs.rmSync(botPath(scope === 'global' ? globalBotsDir() : projectBotsDir(), name));
    return true;
  } catch {
    return false;
  }
}
