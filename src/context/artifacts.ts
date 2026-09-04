import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChatMessage } from '../llm/index.js';
import { estimateTokens } from '../llm/index.js';
import type { ContextState } from '../session/compact.js';
import { canonicalizePath, extractPath, toText } from './utils.js';

export type ArtifactFreshness = 'fresh' | 'stale' | 'stubbed';
export type ArtifactSourceType = 'read' | 'search' | 'diagnostic' | 'summary';

export interface ArtifactDependency {
  path: string;
  hash?: string;
}

export interface ContextArtifact {
  id: string;
  source: { type: ArtifactSourceType; tool: string; toolCallId: string };
  hash?: string;
  version?: number;
  dependencies: ArtifactDependency[];
  freshness: ArtifactFreshness;
  rebuildable: boolean;
  tokenCount: number;
  messageIndex: number;
}

export interface ArtifactStats {
  fresh: number;
  stale: number;
  stubbed: number;
  tokensBySource: Partial<Record<ArtifactSourceType, number>>;
}

type ArtifactState = { artifacts: Map<string, ContextArtifact> };
const states = new WeakMap<ContextState, ArtifactState>();
const STALE_PREFIX = '⌦[stale artifact:';
const ARTIFACT_HEADER = /^\[artifact\s+([^\]]+)\]\n?/;

function stateFor(state: ContextState): ArtifactState {
  let current = states.get(state);
  if (!current) {
    current = { artifacts: new Map() };
    states.set(state, current);
  }
  return current;
}

function callArgs(history: ChatMessage[], idx: number): { tool: string; argsRaw: string } | null {
  const id = (history[idx] as { tool_call_id?: string }).tool_call_id;
  if (!id) return null;
  for (let cursor = idx - 1; cursor >= 0; cursor--) {
    const message = history[cursor];
    if (message.role !== 'assistant') continue;
    const calls = (message as { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> })
      .tool_calls;
    const hit = calls?.find((call) => call.id === id);
    if (hit?.function?.name) return { tool: hit.function.name, argsRaw: hit.function.arguments ?? '{}' };
  }
  return null;
}

function sourceType(tool: string): ArtifactSourceType | null {
  if (tool === 'read_file') return 'read';
  if (tool === 'grep' || tool === 'glob') return 'search';
  if (tool === 'run_command') return 'diagnostic';
  return null;
}

function pathsFromOutput(tool: string, output: string): string[] {
  const paths = new Set<string>();
  const add = (value: string): void => {
    const normalized = canonicalizePath(value);
    if (normalized) paths.add(normalized);
  };
  if (tool === 'grep' || tool === 'run_command') {
    const expression = /^(.+?\.[A-Za-z0-9]+):(?:\d+|\s*\d+\s*(?:处匹配|matches?))/gim;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(output))) add(match[1]);
  } else if (tool === 'glob') {
    for (const line of output.split(/\r?\n/)) {
      const value = line.trim();
      if (value && !value.includes(' ') && (value.includes('/') || value.includes('\\'))) add(value);
    }
  }
  return [...paths];
}

function parseReadHash(output: string): string | undefined {
  return /\bhash=(sha256:[a-f0-9]{64})\b/i.exec(output)?.[1]?.toLowerCase();
}

function currentFileHash(file: string): string | undefined {
  if (file === '*') return undefined;
  try {
    return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  } catch {
    return undefined;
  }
}

function updateStats(state: ContextState, artifactState: ArtifactState): void {
  const stats: ArtifactStats = { fresh: 0, stale: 0, stubbed: 0, tokensBySource: {} };
  for (const artifact of artifactState.artifacts.values()) {
    stats[artifact.freshness] += 1;
    stats.tokensBySource[artifact.source.type] =
      (stats.tokensBySource[artifact.source.type] ?? 0) + artifact.tokenCount;
  }
  state.artifactStats = stats;
}

