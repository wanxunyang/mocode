/**
 * 记忆审计日志(R8 用户主权 / R16 投毒防御的底座)。
 *
 * 为什么需要它:记忆是**自动写入**的。用户说「删掉」时,真正该回答的两个问题不是
 * 「删了吗」,而是「删了什么」和「谁让它进来的」。没有审计行,这两件事都无从追溯——
 * 批量删除尤其危险:一次 `--match 服务器` 就可能带走十条结论,事后连名单都重建不出来。
 *
 * 为什么是独立文件而不是写进 memory.jsonl:审计行不是记忆,不该进检索池、不该被
 * `memory_search` 命中、也不该被 GC 衰减。混进主库还得让所有读路径都学会过滤它。
 *
 * 叶子模块约定:只依赖 node 内置。不 import config / store / agent / llm。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 一条审计记录。字段刻意扁平而少:`ids` 只记被影响的 id,正文一个字都不留。 */
export interface AuditRecord {
  /** 发生时刻(ISO)。 */
  at: string;
  /** 动作类型。新增动作时同步扩这个联合,而不是塞进 detail 字符串。 */
  action: 'forget' | 'purge' | 'pause' | 'resume' | 'import' | 'export';
  /** 人读的一句话。**不得包含记忆正文**——审计文件同样落在磁盘上。 */
  detail: string;
  /** 受影响的记忆 id(R8.2 批量删除时是完整名单)。 */
  ids?: string[];
  /** 作用域(批量操作时记录,便于事后判断删对了哪个库)。 */
  scope?: string;
}

/**
 * 审计文件路径:`<cwd>/.mocode/memory-audit.jsonl`。
 *
 * 跟着**项目**走而不是全局:记忆写入大多是项目级的,而用户检查「这个仓库记住了什么、
 * 删过什么」时看的就是仓库目录。全局库的删除同样记在这里——单机单用户,一处日志
 * 比按 scope 拆两个文件更好查。
 */
export function auditPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-audit.jsonl');
}

/**
 * 追加一条审计。**静默失败**:审计是可观测性产物,绝不因为磁盘满/权限不足
 * 而让一次删除或一次导出失败——那会把「用户想删东西」变成「删不掉」。
 */
export function appendAudit(rec: AuditRecord): void {
  try {
    const p = auditPath();
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // 静默:见上
  }
}

/** 读回审计记录(最近的在后)。缺失/损坏返空数组,单行坏不影响其余。 */
export function readAudit(limit = 50): AuditRecord[] {
  const p = auditPath();
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as AuditRecord;
      if (o && typeof o.action === 'string' && typeof o.at === 'string') out.push(o);
    } catch {
      continue;
    }
  }
  return out.slice(-Math.max(1, limit));
}
