/**
 * flow 文件:格式、校验、从 trace 导出、参数模板、存取(design-notes/computer-use-rpa.md §5.2)。
 *
 * flow 是 `.mocode/flows/<name>.json`,人可编辑,是回放的唯一事实源。设计要点:
 *   - 步骤是扁平对象:保留键(selector/target/fallback/window/allowCoordinateFallback/fragile/onError/note)
 *     之外的键就是 computer 工具的参数,且只接受 trace 白名单里的参数(parseFlow 拒绝未知字段,
 *     防止手改文件时塞进 ref / 任意字段);
 *   - 文本里的 `{{name}}` 是运行时参数;`\{{` 表示字面量 `{{`;
 *   - 录制时命中敏感审查的文本以 secret 参数导出,文件里没有明文,也不允许带 default;
 *   - 本模块只做纯逻辑 + 文件 I/O,不碰屏幕/UIA,可离线单测。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computerTargetNeedsReview, computerTextNeedsReview } from '../permissions/computer-review.js';
import { getSandboxRoot } from '../sandbox/root.js';
import type { UiaSelector } from '../runtime/uia-selector.js';
import { RECORDED_ACTIONS, isParamRef, recordedArgKeys, type TraceEntry } from './trace.js';

export const FLOW_VERSION = 1;
export const FLOW_MAX_STEPS = 200;
export const FLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export interface FlowParam {
  description?: string;
  /** secret:不得有 default;预览/日志里不展示取值,且每次运行强制人工确认。 */
  secret?: boolean;
  default?: string;
}

export type OnErrorAction = 'abort' | 'skip' | 'handoff';

export interface FlowOnError {
  /** 失败后额外重试次数(0-5)。 */
  retry?: number;
  retryDelayMs?: number;
  then?: OnErrorAction;
}

/** 影刀式失败策略的默认值:重试 1 次,仍失败则交还模型。 */
export const DEFAULT_ON_ERROR: Required<FlowOnError> = { retry: 1, retryDelayMs: 500, then: 'handoff' };

export interface FlowStep {
  action: string;
  selector?: UiaSelector;
  target?: { role: string; name: string };
  fallback?: { coordinate: [number, number] };
  window?: { processName?: string; titleRegex?: string };
  /** 只有显式为 true 时,selector 解析失败才允许退回录制时的坐标。 */
  allowCoordinateFallback?: boolean;
  fragile?: boolean;
  onError?: FlowOnError;
  note?: string;
  /** 其余键 = computer 工具参数(白名单见 trace.ts 的 recordedArgKeys)。 */
  [arg: string]: unknown;
}

export interface Flow {
  version: typeof FLOW_VERSION;
  name: string;
  description?: string;
  params: Record<string, FlowParam>;
  steps: FlowStep[];
}

export const FLOW_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'action',
  'selector',
  'target',
  'fallback',
  'window',
  'allowCoordinateFallback',
  'fragile',
  'onError',
  'note',
]);

// ── 模板 ────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /\\\{\{|\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** 字面量里的 `{{` 导出时转义,避免被当成参数。 */
export function escapeTemplate(s: string): string {
  return s.replace(/\{\{/g, '\\{{');
}

export function templateRefs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(TEMPLATE_RE)) if (m[1]) out.push(m[1]);
  return out;
}

/** 渲染模板;缺值抛错(调用方应先 resolveParams)。 */
export function renderTemplate(s: string, values: Readonly<Record<string, string>>): string {
  return s.replace(TEMPLATE_RE, (_m, name?: string) => {
    if (!name) return '{{';
    const v = values[name];
    if (v === undefined) throw new Error(`missing value for flow parameter "${name}"`);
    return v;
  });
}

function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mapStrings(x, fn)]));
  }
  return v;
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === 'object')
    for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out);
}

/** 步骤里(仅 computer 参数部分)引用的参数名。 */
export function stepTemplateRefs(step: FlowStep): string[] {
  const strings: string[] = [];
  for (const [k, v] of Object.entries(step)) if (!FLOW_RESERVED_KEYS.has(k)) collectStrings(v, strings);
  return strings.flatMap(templateRefs);
}

