/**
 * R9.1 冷启动播种:把工作区里**已经写好的约定**变成可确认的记忆候选。
 *
 * ## 为什么「只提议、不自动写」
 *
 * `AGENTS.md` 里的约定是**项目的**,不是**用户亲述的**。它可能由同事、上一个使用者、
 * 甚至从公开模板抄来——未经用户确认就进库,等于把用户画像建立在别人的偏好上。
 * 所以本模块只做确定性抽取 + 列候选;写库必须由用户显式 `/memory seed <n>` 触发。
 *
 * ## 抽什么、不抽什么
 *
 * 只抽「约定 / Conventions」段的 bullet(无该段时退化为 preamble 的 bullet),外加
 * `.mocode/agents-draft.md` 里带 `[约定]` 标记的行。
 *
 * **不抽**「命令」「目录结构」「扩展点」——那些是*资料*(随时 `read_file` 现查),
 * 不是*偏好或决定*。抽出来只会把启动索引灌满可现查的内容,而索引是每轮都在付
 * token 成本的常驻段。这条边界与 `config/index.ts` 的 `AGENTS_INJECTION_INDEX_SECTIONS`
 * 完全一致:那两个章节连注入都被压成指针,更不该变成记忆条目。
 *
 * ## 为什么零 LLM
 *
 * 播种发生在**第一次启动**——那时用户还没说一句话,任何"让模型读一遍再总结"的做法都在
 * 首屏制造几秒黑屏,而且结果不可复现(同一份 AGENTS.md 两次跑出不同条目)。确定性抽取的
 * 代价是条目更笨(就是原句),好处是用户能一眼核对"它要记的到底是不是我写的"。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { saveEntry, type MemoryType } from './store.js';
import { detectHijack } from './guard.js';
import { appendAudit } from './audit.js';

/**
 * 一次播种最多列多少条候选。
 *
 * 定这个上限是因为 AGENTS.md 的约定段可以很长(本仓库 17 条),而 `/memory seed all`
 * 一次写入几十条会把启动索引瞬间撑到 `MAX_INDEX_ENTRIES` 附近,挤掉真正的长期知识。
 * 24 条够覆盖一份很详细的项目约定,又留出索引余量。
 */
export const SEED_MAX_CANDIDATES = 24;

/** 单条约定文本上限(字符)。超长的 bullet 往往是段落级说明,塞进 body 也无检索价值。 */
const MAX_BULLET_CHARS = 1200;

/** 一个候选:已经整理成 `saveEntry` 能直接吃的形状。 */
export interface SeedCandidate {
  /** 条目标题。取 bullet 的「冒号前部分」或前若干字,让它一眼可辨认。 */
  name: string;
  summary: string;
  body: string;
  type: MemoryType;
  /** 来源文件的**相对**路径(工作区为基准,统一 `/`),写进 body 供事后追溯。 */
  sourceFile: string;
}

/** 抽取结果附带的诊断:哪些文件被扫了、为什么没产出候选。 */
export interface SeedScan {
  candidates: SeedCandidate[];
  /** 实际读到的来源文件(相对路径)。 */
  files: string[];
  /** 被 `SEED_MAX_CANDIDATES` 截掉的条数。 */
  truncated: number;
}

/**
 * `## 约定` / `## Conventions` 这类章节标题。
 *
 * **不能用 `\b`**:JS 的 `\b` 只认 ASCII word char,`约定\b` 在中文后面永远不成立,
 * 第一版就是这么写的,导致「约定」段一条都抽不出来(17 个用例红了 9 个)。
 * 改为「标题以该词开头,且其后紧跟分隔符或结尾」——与 `config/index.ts` 的
 * `AGENTS_INJECTION_INDEX_SECTIONS` 同一判据,容忍「约定(monorepo)」「Conventions — team」,
 * 但不误伤「约定与目录结构习惯」这类反向词序。
 */
