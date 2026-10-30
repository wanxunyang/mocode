import type { Tool } from '../types.js';
import { saveEntry, memoryWriteBlockedMessage, type MemoryType } from '../../memory/store.js';
import { addTriple } from '../../memory/graph.js';
import { buildAnchors, type AnchorInput } from '../../memory/anchor.js';

/**
 * 把工具参数里的 anchors 归一成 AnchorInput[]。
 *
 * 只取 path/symbol,**不接受调用方传 hash**:hash 若由模型抄写,错一个字符就变成
 * 永久 stale,而且这种错误无法从输出里看出来。hash 一律由 store 在写入时现算。
 */
function parseAnchorInputs(raw: unknown): AnchorInput[] {
  if (!Array.isArray(raw)) return [];
  const out: AnchorInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as { path?: unknown; symbol?: unknown };
    const p = typeof a.path === 'string' ? a.path.trim() : '';
    if (!p) continue;
    const s = typeof a.symbol === 'string' ? a.symbol.trim() : '';
    out.push({ path: p, ...(s ? { symbol: s } : {}) });
  }
  return out;
}

/**
 * 锚点结果的说明文字。**失败必须说出来**:静默丢弃会让模型以为已经锚定,
 * 下次代码改了也不会得到提示——那正是 R2 要解决的场景静默失效。
 * 这里重跑一次 buildAnchors 只是为了取失败名单(文件已缓存,成本是一次 stat)。
 */
function anchorNoteOf(anchors: readonly AnchorInput[]): string {
  if (anchors.length === 0) return '';
  const built = buildAnchors(anchors);
  const ok = built.map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path));
  const failed = anchors
    .filter((a) => !ok.includes(a.symbol ? `${a.path}#${a.symbol}` : a.path))
    .map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path));
  if (failed.length === 0) return `;锚定代码 ${ok.length} 处`;
  return ok.length > 0
    ? `;锚定代码 ${ok.length} 处(未锚定: ${failed.join(', ')} — 文件或符号不存在)`
    : `;锚点全部未生效(${failed.join(', ')} — 文件或符号不存在)`;
}

// ---------- memory_save ----------
// 存一条长期记忆(跨会话)。启动只把标题/摘要注入索引(几百 token);详情按需 memory_search 取。
// 撞库(name→id 已存在)拒绝,引导用 memory_update。
// 可选 links:把本条记忆挂进知识图谱(memory-graph.json)——src 省略时默认以记忆 name 为主实体。
export const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    'Save a cross-session long-term memory entry. Store only non-obvious, useful facts/decisions/pitfalls. Title enters the startup index; retrieve body via memory_search. Optionally attach knowledge-graph links (triples) to relate this memory to entities.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short unique title (converted to id; rejected if it collides with an existing one)',
      },
      summary: { type: 'string', description: 'One-line summary (goes into the index; keep it short)' },
      body: { type: 'string', description: 'Full content (details/context/evidence)' },
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
        description: 'Category, default fact',
      },
      pinned: { type: 'boolean', description: 'Pin (exempt from auto-forgetting decay), default false' },
      trigger: {
        type: 'string',
        description:
          'R1.5 WHEN this memory applies — the situation that should make a future session recall it, e.g. "constructing a tool schema for kimi-k3 via dashscope". Write a condition, not "applies to code changes". Optional at first write (leave empty if you cannot predict it); required in spirit for pitfall/decision/feedback. It may be filled in later once the situation actually recurs.',
      },
      action: {
        type: 'string',
        description:
          'R1.5 WHAT to do when the trigger holds — a concrete action ("strip uniqueItems recursively before sending"), not a restatement of the symptom.',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Store at project level (<cwd>/.mocode/) or global (~/.mocode/), default project',
      },
      links: {
        type: 'array',
        description:
          'Optional knowledge-graph triples relating this memory to entities, e.g. [{"src":"mocode","relation":"depends_on","dst":"JSONL store"}]. src defaults to the memory name when omitted.',
        items: {
          type: 'object',
          properties: {
            src: { type: 'string', description: 'Source entity name (defaults to the memory name)' },
            relation: {
              type: 'string',
              description: 'Relation, snake_case, e.g. depends_on / decided_by / conflicts_with',
            },
            dst: { type: 'string', description: 'Target entity name' },
            fact: { type: 'string', description: 'Optional one-line statement for the edge' },
          },
          required: ['relation', 'dst'],
        },
      },
      anchors: {
        type: 'array',
        description:
          'R2 code anchors: the code this memory talks about. Record them when the memory describes how a specific file/function works, so a later change to that code can mark the memory stale instead of silently serving an outdated fact. Pass paths/symbols only — the content hash is computed for you at write time. Anchors that cannot be resolved (file or symbol not found) are dropped.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Workspace-relative file path, e.g. "src/memory/store.ts" (forward slashes)',
            },
            symbol: {
              type: 'string',
              description:
                'Optional function/class/const name. Prefer this over a whole-file anchor — it avoids false staleness when unrelated code in the same file changes.',
            },
          },
          required: ['path'],
        },
      },
    },
    required: ['name', 'summary', 'body'],
  },
  async execute(args) {
    const name = String(args.name ?? '').trim();
    const summary = String(args.summary ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!name) return '错误:缺少 name。';
    if (!summary) return '错误:缺少 summary。';
    if (!body) return '错误:缺少 body。';
    const type = typeof args.type === 'string' ? (args.type as MemoryType) : undefined;
    const scope = args.scope === 'global' ? 'global' : 'project';
    const trigger = typeof args.trigger === 'string' ? args.trigger.trim() : '';
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    const anchors = parseAnchorInputs(args.anchors);
    const r = saveEntry({
      name,
      summary,
      body,
      type,
      pinned: args.pinned === true,
      scope,
      trigger: trigger || undefined,
      action: action || undefined,
      anchors,
    });
    if (!r.ok) {
      // R8.3/R8.5:写入被总闸拦下必须与「已存在」分开说,否则模型会以为换个 name
      // 就能写进去,反复重试一条永远写不进去的路径。
      if ('blocked' in r) return memoryWriteBlockedMessage(r.blocked);
      return `已存在同名记忆 [${r.exists}]。改用 memory_update(id="${r.exists}", …) 更新,或换一个 name。`;
    }
    // 锚点解析失败的要说出来:静默丢弃会让模型以为「已锚定」,下次代码改了也不会得到提示。
    const anchorNote = anchorNoteOf(anchors);
    // 知识图谱挂边:容错——图失败不影响记忆保存结果
    const links = Array.isArray(args.links) ? args.links : [];
    let linked = 0;
    for (const l of links) {
      if (!l || typeof l !== 'object') continue;
      const link = l as { src?: unknown; relation?: unknown; dst?: unknown; fact?: unknown };
      const tr = addTriple({
        src: typeof link.src === 'string' && link.src.trim() ? link.src : name,
        relation: typeof link.relation === 'string' ? link.relation : '',
        dst: typeof link.dst === 'string' ? link.dst : '',
        fact: typeof link.fact === 'string' ? link.fact : undefined,
        sourceEntry: r.id,
        scope,
      });
      if (tr.ok) linked++;
    }
    const linkNote = links.length > 0 ? `;知识图谱挂边 ${linked}/${links.length}` : '';
    return `已保存记忆 [${r.id}] "${name}"(下次启动进索引)${linkNote}${anchorNote}。`;
  },
};
