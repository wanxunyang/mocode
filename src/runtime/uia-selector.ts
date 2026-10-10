/**
 * UIA 元素树的纯函数层(design-notes/computer-use-rpa.md §2.2–2.4)。
 *
 * 只处理 JSON 化的元素树:解析/规整 PowerShell 侧输出、选择器生成与匹配、inspect 文本渲染、
 * ref → 名称登记表(供权限层展示与敏感判定)。不碰进程、屏幕或 COM,跨平台可单测。
 *
 * 树形约定:nodes[0] 是窗口根元素,id 即数组下标,parent=-1 表示根;path 是从窗口根出发
 * 按 ControlViewWalker 子序号走下来的路径(如 "0.3.1"),供 PowerShell 侧重新定位元素。
 */
import { physicalToNorm } from './screen-pipeline.js';

export interface UiaRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiaRawNode {
  id: number;
  parent: number;
  /** 根为 "",子节点为 "0"、"0.3" 这类子序号路径。 */
  path: string;
  depth: number;
  role: string;
  name: string;
  automationId: string;
  className: string;
  /** 物理像素,虚拟桌面坐标。 */
  rect: UiaRect;
  enabled: boolean;
  offscreen: boolean;
  isPassword: boolean;
  /** invoke / value / toggle / select / expand / scroll。 */
  patterns: string[];
  /** 仅非密码节点的 ValuePattern 值(已截断)。 */
  value?: string;
}

export interface UiaWindowInfo {
  hwnd: number;
  title: string;
  processName: string;
  pid: number;
  rect: UiaRect;
}

export interface UiaRawTree {
  window: UiaWindowInfo;
  nodes: UiaRawNode[];
  /** 原始遍历命中节点/时间上限。 */
  truncated: boolean;
  elapsedMs: number;
}

export interface UiaSelectorStep {
  role?: string;
  /** 精确匹配。 */
  name?: string;
  /** 与 name 二选一。 */
  nameRegex?: string;
  automationId?: string;
  className?: string;
  /** 同条件候选中的序号(文档序,0 起);仅在前面字段不唯一时写入。 */
  index?: number;
}

export interface UiaSelector {
  window: { processName: string; titleRegex?: string };
  /** 从窗口根往下,只记录对定位有区分度的祖先;最后一步即目标元素。 */
  path: UiaSelectorStep[];
}

/** 屏幕几何(与 computer.ts 的 ScreenState 同口径),用于把物理矩形换算成 norm1000。 */
export interface NormGeometry {
  physW: number;
  physH: number;
  originX: number;
  originY: number;
}

// ── 解析 PowerShell 输出 ────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toRect(v: unknown): UiaRect {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    x: Math.round(num(o.x)),
    y: Math.round(num(o.y)),
    w: Math.max(0, Math.round(num(o.w))),
    h: Math.max(0, Math.round(num(o.h))),
  };
}

/** PowerShell 5.1 的 ConvertTo-Json 会把单元素数组压成标量,这里统一还原成数组。 */
function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [v];
}

/**
 * 把 PowerShell `tree` op 的响应规整为 UiaRawTree。缺字段按保守默认补齐;
 * 节点 id 以数组下标为准,parent 越界视为根的子节点。没有任何节点时抛错。
 */
