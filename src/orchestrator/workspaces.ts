// 整机工作区清单：Super Agent 需要知道「这台机器上哪里跑过 mocode」才能派活。
//
// 两个来源：
//   1. 全局注册表 `~/.mocode/workspaces.jsonl`（每次启动/`/cd` 自动登记，见 src/workspace/registry.ts）；
//   2. 显式 `--scan-roots`：在这些根下做有限深度扫描，找带 `.mocode/sessions` 的目录。
//
// 刻意不扫全盘：深度上限、跳过 node_modules / .git / dist 等，避免变成一次磁盘遍历。
// 目录消失了不删记录，只标 `exists: false`——派活前必须校验存在性。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRepositoryDirty, gitTopLevel } from '../jobs/worktree.js';
import { readWorkspaceRegistry } from '../workspace/registry.js';
import { listOrchestrations } from './store.js';

/** 扫描时整目录跳过的名字（不区分层级）。 */
const SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-tests',
  'build',
  'out',
  'target',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

const MAX_SCAN_DEPTH = 3;

export interface WorkspaceSession {
  id: string;
  createdAt?: string;
  firstUser?: string;
  archived?: boolean;
}

export interface WorkspaceLaneRef {
  runId: string;
  laneId: string;
  mode: string;
  status: 'open' | 'closed';
  sessionId?: string;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  source: 'registry' | 'scan' | 'arg';
  exists: boolean;
  git: boolean;
  branch?: string;
  dirty?: boolean;
  sessions: WorkspaceSession[];
  lanes: WorkspaceLaneRef[];
}

export interface ListWorkspacesOptions {
  /** 额外总是包含的根（通常是 cwd）。 */
  roots?: readonly string[];
  /** 在这些根下做有限深度扫描。 */
  scanRoots?: readonly string[];
  /** 是否读取会话列表（默认 true；`--json` 大量输出时可关）。 */
  includeSessions?: boolean;
  /** 是否关联编排 lane（默认 true）。 */
  includeLanes?: boolean;
  maxDepth?: number;
}

function sessionList(root: string): WorkspaceSession[] {
  const dir = path.join(root, '.mocode', 'sessions');
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .slice(0, 12)
    .map((id) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, id, 'session.json'), 'utf8')) as {
          createdAt?: string;
          history?: Array<{ role?: string; content?: unknown }>;
        };
        const first = record.history?.find((message) => message.role === 'user');
        return {
          id,
          createdAt: record.createdAt,
          firstUser: typeof first?.content === 'string' ? first.content.slice(0, 80) : undefined,
        };
      } catch {
        return { id };
      }
    });
}

function laneRefs(root: string): WorkspaceLaneRef[] {
  let runs;
  try {
    runs = listOrchestrations(root);
  } catch {
    return [];
  }
  const refs: WorkspaceLaneRef[] = [];
  for (const run of runs) {
    if (run.status === 'completed' || run.status === 'cancelled') continue;
    for (const lane of Object.values(run.lanes ?? {})) {
      if (path.resolve(lane.workspaceRoot) !== path.resolve(root)) continue;
      refs.push({
        runId: run.id,
        laneId: lane.id,
        mode: lane.mode ?? 'worktree',
        status: lane.closed ? 'closed' : 'open',
        sessionId: lane.sessionId,
      });
    }
  }
  return refs;
}

function describeWorkspace(
  root: string,
  source: WorkspaceInfo['source'],
  options: ListWorkspacesOptions,
): WorkspaceInfo {
  const absolute = path.resolve(root);
  const exists = fs.existsSync(absolute);
  const top = exists ? gitTopLevel(absolute) : null;
  const info: WorkspaceInfo = {
    root: absolute,
    name: path.basename(absolute) || absolute,
    source,
    exists,
    git: Boolean(top && path.resolve(top) === absolute),
    sessions: options.includeSessions === false ? [] : sessionList(absolute),
    lanes: options.includeLanes === false ? [] : laneRefs(absolute),
  };
  if (info.git) {
    info.dirty = gitRepositoryDirty(absolute);
    try {
      const head = fs.readFileSync(path.join(absolute, '.git', 'HEAD'), 'utf8').trim();
      info.branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 8);
    } catch {
      // worktree 的 .git 是文件，读不到分支就留空。
    }
  }
  return info;
}

/** 有限深度扫描：只认带 `.mocode/sessions` 的目录。 */
function scanForWorkspaces(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, '.mocode', 'sessions'))) found.push(path.resolve(dir));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SCAN_SKIP.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}

export function listWorkspaces(options: ListWorkspacesOptions = {}): WorkspaceInfo[] {
  // 去重键用小写（Windows 大小写不敏感），但保留首次登记时的原始大小写用于展示与派活。
  const byRoot = new Map<string, { root: string; source: WorkspaceInfo['source'] }>();
  const add = (root: string, source: WorkspaceInfo['source']): void => {
    const absolute = path.resolve(root);
    const key = absolute.toLowerCase();
    if (!byRoot.has(key)) byRoot.set(key, { root: absolute, source });
  };
  for (const entry of readWorkspaceRegistry()) add(entry.root, 'registry');
  for (const root of options.scanRoots ?? []) {
    for (const found of scanForWorkspaces(root, options.maxDepth ?? MAX_SCAN_DEPTH)) add(found, 'scan');
  }
  for (const root of options.roots ?? []) {
    if (fs.existsSync(root)) add(root, 'arg');
  }
  return [...byRoot.values()]
    .map(({ root, source }) => describeWorkspace(root, source, options))
    .sort((a, b) => Number(b.exists) - Number(a.exists) || a.root.localeCompare(b.root));
}

export function formatWorkspaces(list: readonly WorkspaceInfo[]): string {
  if (list.length === 0) return 'No known workspaces. Run mocode inside a project, or pass --scan-roots <dir>.\n';
  const lines: string[] = [];
  for (const item of list) {
    const flags = [
      item.exists ? '' : 'missing',
      item.git ? `git:${item.branch ?? '?'}${item.dirty ? '*' : ''}` : 'no-git',
    ].filter(Boolean);
    lines.push(`${item.root}  [${flags.join(' ')}]`);
    const detail: string[] = [];
    if (item.sessions.length > 0) {
      const latest = item.sessions[0];
      const preview = latest.firstUser ? ` "${latest.firstUser}"` : '';
      detail.push(`${item.sessions.length} recent session(s), latest ${latest.id}${preview}`);
    } else {
      detail.push('no sessions');
    }
    for (const lane of item.lanes) detail.push(`lane ${lane.laneId} (${lane.mode}, ${lane.status}) run ${lane.runId}`);
    lines.push(`    ${detail.join(' · ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function defaultScanRoots(): string[] {
  // 只给「用户主目录下一层」这种合理默认，不递归全盘。
  return [os.homedir()];
}
