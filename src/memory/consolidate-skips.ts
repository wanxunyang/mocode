/**
 * R11.5 巩固跳过记忆:同一批情节被模型判过「只是凑巧」之后,不要每轮再花钱问一遍。
 *
 * 存在理由(实测数据驱动的,不是预防性设计):真实库里 20 次巩固全部是
 * `巩固 0/1 组 跳过 1`,而跳过的理由从来没被记录(见 `reflect.ts` 的 `plan.skip` 分支),
 * 只能事后手工重放 11 条情节才发现分组信号全是 `看看 / 我看 / 功能 / 还是` 这类口语糊料。
 * 于是一边是每次真花 LLM 调用,一边是零收益且零证据。
 *
 * 这一层只解决成本,不解决判据:成员集合完全相同的组,输入提示词也完全相同,
 * 模型第二次给的答案不会比第一次更好。只要成员变了(有新情节并进来),签名就变,
 * 立刻重新问一次 —— 那是新证据,值得问。
 *
 * 叶子依赖:只依赖 node 内置 + write-gate。不 import episodic/reflect(= 环),
 * 签名由调用方用 `consolidationSignature()` 从成员 id 算出来传进来。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { memoryWriteBlockReason } from './write-gate.js';

/**
 * 状态文件条目上限。签名随成员组合增长,不封顶就会无限膨胀;
 * 50 条足够覆盖「最近几十个候选组」,更老的签名对应的情节多半早已衰减归档。
 */
const MAX_ENTRIES = 50;
/** 条目过期天数:超过这么久没再出现的签名,其成员情节基本都已进入归档区。 */
const EXPIRE_DAYS = 60;
/** 理由截断长度:它是日志/健康快照的注脚,不是正文。 */
const MAX_REASON_CHARS = 160;

/** 一个候选组的跳过状态。 */
export interface ConsolidationSkipEntry {
  /** 连续被判「凑巧」的次数。成功巩固或成员变动会重置。 */
  strikes: number;
  /** 最后一次判凑巧的时刻(ISO)。 */
  lastAt: string;
  /** 模型给的理由(截断)。这是「为什么这条通道不产出」唯一的证词。 */
  reason?: string;
  /** 判凑巧时的成员数,供 health 展示规模。 */
  members: number;
}

/** 巩固通道的累计计数与当前停问规模。 */
export interface ConsolidationSkipStats {
  /** 真正发过 LLM 请求的组数(累计)。 */
  asked: number;
  /** 其中模型判定「只是凑巧」的组数(累计)。`skipped/asked` 就是空转率。 */
  skipped: number;
  /** 因签名已停问而**省下**的请求次数(累计)。 */
  mutedHits: number;
  /** 当前处于停问状态的组数。 */
  muted: number;
  /** 最近一次跳过理由。 */
  lastReason: string | null;
  /** 最近一次跳过时刻。 */
  lastAt: string | null;
}

interface SkipsFile {
  schemaVersion: 1;
  updatedAt: string;
  totals: { asked: number; skipped: number; mutedHits: number };
  skips: Record<string, ConsolidationSkipEntry>;
}

const EMPTY_FILE: SkipsFile = {
  schemaVersion: 1,
  updatedAt: '',
  totals: { asked: 0, skipped: 0, mutedHits: 0 },
  skips: {},
};

function skipsPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-consolidate-skips.json');
}

/**
 * 组的签名 = 成员 id 排序拼接。
 *
 * 刻意用**精确成员集合**而不是「共享文件/词元」这类主题摘要:后者会随着情节池的噪声变化漂移,
 * 让「同一个组」时而被认出来时而被当成新组,停问就变成随机行为。成员集合是确定性的,
 * 而它恰好等价于「模型看到的提示词完全相同」这个真正决定答案的条件。
 */
export function consolidationSignature(ids: readonly string[]): string {
  return [...ids].sort().join('|');
}