export function parseRawTree(resp: Record<string, unknown>): UiaRawTree {
  const w = (resp.window && typeof resp.window === 'object' ? resp.window : {}) as Record<string, unknown>;
  const rawNodes = toArray(resp.nodes);
  if (rawNodes.length === 0) throw new Error('UIA returned an empty element tree');
  const nodes: UiaRawNode[] = rawNodes.map((item, i) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const parent = i === 0 ? -1 : Math.round(num(o.parent));
    const isPassword = o.isPassword === true;
    const node: UiaRawNode = {
      id: i,
      parent: i === 0 ? -1 : parent >= 0 && parent < i ? parent : 0,
      path: str(o.path),
      depth: Math.max(0, Math.round(num(o.depth))),
      role: str(o.role) || 'Custom',
      name: str(o.name),
      automationId: str(o.automationId),
      className: str(o.className),
      rect: toRect(o.rect),
      enabled: o.enabled !== false,
      offscreen: o.offscreen === true,
      isPassword,
      patterns: toArray(o.patterns).map(str).filter(Boolean),
    };
    // 双保险:即便 PowerShell 侧漏判,密码节点的 value 也绝不进入 TS 侧结构。
    if (!isPassword && typeof o.value === 'string' && o.value.length > 0) node.value = o.value;
    return node;
  });
  return {
    window: {
      hwnd: Math.round(num(w.hwnd)),
      title: str(w.title),
      processName: str(w.processName),
      pid: Math.round(num(w.pid)),
      rect: toRect(w.rect),
    },
    nodes,
    truncated: resp.truncated === true,
    elapsedMs: Math.round(num(resp.elapsedMs)),
  };
}

// ── 可交互判定 ──────────────────────────────────────────────────────────

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'Button',
  'Edit',
  'ComboBox',
  'CheckBox',
  'RadioButton',
  'MenuItem',
  'TabItem',
  'ListItem',
  'TreeItem',
  'Hyperlink',
  'Document',
  'SplitButton',
  'DataItem',
  'Slider',
  'Spinner',
]);

const ACTIONABLE_PATTERNS: ReadonlySet<string> = new Set(['invoke', 'value', 'toggle', 'select', 'expand']);

export function isInteractive(n: UiaRawNode): boolean {
  return INTERACTIVE_ROLES.has(n.role) || n.patterns.some((p) => ACTIONABLE_PATTERNS.has(p));
}

/** 自增数字 id / GUID 形态的 AutomationId 在重启或重排后会变,不能作为选择器锚点。 */
export function isStableAutomationId(id: string): boolean {
  const s = id.trim();
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^[{(]?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}[})]?$/i.test(s)) return false;
  return true;
}

// ── 选择器匹配 ──────────────────────────────────────────────────────────

function childrenMap(tree: UiaRawTree): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const n of tree.nodes) {
    if (n.parent < 0) continue;
    const list = kids.get(n.parent);
    if (list) list.push(n.id);
    else kids.set(n.parent, [n.id]);
  }
  return kids;
}

/** ctx 的全部后代,文档序(先序 DFS)。 */
function descendants(tree: UiaRawTree, kids: Map<number, number[]>, ctx: number): UiaRawNode[] {
  const out: UiaRawNode[] = [];
  const stack = [...(kids.get(ctx) ?? [])].reverse();
  while (stack.length) {
    const id = stack.pop() as number;
    out.push(tree.nodes[id]);
    const ch = kids.get(id);
    if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
  }
  return out;
}

