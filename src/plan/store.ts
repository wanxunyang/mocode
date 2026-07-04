// 单 plan 的文件级存储:CRUD + markdown 解析/序列化。
//
// 设计目标
//  - 文件是唯一事实源(抗压缩、可视化、用户可改)。每次写都 atomic(rename 覆盖)。
//  - 同会话单 plan(state.ts 跟踪「活跃」,本模块不参与并发控制——单进程单活跃 plan 串行调用)。
//  - 解析宽松:坏 frontmatter / 缺段 → 退化到最小可用 Plan,不抛。
//  - 序列化稳定:每段顺序固定(frontmatter → 目标 → 步骤 → 进度日志),便于 git diff 友好。
//
// 不依赖 agent / ui / llm;仅 node:fs + node:path。仿 memory/store.ts 的「叶子」分层。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';

// ── 类型 ──

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed';

export interface PlanStep {
  /** 1-based 序号(在当前 plan 内稳定,即便中间 add_step 也不重用旧号——见 addStep)。 */
  id: number;
  title: string;
  status: StepStatus;
}

export type PlanStatus = 'in_progress' | 'finished' | 'abandoned';

export interface Plan {
  id: string;
  title: string;
  status: PlanStatus;
  created: string; // ISO
  updated: string; // ISO
  goal: string;
  steps: PlanStep[];
  /** 进度日志条目(时间戳 + 一行说明),append-only。 */
  log: { at: string; text: string }[];
}

// ── 路径 ──

/** plans 目录:<sandboxRoot>/.mocode/plans/。无 sandboxRoot 退到 cwd(防御)。 */
export function plansDir(): string {
  const root = getSandboxRoot() ?? process.cwd();
  return join(root, '.mocode', 'plans');
}

/** 单 plan 文件路径:<root>/.mocode/plans/<id>.md。 */
export function planPath(id: string): string {
  return join(plansDir(), `${id}.md`);
}