export function recordArtifact(
  state: ContextState,
  history: ChatMessage[],
  idx: number,
  output: string,
  succeeded: boolean,
): void {
  if (!succeeded) return;
  const call = callArgs(history, idx);
  if (!call) return;
  const type = sourceType(call.tool);
  if (!type) return;
  const id = (history[idx] as { tool_call_id?: string }).tool_call_id ?? `${idx}`;
  const directPath = canonicalizePath(extractPath(call.argsRaw));
  let dependencies: ArtifactDependency[] = directPath
    ? [{ path: directPath }]
    : pathsFromOutput(call.tool, output).map((path) => ({ path }));
  // Diagnostics and searches with no parseable result conservatively depend on the workspace.
  if (dependencies.length === 0 && type !== 'read') dependencies = [{ path: '*' }];
  // Capture dependency versions now; future scheduler steps can detect external changes.
  dependencies = dependencies.map((dependency) => {
    const hashAtCreation = currentFileHash(dependency.path);
    return { ...dependency, ...(hashAtCreation ? { hash: hashAtCreation } : {}) };
  });
  const hash = type === 'read' ? parseReadHash(output) : undefined;
  if (hash && dependencies[0]) dependencies[0].hash = hash;
  const content = toText((history[idx] as { content?: unknown }).content);
  const artifact: ContextArtifact = {
    id,
    source: { type, tool: call.tool, toolCallId: id },
    ...(hash ? { hash } : {}),
    version: Date.now(),
    dependencies,
    freshness: content.startsWith('⌦[') ? 'stubbed' : 'fresh',
    rebuildable: true,
    tokenCount: estimateTokens(content),
    messageIndex: idx,
  };
  stateFor(state).artifacts.set(id, artifact);
  updateStats(state, stateFor(state));
}

/** 已知编辑目标:fresh 的 read_file artifact 携带的「路径 + 当前内容 hash」。
 * 文件被改动后会经 invalidateArtifacts 转 stale,因此这里只含尚未失效的证据。 */
export interface KnownEditTarget {
  path: string;
  hash: string;
}

/**
 * 按读取时间倒序返回最近若干「仍新鲜的 read_file 目标」(path + hash)。
 * 用途:文件编辑工具参数校验失败(如缺 path)时,把系统已知的候选直接回灌给模型照抄,
 * 避免模型在长上下文里凭记忆复述出错、补一个字段丢另一个字段的乒乓重试。
 * 只展示事实、不替模型填值——选哪个候选仍由模型判断。永不抛错。
 */
export function knownEditTargets(state: ContextState, limit = 3): KnownEditTarget[] {
  const artifacts = stateFor(state).artifacts;
  const targets: Array<KnownEditTarget & { version: number }> = [];
  for (const artifact of artifacts.values()) {
    if (artifact.freshness !== 'fresh' || artifact.source.type !== 'read') continue;
    const dependency = artifact.dependencies[0];
    if (!dependency || dependency.path === '*' || !dependency.hash) continue;
    targets.push({ path: dependency.path, hash: dependency.hash, version: artifact.version ?? 0 });
  }
  targets.sort((a, b) => b.version - a.version);
  return targets.slice(0, Math.max(1, Math.floor(limit) || 3)).map(({ path, hash }) => ({ path, hash }));
}

function affected(artifact: ContextArtifact, changed: Set<string>): boolean {
  // '*' 依赖(无法解析出具体文件路径的诊断/搜索结果)不与任何具体写操作关联:
  // 任何文件写入都会作废全部 '*' artifact,等于每次 mutation 都销毁
  // git/测试/构建等历史证据,模型被迫反复 re-run,轮次爆炸。只失效路径明确命中的。
  return artifact.dependencies.some((dependency) => dependency.path !== '*' && changed.has(dependency.path));
}

/**
 * Mark precise, file-backed facts stale without changing the evidence in history.
 * A stale result can still explain a later edit or failure; pressure compression is
 * the only path allowed to replace its content with a compact marker.
 */
