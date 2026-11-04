/**
 * 历史 token 用量回填。
 *
 * 全局账本(~/.mocode/usage-daily.jsonl)从实时记账功能上线起才有数据;本模块把各工作区
 * 里**旧会话**的会话级 usage.jsonl 一次性补进全局账本,/usage 即可看到历史。
 *
 * 扫描来源:全局工作区注册表(~/.mocode/workspaces.jsonl,启动与 /cd 时登记)里的每个
 * 工作区,读 `<root>/.mocode/sessions/<id>/usage.jsonl`。
 *
 * 去重(两层,共同保证任意顺序重复执行都不双算):
 *  1. 行级 `trackedInGlobal`:实时记账上线后产生的 usage 行带此标记,回填直接跳过;
 *  2. 文件级断点 `~/.mocode/usage-import-state.json`:记录每个 usage 文件已导入的行数,
 *     重跑只导入新增的"未标记"行(覆盖"会话在升级前后都活跃"的时间窗口)。
 *
 * 历史记录缺真实时间戳/模型:日期与会话创建时间按 session 目录 id 的时间前缀推断
 * (本地时区),模型取 session.json 的 model(会话最后保存时的模型)。回填行标 source=backfill。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendGlobalUsage } from './global-usage.js';
import { readWorkspaceRegistry } from '../workspace/registry.js';
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.mocode', 'usage-import-state.json');

export interface BackfillOptions {
  /** 注册表之外额外扫描的工作区根(如当前工作区)。 */
  extraRoots?: string[];
  /** 断点状态文件路径(测试注入;默认 ~/.mocode/usage-import-state.json)。 */
  statePath?: string;
}

interface ImportState {
  /** 绝对路径(usage.jsonl)→ 已导入行数。 */
  files: Record<string, number>;
}

interface SessionUsageRow {
  phase?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  trackedInGlobal?: boolean;
}

export interface BackfillResult {
  workspaces: number;
  sessions: number;
  /** 实际追加进全局账本的 usage 行数。 */
  records: number;
  /** 因 trackedInGlobal 跳过的 live 行数。 */
  skippedTracked: number;
}

function readState(statePath: string): ImportState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ImportState;
    return { files: s && typeof s.files === 'object' ? s.files : {} };
  } catch {
    return { files: {} };
  }
}

function writeState(statePath: string, state: ImportState): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, statePath);
  } catch {
    // 状态写失败不致命:最坏是下次重跑时多扫一遍(行级标记仍防双算,见文件头)。
  }
}

/** session id 时间前缀 → 本地 ISO(无时区串,按机器本地时区)与本地日期;无法解析返回空。 */
function sessionIdTime(id: string): { isoLocal: string; day: string } | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3})-[a-f0-9]{8})?$/.exec(id);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, ms] = m;
  const day = `${y}-${mo}-${d}`;
  const isoLocal = `${day}T${h}:${mi}:${s}${ms ? `.${ms}` : ''}`;
  return { isoLocal, day };
}

/** 列一个工作区的会话目录 id(与 SessionStore.list 的目录识别同规则)。 */
function listSessionIds(root: string): string[] {
  const dir = path.join(root, '.mocode', 'sessions');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{8}-\d{6}(?:-\d{3}-[a-f0-9]{8})?$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readSessionModel(root: string, id: string): string {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.mocode', 'sessions', id, 'session.json'), 'utf8')) as {
      model?: unknown;
    };
    return typeof rec.model === 'string' ? rec.model : '';
  } catch {
    return '';
  }
}

/**
 * 执行历史回填。best-effort:单个工作区/会话失败不拖垮整体。
 * @param extraRoots 注册表之外额外扫描的工作区根(如当前工作区)。
 */
export function backfillGlobalUsage(opts: BackfillOptions = {}): BackfillResult {
  const extraRoots = opts.extraRoots ?? [];
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const roots = [
    ...new Set([...readWorkspaceRegistry().map((e) => e.root), ...extraRoots.map((r) => path.resolve(r))]),
  ];
  const state = readState(statePath);
  const result: BackfillResult = { workspaces: 0, sessions: 0, records: 0, skippedTracked: 0 };

  for (const root of roots) {
    const ids = listSessionIds(root);
    if (ids.length === 0) continue;
    result.workspaces++;
    for (const id of ids) {
      const file = path.join(root, '.mocode', 'sessions', id, 'usage.jsonl');
      let rows: string[];
      try {
        // 只保留非空行:游标按"已处理的记录行"计数,避开 split('\n') 末尾空串导致的错位。
        rows = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '');
      } catch {
        continue; // 该会话无 usage 文件
      }
      const before = state.files[file] ?? 0;
      // 断点只进不退:文件被截断重写(行数变少,轮转/手工)时从头来,否则只处理新增尾部。
      const start = before <= rows.length ? before : 0;
      const tinfo = sessionIdTime(id);
      const model = readSessionModel(root, id) || '(unknown)';
      let touchedSession = false;

      for (let i = start; i < rows.length; i++) {
        const line = rows[i].trim();
        let row: SessionUsageRow;
        try {
          row = JSON.parse(line) as SessionUsageRow;
        } catch {
          continue; // 损坏行跳过
        }
        touchedSession = true;
        // live 行已实时计入:只标记跳过,不重复导入。
        if (row.trackedInGlobal) {
          result.skippedTracked++;
          continue;
        }
        if (typeof row.inputTokens !== 'number' || typeof row.outputTokens !== 'number') continue;
        appendGlobalUsage({
          ts: tinfo?.isoLocal,
          day: tinfo?.day,
          workspace: root,
          model,
          phase: row.phase === 'compact' ? 'compact' : 'main',
          sessionId: id,
          source: 'backfill',
          input: row.inputTokens,
          output: row.outputTokens,
          cached: row.cachedTokens ?? 0,
          reasoning: row.reasoningTokens ?? 0,
          cacheCreation: row.cacheCreationTokens ?? 0,
        });
        result.records++;
      }

      // 游标推进到已处理的记录行数(JSONL 只追加,新行总在尾部)。
      if (rows.length !== before) state.files[file] = rows.length;
      if (touchedSession) result.sessions++;
    }
  }

  writeState(statePath, state);
  return result;
}