/** 把参数值代入步骤的 computer 参数;保留键(selector 等)原样。 */
export function renderStep(step: FlowStep, values: Readonly<Record<string, string>>): FlowStep {
  const out: FlowStep = { ...step };
  for (const [k, v] of Object.entries(step)) {
    if (!FLOW_RESERVED_KEYS.has(k)) out[k] = mapStrings(v, (s) => renderTemplate(s, values));
  }
  return out;
}

// ── 校验 ────────────────────────────────────────────────────────────────

export type ParseResult = { ok: true; flow: Flow } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const isInt = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function validRegex(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

function checkStep(raw: unknown, i: number, params: Record<string, FlowParam>): string | null {
  const at = `steps[${i}]`;
  if (!isRecord(raw)) return `${at} must be an object`;
  const action = raw.action;
  if (typeof action !== 'string' || !RECORDED_ACTIONS.has(action)) {
    return `${at}.action must be one of: ${[...RECORDED_ACTIONS].join(', ')}`;
  }
  const allowed = new Set<string>([...FLOW_RESERVED_KEYS, ...recordedArgKeys(action)]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) return `${at} has unknown field "${k}" for action "${action}"`;
  }
  if (raw.note !== undefined && typeof raw.note !== 'string') return `${at}.note must be a string`;
  for (const flag of ['allowCoordinateFallback', 'fragile'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') return `${at}.${flag} must be a boolean`;
  }
  if (raw.onError !== undefined) {
    const oe = raw.onError;
    if (!isRecord(oe)) return `${at}.onError must be an object`;
    if (oe.retry !== undefined && !isInt(oe.retry, 0, 5)) return `${at}.onError.retry must be an integer in 0-5`;
    if (oe.retryDelayMs !== undefined && !isInt(oe.retryDelayMs, 0, 10000)) {
      return `${at}.onError.retryDelayMs must be an integer in 0-10000`;
    }
    if (oe.then !== undefined && oe.then !== 'abort' && oe.then !== 'skip' && oe.then !== 'handoff') {
      return `${at}.onError.then must be abort|skip|handoff`;
    }
  }
  if (raw.window !== undefined) {
    const w = raw.window;
    if (!isRecord(w)) return `${at}.window must be an object`;
    if (w.processName !== undefined && typeof w.processName !== 'string')
      return `${at}.window.processName must be a string`;
    if (w.titleRegex !== undefined && (typeof w.titleRegex !== 'string' || !validRegex(w.titleRegex))) {
      return `${at}.window.titleRegex must be a valid regular expression`;
    }
  }
  if (raw.selector !== undefined) {
    const s = raw.selector;
    if (!isRecord(s) || !isRecord(s.window) || typeof s.window.processName !== 'string') {
      return `${at}.selector must be { window: { processName }, path: [...] }`;
    }
    if (!Array.isArray(s.path) || s.path.length === 0 || !s.path.every(isRecord)) {
      return `${at}.selector.path must be a non-empty array of steps`;
    }
  }
  if (raw.target !== undefined) {
    const t = raw.target;
    if (!isRecord(t) || typeof t.role !== 'string' || typeof t.name !== 'string') {
      return `${at}.target must be { role, name }`;
    }
  }
  if (raw.fallback !== undefined) {
    const f = raw.fallback;
    const c = isRecord(f) ? f.coordinate : undefined;
    if (!Array.isArray(c) || c.length !== 2 || !c.every((n) => isInt(n, 0, 1000))) {
      return `${at}.fallback.coordinate must be [x, y] integers in 0-1000`;
    }
  }
  if (
    (action === 'click_element' || action === 'set_value') &&
    raw.selector === undefined &&
    raw.fallback === undefined
  ) {
    return `${at} (${action}) needs a selector (or a fallback coordinate)`;
  }
  if (action === 'focus_window') {
    const w = raw.window;
    if (!isRecord(w) || (typeof w.processName !== 'string' && typeof w.titleRegex !== 'string')) {
      return `${at} (focus_window) needs window.processName or window.titleRegex`;
    }
  }
  const step = raw as FlowStep;
  for (const ref of stepTemplateRefs(step)) {
    if (!params[ref]) return `${at} references undefined parameter "{{${ref}}}"; declare it under "params"`;
  }
  return null;
}

export function parseFlow(raw: unknown): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });
  if (!isRecord(raw)) return fail('flow must be a JSON object');
  if (raw.version !== FLOW_VERSION) return fail(`flow.version must be ${FLOW_VERSION}`);
  if (typeof raw.name !== 'string' || !FLOW_NAME_RE.test(raw.name)) {
    return fail('flow.name must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string')
    return fail('flow.description must be a string');

  const params: Record<string, FlowParam> = {};
  if (raw.params !== undefined) {
    if (!isRecord(raw.params)) return fail('flow.params must be an object');
    for (const [name, p] of Object.entries(raw.params)) {
      if (!PARAM_NAME_RE.test(name)) return fail(`param name "${name}" must match [A-Za-z][A-Za-z0-9_]{0,31}`);
      if (!isRecord(p)) return fail(`params.${name} must be an object`);
      if (p.description !== undefined && typeof p.description !== 'string')
        return fail(`params.${name}.description must be a string`);
      if (p.secret !== undefined && typeof p.secret !== 'boolean')
        return fail(`params.${name}.secret must be a boolean`);
      if (p.default !== undefined && typeof p.default !== 'string')
        return fail(`params.${name}.default must be a string`);
      if (p.secret === true && p.default !== undefined) return fail(`secret param "${name}" must not have a default`);
      params[name] = {
        ...(p.description !== undefined ? { description: p.description as string } : {}),
        ...(p.secret === true ? { secret: true } : {}),
        ...(p.default !== undefined ? { default: p.default as string } : {}),
      };
    }
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return fail('flow.steps must be a non-empty array');
  if (raw.steps.length > FLOW_MAX_STEPS)
    return fail(`flow has ${raw.steps.length} steps; the limit is ${FLOW_MAX_STEPS}`);
  for (let i = 0; i < raw.steps.length; i++) {
    const err = checkStep(raw.steps[i], i, params);
    if (err) return fail(err);
  }

  return {
    ok: true,
    flow: {
      version: FLOW_VERSION,
      name: raw.name,
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
      params,
      steps: raw.steps as FlowStep[],
    },
  };
}

// ── 参数 ────────────────────────────────────────────────────────────────

export type ResolveParamsResult = { ok: true; values: Record<string, string> } | { ok: false; error: string };

/** 合并调用方给的参数与 default;未知参数名与缺失必填都报错(拼写错误不静默)。 */
export function resolveParams(flow: Flow, given: Record<string, unknown> | undefined): ResolveParamsResult {
  const values: Record<string, string> = {};
  const input = given ?? {};
  for (const [k, v] of Object.entries(input)) {
    if (!flow.params[k]) {
      const known = Object.keys(flow.params);
      return {
        ok: false,
        error: `unknown parameter "${k}"; this flow declares: ${known.length ? known.join(', ') : '(none)'}`,
      };
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return { ok: false, error: `parameter "${k}" must be a string` };
    }
    values[k] = String(v);
  }
  const missing: string[] = [];
  for (const [k, p] of Object.entries(flow.params)) {
    if (values[k] === undefined) {
      if (p.default !== undefined) values[k] = p.default;
      else missing.push(k);
    }
  }
  if (missing.length) return { ok: false, error: `missing required parameter(s): ${missing.join(', ')}` };
  return { ok: true, values };
}

// ── 敏感审查与摘要 ───────────────────────────────────────────────────────

const TEXT_ACTIONS: ReadonlySet<string> = new Set(['type', 'key', 'set_value']);

/**
 * 这次运行是否必须人工确认(forceOnce 语义)及原因。回放时单步不再弹窗,所以敏感判定必须在启动时
 * 一次做完:敏感文本(含参数代入后的值)、secret 参数、命中删除/发送/支付类关键词的目标元素。
 */
export function flowReviewReasons(flow: Flow, values: Readonly<Record<string, string>>): string[] {
  const reasons: string[] = [];
  flow.steps.forEach((step, idx) => {
    const n = idx + 1;
    const secrets = [...new Set(stepTemplateRefs(step))].filter((r) => flow.params[r]?.secret);
    if (secrets.length) reasons.push(`step ${n} uses secret parameter ${secrets.join(', ')}`);
    if (TEXT_ACTIONS.has(step.action) && typeof step.text === 'string') {
      let text = step.text;
      try {
        text = renderTemplate(step.text, values);
      } catch {
        /* 缺值由 resolveParams 报错,这里按原文判断 */
      }
      if (computerTextNeedsReview(text)) reasons.push(`step ${n} types sensitive text`);
    }
    const names = [step.target?.name, ...(step.selector?.path ?? []).map((p) => p.name)].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    const hit = names.find((nm) => computerTargetNeedsReview(nm));
    if (hit) reasons.push(`step ${n} targets a sensitive element ${JSON.stringify(hit.slice(0, 40))}`);
  });
  return reasons;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** 一行人类可读步骤摘要。文本按模板原样展示(secret 只会显示 `{{text_7}}`,不含取值)。 */
export function describeStep(step: FlowStep, index: number): string {
  const parts: string[] = [`${index}. ${step.action}`];
  if (step.target) parts.push(`${step.target.role} ${JSON.stringify(clip(step.target.name, 40))}`);
  if (step.window) {
    parts.push(
      [step.window.processName, step.window.titleRegex ? `/${step.window.titleRegex}/` : undefined]
        .filter(Boolean)
        .join(' '),
    );
  }
  if (typeof step.text === 'string') parts.push(JSON.stringify(clip(step.text.replace(/\s+/g, ' '), 60)));
  if (Array.isArray(step.coordinate)) parts.push(`@(${(step.coordinate as number[]).join(', ')})`);
  if (isRecord(step.condition) && typeof step.condition.kind === 'string') {
    const sel = typeof step.condition.selector_text === 'string' ? ` ${step.condition.selector_text}` : '';
    parts.push(`${step.condition.kind}${sel}`);
  }
  if (step.action === 'wait' && typeof step.duration_ms === 'number') parts.push(`${step.duration_ms}ms`);
  const flags: string[] = [];
  if (step.fragile) flags.push('coordinate-based');
  if (step.allowCoordinateFallback) flags.push('coordinate fallback allowed');
  if (step.onError?.then) flags.push(`on error: ${step.onError.then}`);
  return flags.length ? `${parts.join(' ')} (${flags.join(', ')})` : parts.join(' ');
}

export function summarizeFlow(flow: Flow): string {
  const params = Object.entries(flow.params).map(
    ([k, p]) =>
      `${k}${p.secret ? ' (secret)' : p.default !== undefined ? ` (default ${JSON.stringify(clip(p.default, 30))})` : ' (required)'}`,
  );
  const lines = [
    `Flow "${flow.name}"${flow.description ? ` — ${flow.description}` : ''}: ${flow.steps.length} steps`,
    `Parameters: ${params.length ? params.join(', ') : '(none)'}`,
    ...flow.steps.map((s, i) => describeStep(s, i + 1)),
  ];
  return lines.join('\n');
}

// ── 从 trace 导出 ───────────────────────────────────────────────────────

export interface ExportOptions {
  name: string;
  description?: string;
  /** 含端点的 trace seq 范围。 */
  from?: number;
  to?: number;
}

const WAIT_ACTIONS: ReadonlySet<string> = new Set(['wait', 'wait_until']);

/** 界面变化后自动补的稳定等待:超时只跳过,不让回放因为"一直在动的界面"中止。 */
const AUTO_WAIT: FlowStep = {
  action: 'wait_until',
  condition: { kind: 'stable' },
  timeout_ms: 5000,
  onError: { retry: 0, then: 'skip' },
  note: 'auto-inserted after a step that changed the screen',
};

export function exportFlowFromTrace(entries: readonly TraceEntry[], opts: ExportOptions): ParseResult {
  if (!FLOW_NAME_RE.test(opts.name)) {
    return { ok: false, error: 'flow name must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' };
  }
  const picked = [...entries]
    .filter((e) => (opts.from === undefined || e.seq >= opts.from) && (opts.to === undefined || e.seq <= opts.to))
    .sort((a, b) => a.seq - b.seq);
  if (picked.length === 0) {
    return {
      ok: false,
      error: 'no recorded steps in this session (or in the --from/--to range); run some computer actions first',
    };
  }

  const params: Record<string, FlowParam> = {};
  const steps: FlowStep[] = [];
  picked.forEach((e, idx) => {
    const step: FlowStep = { action: e.action };
    for (const [k, v] of Object.entries(e.args)) {
      if (isParamRef(v)) {
        step[k] = `{{${v.$param}}}`;
        params[v.$param] = {
          description: `sensitive text recorded at step ${e.seq}; supply it when running the flow`,
          secret: true,
        };
      } else {
        step[k] = mapStrings(v, escapeTemplate);
      }
    }
    if (e.selector) step.selector = e.selector;
    if (e.target) step.target = e.target;
    if (e.fallback) step.fallback = e.fallback;
    if (e.window) step.window = e.window;
    if (e.fragile) step.fragile = true;
    steps.push(step);
    const next = picked[idx + 1];
    if (e.changed && next && !WAIT_ACTIONS.has(next.action) && !WAIT_ACTIONS.has(e.action)) {
      steps.push({ ...AUTO_WAIT });
    }
  });

  return parseFlow({
    version: FLOW_VERSION,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    params,
    steps,
  });
}

// ── 存取 ────────────────────────────────────────────────────────────────

export function flowsDir(): string {
  return path.join(getSandboxRoot() ?? process.cwd(), '.mocode', 'flows');
}

function flowPath(name: string): string | null {
  return FLOW_NAME_RE.test(name) ? path.join(flowsDir(), `${name}.json`) : null;
}

export type SaveResult = { ok: true; path: string } | { ok: false; error: string };

/** 原子写(tmp + rename)。已存在默认拒绝覆盖。 */
export function saveFlow(flow: Flow, opts: { overwrite?: boolean } = {}): SaveResult {
  const file = flowPath(flow.name);
  if (!file) return { ok: false, error: 'invalid flow name' };
  if (!opts.overwrite && fs.existsSync(file)) {
    return { ok: false, error: `flow "${flow.name}" already exists; choose another name or pass --force to overwrite` };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: `could not write flow: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type LoadResult = { ok: true; flow: Flow; hash: string; path: string } | { ok: false; error: string };

/** 读取并校验;hash 是文件原文的 sha256,供权限指纹绑定"这一版 flow"。 */
export function loadFlow(name: string): LoadResult {
  const file = flowPath(name);
  if (!file) return { ok: false, error: 'invalid flow name' };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: `flow "${name}" not found (looked in ${flowsDir()})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `flow "${name}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = parseFlow(json);
  if (!parsed.ok) return { ok: false, error: `flow "${name}" is invalid: ${parsed.error}` };
  if (parsed.flow.name !== name) {
    return { ok: false, error: `flow file "${name}.json" declares name "${parsed.flow.name}"; they must match` };
  }
  return { ok: true, flow: parsed.flow, hash: crypto.createHash('sha256').update(raw).digest('hex'), path: file };
}

export interface FlowListItem {
  name: string;
  description?: string;
  steps: number;
}

/** 列出可用 flow;无法解析的文件跳过(用 /flow show 看具体错误)。 */
export function listFlows(): FlowListItem[] {
  let files: string[];
  try {
    files = fs.readdirSync(flowsDir());
  } catch {
    return [];
  }
  const out: FlowListItem[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const loaded = loadFlow(f.slice(0, -'.json'.length));
    if (loaded.ok) {
      out.push({ name: loaded.flow.name, description: loaded.flow.description, steps: loaded.flow.steps.length });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