export function invalidateArtifacts(
  state: ContextState,
  _history: ChatMessage[],
  changedFiles: readonly string[],
): number {
  const changed = new Set(changedFiles.map(canonicalizePath).filter((item): item is string => !!item));
  if (changed.size === 0) return 0;
  const artifactState = stateFor(state);
  let count = 0;
  for (const artifact of artifactState.artifacts.values()) {
    if (artifact.freshness !== 'fresh' || !affected(artifact, changed)) continue;
    artifact.freshness = 'stale';
    count++;
  }
  updateStats(state, artifactState);
  return count;
}

/** Rebuild indices after resume/compaction while retaining versions for surviving tool_call IDs. */
export function rehydrateArtifacts(state: ContextState, history: ChatMessage[]): void {
  const artifactState = stateFor(state);
  const previous = new Map(artifactState.artifacts);
  artifactState.artifacts.clear();
  for (let idx = 0; idx < history.length; idx++) {
    const message = history[idx] as { role?: string; content?: unknown; tool_call_id?: string };
    if (message.role !== 'tool') continue;
    const call = callArgs(history, idx);
    if (!call || !sourceType(call.tool)) continue;
    const content = toText(message.content);
    const id = message.tool_call_id ?? `${idx}`;
    const retained = previous.get(id);
    if (retained) {
      retained.messageIndex = idx;
      retained.tokenCount = estimateTokens(content);
      retained.freshness = content.startsWith(STALE_PREFIX)
        ? 'stale'
        : content.startsWith('⌦[')
          ? 'stubbed'
          : retained.freshness;
      artifactState.artifacts.set(id, retained);
    } else {
      recordArtifact(state, history, idx, content, true);
      const artifact = artifactState.artifacts.get(id);
      if (artifact && content.startsWith(STALE_PREFIX)) artifact.freshness = 'stale';
      else if (artifact && content.startsWith('⌦[')) artifact.freshness = 'stubbed';
    }
  }
  updateStats(state, artifactState);
}

/** Compare captured dependency versions before each model step and mark stale metadata only. */
export function refreshArtifactFreshness(state: ContextState, history: ChatMessage[]): number {
  const changed = new Set<string>();
  for (const artifact of stateFor(state).artifacts.values()) {
    if (artifact.freshness !== 'fresh') continue;
    for (const dependency of artifact.dependencies) {
      if (!dependency.hash || dependency.path === '*') continue;
      if (currentFileHash(dependency.path) !== dependency.hash) changed.add(dependency.path);
    }
  }
  return changed.size > 0 ? invalidateArtifacts(state, history, [...changed]) : 0;
}

/**
 * Pressure-only stage: replace stale evidence in the Cold prefix with a compact
 * marker. Recent/current work stays intact, and normal mutation handling never
 * calls this function.
 */
export function pruneStaleArtifacts(state: ContextState, history: ChatMessage[], coldBoundary: number): number {
  const artifactState = stateFor(state);
  let pruned = 0;
  for (const artifact of artifactState.artifacts.values()) {
    if (artifact.freshness !== 'stale' || artifact.messageIndex >= coldBoundary) continue;
    const message = history[artifact.messageIndex] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== 'tool') continue;
    const content = toText(message.content);
    if (!content.startsWith(STALE_PREFIX)) {
      message.content = `${STALE_PREFIX}${artifact.source.tool}] source=${artifact.id}; source changed, so this content may be outdated.`;
      artifact.tokenCount = estimateTokens(String(message.content));
      pruned++;
    }
  }
  updateStats(state, artifactState);
  return pruned;
}

export function collectArtifactRefs(messages: readonly ChatMessage[]): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const id = (message as { tool_call_id?: string }).tool_call_id;
    if (id) refs.add(id);
    const content = toText((message as { content?: unknown }).content);
    const hash = parseReadHash(content);
    if (hash) refs.add(hash);
  }
  return [...refs].slice(0, 24);
}

export function formatArtifactTokenSources(stats: ArtifactStats | undefined): string {
  if (!stats) return 'none';
  const entries = Object.entries(stats.tokensBySource)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((left, right) => right[1] - left[1]);
  return entries.length > 0 ? entries.map(([source, tokens]) => `${source} ${tokens}`).join(' · ') : 'none';
}

export { STALE_PREFIX, ARTIFACT_HEADER };