function stepMatches(n: UiaRawNode, step: UiaSelectorStep): boolean {
  if (step.role !== undefined && n.role !== step.role) return false;
  if (step.automationId !== undefined && n.automationId !== step.automationId) return false;
  if (step.className !== undefined && n.className !== step.className) return false;
  if (step.name !== undefined && n.name !== step.name) return false;
  if (step.nameRegex !== undefined) {
    try {
      if (!new RegExp(step.nameRegex).test(n.name)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function windowMatches(w: UiaWindowInfo, sel: UiaSelector['window']): boolean {
  if (sel.processName && w.processName.toLowerCase() !== sel.processName.toLowerCase()) return false;
  if (sel.titleRegex) {
    try {
      if (!new RegExp(sel.titleRegex).test(w.title)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 在树中按选择器定位元素。每一步在上一步命中节点的**全部后代**里找(不要求直接子节点);
 * 有 index 取第 index 个候选,无 index 时必须唯一——多个候选视为歧义返回 null,宁可失败也不点错。
 */
export function matchSelector(tree: UiaRawTree, sel: UiaSelector): UiaRawNode | null {
  if (!tree.nodes.length || !sel.path.length) return null;
  if (!windowMatches(tree.window, sel.window)) return null;
  const kids = childrenMap(tree);
  let ctx = 0;
  for (const step of sel.path) {
    const cands = descendants(tree, kids, ctx).filter((n) => stepMatches(n, step));
    const pick = step.index !== undefined ? cands[step.index] : cands.length === 1 ? cands[0] : undefined;
    if (!pick) return null;
    ctx = pick.id;
  }
  return tree.nodes[ctx];
}

// ── 选择器生成 ──────────────────────────────────────────────────────────

function baseStep(n: UiaRawNode): UiaSelectorStep {
  if (isStableAutomationId(n.automationId)) return { role: n.role, automationId: n.automationId };
  return { role: n.role, name: n.name };
}

/** 对给定祖先链逐步生成 step,在不唯一处补 index。链中节点必须按深度递增且互为祖孙。 */
function stepsForChain(tree: UiaRawTree, kids: Map<number, number[]>, chain: UiaRawNode[]): UiaSelectorStep[] | null {
  const steps: UiaSelectorStep[] = [];
  let ctx = 0;
  for (const n of chain) {
    const step = baseStep(n);
    const cands = descendants(tree, kids, ctx).filter((c) => stepMatches(c, step));
    const idx = cands.findIndex((c) => c.id === n.id);
    if (idx < 0) return null;
    if (cands.length > 1) step.index = idx;
    steps.push(step);
    ctx = n.id;
  }
  return steps;
}

const indexCount = (steps: UiaSelectorStep[]): number => steps.filter((s) => s.index !== undefined).length;

/**
 * 为 nodeId 生成选择器:先写出从窗口根到目标的完整祖先链,再贪心省略对定位无区分度的祖先
 * (省略后仍能唯一命中目标、且 index 数不增加才接受)——路径越短,对布局变化越宽容。
 * 不在热路径上调用:inspect 只登记 ref,真正点击时才按需生成。
 */
export function buildSelector(tree: UiaRawTree, nodeId: number): UiaSelector | null {
  const target = tree.nodes[nodeId];
  if (!target || nodeId === 0) return null;
  let chain: UiaRawNode[] = [];
  for (let cur: UiaRawNode | undefined = target; cur && cur.id !== 0; cur = tree.nodes[cur.parent]) {
    chain.unshift(cur);
    if (cur.parent < 0) break;
  }
  const kids = childrenMap(tree);
  const window = { processName: tree.window.processName };
  let steps = stepsForChain(tree, kids, chain);
  if (!steps) return null;
  let i = 0;
  while (i < chain.length - 1) {
    const trialChain = chain.filter((_, k) => k !== i);
    const trial = stepsForChain(tree, kids, trialChain);
    if (
      trial &&
      indexCount(trial) <= indexCount(steps) &&
      matchSelector(tree, { window, path: trial })?.id === nodeId
    ) {
      chain = trialChain;
      steps = trial;
    } else {
      i++;
    }
  }
  return { window, path: steps };
}

// ── inspect 渲染 ────────────────────────────────────────────────────────

export interface DisplayElement {
  ref: string;
  node: UiaRawNode;
}

/** 选出给模型看的节点:可交互、可见、矩形非空;按文档序编号 e1..eN。 */
export function selectDisplayNodes(
  tree: UiaRawTree,
  maxNodes: number,
): { items: DisplayElement[]; truncated: boolean } {
  const visible = tree.nodes.slice(1).filter((n) => isInteractive(n) && !n.offscreen && n.rect.w > 0 && n.rect.h > 0);
  const items = visible.slice(0, maxNodes).map((node, i) => ({ ref: `e${i + 1}`, node }));
  return { items, truncated: visible.length > maxNodes };
}

/** 物理矩形 → 主屏 norm1000 [x, y, w, h]。 */
export function rectToNorm(rect: UiaRect, g: NormGeometry): [number, number, number, number] {
  const [x, y] = physicalToNorm(rect.x - g.originX, rect.y - g.originY, g.physW, g.physH);
  const [x1, y1] = physicalToNorm(rect.x + rect.w - g.originX, rect.y + rect.h - g.originY, g.physW, g.physH);
  return [x, y, Math.max(0, x1 - x), Math.max(0, y1 - y)];
}

/** 矩形中心(物理像素,虚拟桌面坐标)——click_element 的落点。 */
export function rectCenter(rect: UiaRect): [number, number] {
  return [Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2)];
}

const BROWSER_PROCESSES: ReadonlySet<string> = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi']);

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 节点数低于此值视为稀疏树(游戏、自绘 UI、未开无障碍的 Electron)。 */
export const SPARSE_TREE_THRESHOLD = 3;

/** inspect 输出前缀;session/gui-actions.ts 靠它识别台账条目,改动须同步。 */
export const INSPECT_OUTPUT_PREFIX = 'UI elements of window ';

export function formatSnapshot(
  tree: UiaRawTree,
  items: DisplayElement[],
  opts: { generation: number; truncated: boolean; maxNodes: number; geometry: NormGeometry },
): string {
  const w = tree.window;
  const proc = w.processName ? `${w.processName}.exe` : 'unknown process';
  const lines: string[] = [
    `${INSPECT_OUTPUT_PREFIX}${JSON.stringify(clip(w.title, 80))} (${proc}), generation ${opts.generation}, ` +
      `${items.length} nodes (interactive only).`,
    'Coordinates are normalized 0-1000 [x, y, w, h] over the primary screen. Use click_element/set_value with ref; ' +
      'refs expire on the next inspect.',
  ];
  const minDepth = items.reduce((m, it) => Math.min(m, it.node.depth), Number.POSITIVE_INFINITY);
  for (const { ref, node } of items) {
    const indent = ' '.repeat(Math.min(6, Math.max(0, node.depth - minDepth)));
    const value = node.value !== undefined ? ` value=${JSON.stringify(clip(node.value, 60))}` : '';
    const rect = rectToNorm(node.rect, opts.geometry);
    const flags = [...node.patterns.filter((p) => ACTIONABLE_PATTERNS.has(p))];
    if (!node.enabled) flags.push('disabled');
    if (node.isPassword) flags.push('password');
    lines.push(
      `${indent}${ref}  ${node.role}  ${JSON.stringify(clip(node.name, 80))}${value}  [${rect.join(', ')}]` +
        (flags.length ? `  ${flags.join(' ')}` : ''),
    );
  }
  if (opts.truncated) lines.push(`(truncated at ${opts.maxNodes} nodes — narrow scope or use screenshot)`);
  if (tree.truncated) lines.push('(element tree walk hit its size/time limit; some elements may be missing)');
  if (items.length < SPARSE_TREE_THRESHOLD) {
    lines.push('UIA tree is sparse for this window; fall back to screenshot + coordinates.');
  }
  if (BROWSER_PROCESSES.has(w.processName.toLowerCase())) {
    lines.push('This is a web browser: for page content prefer the browser tool over UI elements.');
  }
  return lines.join('\n');
}

// ── ref 名称登记表(权限层只读)──────────────────────────────────────────

const refNames = new Map<string, { role: string; name: string }>();

/** inspect 后整体替换:旧 generation 的 ref 立即失效。 */
export function setElementRefNames(items: readonly DisplayElement[]): void {
  refNames.clear();
  for (const { ref, node } of items) refNames.set(ref, { role: node.role, name: node.name });
}

export function lookupElementRefName(ref: string): { role: string; name: string } | undefined {
  return refNames.get(ref);
}

export function clearElementRefNames(): void {
  refNames.clear();
}