/** 读状态文件(静默容错:缺失/损坏/坏字段 → 零值,永不抛)。 */
export function loadConsolidationSkips(): SkipsFile {
  try {
    const p = skipsPath();
    if (!existsSync(p)) return structuredCloneEmpty();
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<SkipsFile>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const skips: Record<string, ConsolidationSkipEntry> = {};
    for (const [sig, entry] of Object.entries(raw.skips ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<ConsolidationSkipEntry>;
      if (typeof e.lastAt !== 'string') continue;
      skips[sig] = {
        strikes: num(e.strikes),
        lastAt: e.lastAt,
        reason: typeof e.reason === 'string' ? e.reason : undefined,
        members: num(e.members),
      };
    }
    return {
      schemaVersion: 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      totals: {
        asked: num(raw.totals?.asked),
        skipped: num(raw.totals?.skipped),
        mutedHits: num(raw.totals?.mutedHits),
      },
      skips,
    };
  } catch {
    return structuredCloneEmpty();
  }
}

function structuredCloneEmpty(): SkipsFile {
  return { ...EMPTY_FILE, totals: { ...EMPTY_FILE.totals }, skips: {} };
}

/** 原子写 + 过期/超量裁剪 + 总闸。失败静默:状态文件绝不影响巩固主流程。 */
function save(file: SkipsFile): void {
  if (memoryWriteBlockReason() !== null) return;
  const now = Date.now();
  const cutoff = now - EXPIRE_DAYS * 86400000;
  const kept = Object.entries(file.skips)
    .filter(([, e]) => {
      const t = Date.parse(e.lastAt);
      return !Number.isFinite(t) || t >= cutoff;
    })
    .sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt))
    .slice(0, MAX_ENTRIES);
  file.skips = Object.fromEntries(kept);
  file.updatedAt = new Date(now).toISOString();
  try {
    const p = skipsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch {
    // 静默:观测/节流状态写不进去,最多是下一轮多问一次
  }
}

/** 记一次真实的巩固请求(模型即将被问到)。 */
export function recordConsolidationAsk(): void {
  const file = loadConsolidationSkips();
  file.totals.asked += 1;
  save(file);
}

/** 记一次「因签名已停问而未发请求」。 */
export function recordConsolidationMuteHit(): void {
  const file = loadConsolidationSkips();
  file.totals.mutedHits += 1;
  save(file);
}

/**
 * 记一次模型判「凑巧」。
 *
 * 同样的签名再被判一次 → strikes 累加;达到阈值后由 `isConsolidationGroupMuted` 拦下请求。
 * 理由只在**本次**写入,便于 health 展示「最近为什么没用」。
 */
export function recordConsolidationSkip(
  signature: string,
  info: { reason?: string; members: number },
): ConsolidationSkipEntry {
  const file = loadConsolidationSkips();
  const prev = file.skips[signature];
  const entry: ConsolidationSkipEntry = {
    strikes: (prev?.strikes ?? 0) + 1,
    lastAt: new Date().toISOString(),
    reason: info.reason ? info.reason.replace(/\s+/g, ' ').slice(0, MAX_REASON_CHARS) : prev?.reason,
    members: info.members,
  };
  file.skips[signature] = entry;
  file.totals.skipped += 1;
  save(file);
  return entry;
}

/**
 * 清除某组的跳过记忆(巩固成功时调用)。
 *
 * 必须清:成员已经 derivedInto 指向新语义条目,不会再来;若日后因故重新进池,
 * 旧的 strikes 会让它一上来就被停问,等于把一条曾经成功的通道永久焊死。
 */
export function clearConsolidationSkip(signature: string): void {
  const file = loadConsolidationSkips();
  if (!(signature in file.skips)) return;
  delete file.skips[signature];
  save(file);
}

/** 该组是否已达到「不必再问」的连续跳过次数。 */
export function isConsolidationGroupMuted(signature: string, threshold: number): boolean {
  const entry = loadConsolidationSkips().skips[signature];
  return !!entry && entry.strikes >= threshold;
}

/** 供 health 展示的汇总(零副作用,只读)。 */
export function consolidationSkipStats(): ConsolidationSkipStats {
  const file = loadConsolidationSkips();
  const entries = Object.values(file.skips);
  let lastAt: string | null = null;
  let lastReason: string | null = null;
  for (const e of entries) {
    if (!lastAt || e.lastAt > lastAt) {
      lastAt = e.lastAt;
      lastReason = e.reason ?? null;
    }
  }
  return {
    asked: file.totals.asked,
    skipped: file.totals.skipped,
    mutedHits: file.totals.mutedHits,
    muted: entries.length,
    lastReason,
    lastAt,
  };
}

/** 仅供测试:清空状态文件,避免用例间串味。 */
export function __resetConsolidationSkipsForTests(): void {
  const file = structuredCloneEmpty();
  file.updatedAt = '';
  try {
    const p = skipsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(file, null, 2) + '\n', 'utf8');
  } catch {
    // 静默
  }
}