const CONVENTION_TITLE = /^(?:约定|conventions?|rules?|guidelines?)(?:[\s(:\u2014\uff08\u3010]|$)/i;

/** 任意 H2 标题——用来确定「约定段的边界」。 */
const ANY_H2 = /^##\s+/;

/** markdown bullet(`- x` / `* x`),不含任务列表勾选框。 */
const BULLET = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/;

/** 剥掉行内强调标记,只用于生成 name/summary——body 保留原文。 */
function stripEmphasis(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从一段文本里抽约定 bullet。
 *
 * 两种形态:
 *  1. 有 `## 约定` 段 → 只取该段;
 *  2. 没有 → 退化为 preamble(第一个 H2 之前)的 bullet。
 *
 * 退化规则很重要:`CLAUDE.md` 常常就是一段无标题的 bullet 列表,要求它必须有
 * 「约定」标题等于永远抽不到东西;而反过来把**任意** H2 段都当约定又会把
 * 「命令」「目录结构」一起吸进来。preamble 是这两者之间唯一安全的位置。
 */
export function extractConventionBullets(content: string): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  /** 该行是否为「约定」类 H2。标题匹配要在**去掉 `## ` 之后的标题文本**上做。 */
  const isConventionHeading = (line: string): boolean => {
    const m = /^##\s+(.*)$/.exec(line);
    return !!m && CONVENTION_TITLE.test(m[1].trim());
  };
  // 判定"有没有约定段"必须只看 H2,不能用整行正则去撞正文(正文里引用「## 约定」会误判)。
  const hasConventionHeading = lines.some(isConventionHeading);
  let inSection = !hasConventionHeading; // 无约定段时先按 preamble 收集
  for (const line of lines) {
    if (ANY_H2.test(line)) {
      inSection = hasConventionHeading ? isConventionHeading(line) : false;
      continue;
    }
    if (!inSection) continue;
    const m = BULLET.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (!text || text.length > MAX_BULLET_CHARS) continue;
    out.push(text);
  }
  return out;
}

/**
 * 生成条目标题。
 *
 * 规则:有冒号(`**纯 ESM**:TS import...`)取冒号前——那半句通常就是这条约定的名字,
 * 后半句是解释。没有冒号(或冒号前太短)就取前 48 字。
 */
export function seedNameOf(text: string): string {
  const flat = stripEmphasis(text);
  const colon = /^(.{2,40}?)[::]\s*\S/.exec(flat);
  if (colon) return colon[1].trim();
  // 48 字:中文标题在 `/memory` 概览里与 id 同一行,再长就折行盖住来源标记。
  return flat.length <= 48 ? flat : `${flat.slice(0, 47)}…`;
}

/** `.mocode/agents-draft.md` 里模型自己攒的草稿行:`- [约定] ...`。 */
const DRAFT_LINE = /^\s*[-*]\s+\[约定\]\s+(.+)$/;

function toCandidate(text: string, sourceFile: string): SeedCandidate {
  const summary = stripEmphasis(text);
  const trimmedSummary = summary.length <= 200 ? summary : `${summary.slice(0, 199)}…`;
  return {
    name: seedNameOf(text),
    summary: trimmedSummary,
    // body 存原文(含强调标记):用户核对时看到的是他当初写的样子。
    body: `${text}\n\n> 播种自 ${sourceFile}`,
    type: 'decision',
    sourceFile,
  };
}

/**
 * 扫描工作区,产出候选。**只读**,不写任何文件。
 *
 * 扫三处(都存在才扫):
 *  - `AGENTS.md` / `CLAUDE.md`(工作区根):已有项目约定;
 *  - `.mocode/agents-draft.md`:模型在历史会话里攒下、还没被 `/init` 合入的草稿。
 *
 * 刻意**不**向上找父目录的 `AGENTS.md`:memory 的 project 库绑定当前工作区,把
 * 父目录(可能是另一个项目/整台机器的约定)吸进来,会让「这个仓库的记忆」变成
 * 「这台机器的记忆」——两者都可以有,但后者该由用户自己决定,不该由一次启动代劳。
 */
export function collectSeedCandidates(cwd: string = process.cwd()): SeedScan {
  const sources: Array<{ rel: string; abs: string }> = [
    { rel: 'AGENTS.md', abs: path.join(cwd, 'AGENTS.md') },
    { rel: 'CLAUDE.md', abs: path.join(cwd, 'CLAUDE.md') },
    { rel: '.mocode/agents-draft.md', abs: path.join(cwd, '.mocode', 'agents-draft.md') },
  ];
  const candidates: SeedCandidate[] = [];
  const files: string[] = [];
  const seen = new Set<string>(); // 同一条文本可能出现两次(AGENTS.md 与 draft),只留一份
  for (const src of sources) {
    if (!existsSync(src.abs)) continue;
    let raw: string;
    try {
      raw = readFileSync(src.abs, 'utf8');
    } catch {
      continue; // 读失败静默跳过:播种是锦上添花,不该让启动失败
    }
    if (!raw.trim()) continue;
    files.push(src.rel);
    const texts =
      src.rel === '.mocode/agents-draft.md'
        ? raw
            .split('\n')
            .map((l) => DRAFT_LINE.exec(l)?.[1]?.trim())
            .filter((t): t is string => !!t)
        : extractConventionBullets(raw);
    for (const t of texts) {
      const key = stripEmphasis(t);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(toCandidate(t, src.rel));
    }
  }
  const truncated = Math.max(0, candidates.length - SEED_MAX_CANDIDATES);
  return { candidates: candidates.slice(0, SEED_MAX_CANDIDATES), files, truncated };
}

/** 写库结果。三分法而不是成败二分:用户要能区分「写了」「本来就有」「被守卫拒了」。 */
export interface SeedWriteResult {
  saved: Array<{ index: number; id: string; name: string }>;
  existed: Array<{ index: number; id: string; name: string }>;
  refused: Array<{ index: number; name: string; rule: string }>;
}

/**
 * 把选中的候选写入记忆库。
 *
 * `picks` 用 **1 基序号**(与 `/memory seed <n>` 的输入一致)——命令行里用户看到的是
 * 1、2、3,内部数组是 0 基,转换放在这里做,命令层不必各自 `-1`。
 *
 * 逐条过 `detectHijack`:AGENTS.md 也是**文件内容**,同样可能被恶意仓库塞入指令性文本。
 * 播种是唯一"用户没逐个看一眼就直接落库"的入口(尤其 `seed all`),此处漏掉守卫等于
 * 给 R16 开了个后门。
 */
export function applySeedCandidates(
  candidates: readonly SeedCandidate[],
  picks: readonly number[] | 'all',
): SeedWriteResult {
  const out: SeedWriteResult = { saved: [], existed: [], refused: [] };
  const wanted = candidates
    .map((c, i) => ({ c, index: i + 1 }))
    .filter(({ index }) => picks === 'all' || picks.includes(index));
  for (const { c, index } of wanted) {
    const hijack = detectHijack(`${c.name} ${c.summary} ${c.body}`);
    if (hijack) {
      out.refused.push({ index, name: c.name, rule: hijack.rule });
      appendAudit({
        at: new Date().toISOString(),
        action: 'refuse',
        detail: `拒绝播种记忆「${c.name.slice(0, 60)}」:命中投毒规则 ${hijack.rule}`,
        reason: `hijack:${hijack.rule}`,
        snippet: hijack.sample,
      });
      continue;
    }
    const r = saveEntry({
      name: c.name,
      summary: c.summary,
      body: c.body,
      type: c.type,
      scope: 'project',
      // 标成来源文件而非「会话内工具写入」:播种条目不是模型在本轮对话里决定的,
      // 它来自一份用户自己维护的文档,追溯链必须指向那份文档。
      source: { file: c.sourceFile },
    });
    if (r.ok) out.saved.push({ index, id: r.id, name: c.name });
    else if ('exists' in r) out.existed.push({ index, id: r.exists, name: c.name });
    else out.refused.push({ index, name: c.name, rule: r.blocked });
  }
  return out;
}