/** 确保 plans 目录存在(惰性,工具每次写前调)。 */
export function ensurePlansDir(): void {
  const d = plansDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── ID 生成 ──

/** plan id:YYYY-MM-DDTHH-mm-ss-xxxxxx(本地时间,文件名安全)。xxxxxx = 4 字节随机 hex(防同秒并发撞)。 */
export function newPlanId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  // crypto 不必要;Math.random 够防同秒撞(碰撞概率 ~1/2^32)
  const r = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${y}-${mo}-${d}T${h}-${mi}-${s}-${r}`;
}

// ── 解析(宽松,坏文件不抛,退化到最小可用 Plan)──

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const CHECKBOX_RE = /^(\s*)-\s+\[([ xX\/~])\]\s+(\d+)\.\s+(.+?)\s*$/;
const LOG_RE = /^-\s+(\S+)\s+(.+?)\s*$/;

/**
 * 解析 plan 文件为 Plan 对象。失败(无 frontmatter / 段缺失 / 坏 checkbox)→ 退化:
 *  - 无 frontmatter:把整文当 title 段
 *  - 缺字段:空串 / 空数组
 *  - 坏 checkbox:跳过该行,不污染好行
 * 解析成功但 step id 缺序 / 重号:按出现顺序重排为 1..N(保稳定)。
 */
export function parsePlan(raw: string, fallbackId: string): Plan {
  const now = new Date().toISOString();
  let meta: Record<string, string> = {};
  let body = raw;
  const m = FRONTMATTER_RE.exec(raw);
  if (m) {
    meta = parseFrontmatter(m[1]);
    body = m[2];
  }
  const id = meta.id || fallbackId;
  const title = meta.title || extractFirstHeading(body) || '(无标题)';
  const status = normalizePlanStatus(meta.status);
  const created = meta.created || now;
  const updated = meta.updated || now;

  const { goal, steps, log } = parseBody(body);
  // 步骤 id 规范化:1..N(防文件手改致 id 跳号)
  const normSteps: PlanStep[] = steps.map((s, i) => ({ ...s, id: i + 1 }));
  return { id, title, status, created, updated, goal, steps: normSteps, log };
}

function parseFrontmatter(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function normalizePlanStatus(s: string | undefined): PlanStatus {
  if (s === 'finished' || s === 'abandoned') return s;
  return 'in_progress';
}

function extractFirstHeading(body: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1] : '';
}

interface BodySections {
  goal: string;
  steps: PlanStep[];
  log: { at: string; text: string }[];
}

function parseBody(body: string): BodySections {
  const sections: Record<string, string> = {};
  const re = /^##\s+(.+?)\s*$/gm;
  let lastKey = '';
  let lastStart = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (lastKey) sections[lastKey] = body.slice(lastStart, m.index);
    lastKey = m[1].trim();
    lastStart = m.index + m[0].length;
  }
  if (lastKey) sections[lastKey] = body.slice(lastStart);

  const goal = (sections['目标'] || sections['Goal'] || '').trim();
  const stepBlock = sections['步骤'] || sections['Steps'] || '';
  const logBlock = sections['进度日志'] || sections['Log'] || sections['进度'] || '';

  const steps: PlanStep[] = [];
  for (const line of stepBlock.split('\n')) {
    const cm = CHECKBOX_RE.exec(line);
    if (!cm) continue;
    const marker = cm[2].toLowerCase();
    const status: StepStatus =
      marker === 'x' ? 'done' :
      marker === '/' ? 'in_progress' :
      marker === '~' ? 'skipped' :
      'pending';
    const id = Number(cm[3]);
    const title = cm[4].trim();
    if (!Number.isFinite(id) || id < 1) continue;
    steps.push({ id, title, status });
  }

  const log: { at: string; text: string }[] = [];
  for (const line of logBlock.split('\n')) {
    const lm = LOG_RE.exec(line);
    if (!lm) continue;
    log.push({ at: lm[1], text: lm[2] });
  }

  return { goal, steps, log };
}

// ── 序列化 ──

/** 序列化为 markdown 文本。固定段序:frontmatter → 目标 → 步骤 → 进度日志。 */
export function serializePlan(p: Plan): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${p.id}`);
  lines.push(`title: ${p.title}`);
  lines.push(`status: ${p.status}`);
  lines.push(`created: ${p.created}`);
  lines.push(`updated: ${p.updated}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${p.title}`);
  lines.push('');
  lines.push('## 目标');
  lines.push(p.goal || '(未填写)');
  lines.push('');
  lines.push('## 步骤');
  if (p.steps.length === 0) {
    lines.push('(无步骤)');
  } else {
    for (const s of p.steps) {
      lines.push(`- [${checkboxMarker(s.status)}] ${s.id}. ${s.title}`);
    }
  }
  lines.push('');
  lines.push('## 进度日志');
  if (p.log.length === 0) {
    lines.push('(无)');
  } else {
    for (const e of p.log) {
      lines.push(`- ${e.at} ${e.text}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function checkboxMarker(s: StepStatus): string {
  switch (s) {
    case 'done': return 'x';
    case 'in_progress': return '/';
    case 'skipped': return '~';
    case 'failed': return 'x'; // 用 x + log 标 failed(checkbox 集 [ ]/x/[x] 之外的细态不上,降级)
    case 'pending':
    default: return ' ';
  }
}

// ── CRUD(直接落盘)──

/** 读 plan 文件;不存在 → null,坏文件 → fallbackId 最小可用 Plan(不抛,工具契约)。 */
export function readPlan(id: string): Plan | null {
  const p = planPath(id);
  if (!existsSync(p)) return null;
  try {
    return parsePlan(readFileSync(p, 'utf8'), id);
  } catch {
    return null;
  }
}

/** 写 plan 文件(atomic:写 .tmp 再 rename)。返回是否成功。 */
export function writePlan(p: Plan): boolean {
  try {
    ensurePlansDir();
    const target = planPath(p.id);
    const tmp = target + '.tmp';
    writeFileSync(tmp, serializePlan(p), 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** 删 plan 文件;不存在静默 ok。 */
export function deletePlan(id: string): boolean {
  const p = planPath(id);
  if (!existsSync(p)) return true;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子读-改-写:读 → mutator 改 → 写。mutator 返回 false 视为"无改动",跳过写。
 * mutator 抛错 → 写失败 → 返 null(不抛,工具契约)。
 *
 * mutator 同步:本 store 走同步 fs,mutator 必须同步(返 Promise 视为"无信号"——返原对象);
 *  设计如此以避免把 fs API 改成 async(同步 fs 在 node 单 tick 原子,无需锁)。
 */
export function updatePlan(
  id: string,
  mutator: (p: Plan) => Plan | false,
): Plan | null {
  const cur = readPlan(id);
  if (!cur) return null;
  let next: Plan | false;
  try {
    next = mutator(cur);
  } catch {
    return null;
  }
  if (next === false) return cur; // 无改动:返原对象
  next.updated = new Date().toISOString();
  if (!writePlan(next)) return null;
  return next;
}

/** 列 plans 目录下所有 plan(按 updated 倒序,最新在前)。解析失败的跳过。 */
export function listPlans(): Plan[] {
  const dir = plansDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const out: Plan[] = [];
  for (const n of names) {
    const id = n.slice(0, -3);
    const p = readPlan(id);
    if (p) out.push(p);
  }
  out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return out;
}

// ── 渲染(给 LLM / UI 用)──

/** 把 Plan 渲成给 LLM 看的紧凑摘要(多行文本)。 */
export function renderPlanForLLM(p: Plan): string {
  const lines: string[] = [];
  lines.push(`# ${p.title} [${p.status}]`);
  if (p.goal) lines.push(`\n## 目标\n${p.goal}`);
  const done = p.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  lines.push(`\n## 步骤 (${done}/${p.steps.length} 完成)`);
  if (p.steps.length === 0) {
    lines.push('(无)');
  } else {
    for (const s of p.steps) {
      lines.push(`- [${checkboxMarker(s.status)}] ${s.id}. ${s.title}`);
    }
  }
  if (p.log.length > 0) {
    lines.push(`\n## 进度日志(最近 ${Math.min(p.log.length, 5)} 条)`);
    for (const e of p.log.slice(-5)) lines.push(`- ${e.at} ${e.text}`);
  }
  return lines.join('\n');
}

/**
 * 状态行 chip 的短摘要:`plan: 标题 (done/total) ▸ <当前 in_progress 步骤>`。
 * 无活跃 plan → 空串。
 *
 * 字符截断(非终端宽,固定长度 ~50 字符,方便状态行收纳):
 *  - 标题(plan 标题):超 10 字截断,加 "..."
 *  - 步骤标题:超 17 字截断,加 "..."
 *  - 例:`plan: 3D 贪吃蛇游戏 (0/9) ▸ 1. 搭建项目骨架:创建 snake3d...`
 *
 * 当前步骤取 status=in_progress;无 in_progress 但有 pending 时回退到第一项 pending
 * (LLM 刚标记某步 done 还没动 next 时,这样能看清下一步)。
 * 全 done → 不带 tail;finished → 拼「✓ N/N」。
 *
 * maxWidth 是软上限:极端窄(<26)时只保 head+count 不带 tail;否则按上述字符限。
 */
const PLAN_TITLE_MAX = 10;
const STEP_TITLE_MAX = 17;
const TRUNC_DOTS = '...';
export function renderPlanChip(p: Plan | null, maxWidth: number = 56): string {
  if (!p) return '';
  const title = truncateByChars(p.title, PLAN_TITLE_MAX);
  const head = p.status === 'finished'
    ? `plan ✓ ${title}`
    : `plan: ${title}`;
  const total = p.steps.length;
  const done = p.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const count = `(${done}/${total})`;
  const fixed = `${head} ${count}`;
  // 极窄:没空间塞步骤,只保 head+count
  if (maxWidth < 26) return fixed;
  const cur = p.status === 'in_progress'
    ? p.steps.find((s) => s.status === 'in_progress')
      ?? p.steps.find((s) => s.status === 'pending')
    : null; // finished / abandoned → 不显当前步
  if (!cur) return fixed;
  const stepTitle = truncateByChars(cur.title, STEP_TITLE_MAX);
  return `${fixed} ▸ ${cur.id}. ${stepTitle}`;
}

/** 字符数截断(非显示宽):超 max 字符截到 max + "..."(3 字符省略号固定)。
 *  <= max → 原样返回;> max → 前 max 字符 + "..."。 */
function truncateByChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + TRUNC_DOTS;
}

function truncateForChip(s: string, max: number = 18): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return s.slice(0, max - 1) + '…';
}
