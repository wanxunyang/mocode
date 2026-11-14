/**
 * 历史视图（右侧 inspector 列）：提交泳道图 + 某提交改动的文件 + 该文件在这个提交里的内容与 diff。
 *
 * 与 source-control.ts 的分工：
 *   · source-control 管「工作区还有哪些没提交」，每 5 秒轮询一次；
 *   · 这里管「已经提交过的历史」，纯只读、不轮询 —— 历史不会自己变，主动刷新才重读。
 *
 * 泳道布局不在本文件里算：`../git-graph.ts` 的 GraphWalker 只吃 (sha, parents)，
 * 输出每行的 lane / 连线，本文件只负责把它画成 SVG。分开的好处是算法能在 node 里测。
 */
import type { LocaleKey } from '../i18n/index.js';
import { GraphWalker, type GraphRow } from '../git-graph.js';
import type { GitRepoView, SourceControlTarget } from './source-control.js';
import { renderUnifiedDiff } from './unified-diff.js';

export interface GitCommitEntry {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  refs: string[];
  subject: string;
}

export interface GitCommitFileEntry {
  path: string;
  previousPath?: string;
  code: string;
}

export interface HistoryDeps {
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string;
  icon: (name: string) => string;
  escapeHtml: (value: string) => string;
  /** 「3 天前」这类相对时间（与任务列表同一套文案）。 */
  relativeTime: (iso: string) => string;
  currentTaskId: () => string | undefined;
  currentProjectId: () => string | undefined;
  repos: (target: SourceControlTarget) => Promise<{ ok: boolean; repos: GitRepoView[]; message?: string }>;
  log: (target: SourceControlTarget, options: { limit: number; skip: number }) => Promise<{ ok: boolean; commits: GitCommitEntry[]; truncated: boolean; message?: string }>;
  commitFiles: (target: SourceControlTarget, sha: string) => Promise<{ ok: boolean; files: GitCommitFileEntry[]; message?: string }>;
  commitFile: (target: SourceControlTarget, sha: string, path: string) => Promise<{ ok: boolean; content?: string; diff?: string; binary?: boolean; truncated?: boolean; message?: string }>;
}

/** 一页多少条。100 条 × 每行一个 SVG 在 inspector 宽度下够用，再多就要滚很久才到底。 */
const PAGE_SIZE = 100;
/** 泳道图几何：必须与 style.css 的 .history-row 高度、.history-graph 宽度规则一致。 */
const LANE_W = 12;
const ROW_H = 26;
const NODE_R = 3.5;

let deps: HistoryDeps | null = null;
let repoList: GitRepoView[] = [];
let repoRoot = '';
let commits: GitCommitEntry[] = [];
let rows: GraphRow[] = [];
let walker = new GraphWalker();
let truncated = false;
let loading = false;
let workspaceKey = '';
/** 视图层级：列表 → 某提交的文件 → 某文件的内容。返回时逐级退回，不重新拉数据。 */
let view: 'log' | 'files' | 'file' = 'log';
let selectedSha = '';
let selectedPath = '';
/** 请求序号：快速切仓库/切视图时丢弃过期回执。 */
let sequence = 0;
let visible = false;

function need(): HistoryDeps {
  if (!deps) throw new Error('History panel is not initialized.');
  return deps;
}

export function initHistory(injected: HistoryDeps): void {
  deps = injected;
}

function currentKey(): string {
  const api = need();
  return `${api.currentTaskId() ?? ''}:${api.currentProjectId() ?? ''}`;
}

function currentTarget(): SourceControlTarget {
  const api = need();
  return { taskId: api.currentTaskId(), projectId: api.currentProjectId() };
}

function resetState(): void {
  repoList = [];
  repoRoot = '';
  commits = [];
  rows = [];
  walker = new GraphWalker();
  truncated = false;
  loading = false;
  view = 'log';
  selectedSha = '';
  selectedPath = '';
}

/* ── 泳道图 ─────────────────────────────────────────────── */

function laneColor(index: number): string {
  // 颜色只选 class，具体色值在 style.css（跟随主题，亮/暗各一套）。
  return `lane-${index}`;
}

function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

/**
 * 一行泳道图。
 *
 * 只画三种东西（见 git-graph.ts 的说明，非节点 lane 不会半路消失）：
 *   1. 直通线（贯穿本行，不经过节点）；
 *   2. 节点到父提交的连接（第一父继承列 → 竖线；并到别的列 → 曲线）；
 *   3. 节点本身。
 * 行的上下沿各让出半步，让相邻行的线自然接上，不留缝。
 */
function graphSvg(row: GraphRow): string {
  const width = Math.max(1, row.lanes) * LANE_W;
  const cx = laneX(row.lane);
  const cy = ROW_H / 2;
  const parts: string[] = [];
  for (const line of row.through) {
    const x = laneX(line.lane);
    parts.push(`<path class="lane-line ${laneColor(line.color)}" d="M${x} 0V${ROW_H}"/>`);
  }
  // 有 lane 在等这个提交 → 从行顶连到节点；尖端（没有任何子提交指向它）则从节点起笔。
  if (row.fromTop) parts.push(`<path class="lane-line ${laneColor(row.color)}" d="M${cx} 0V${cy}"/>`);
  for (const edge of row.edges) {
    const from = laneX(edge.from);
    const to = laneX(edge.to);
    const d = from === to
      ? `M${from} ${cy}V${ROW_H}`
      // 半个行高的控制点：弯得太急会像折线，太缓又会压到相邻 lane。
      : `M${from} ${cy}C${from} ${cy + ROW_H / 4} ${to} ${ROW_H - ROW_H / 4} ${to} ${ROW_H}`;
    parts.push(`<path class="lane-line ${laneColor(edge.color)}" d="${d}"/>`);
  }
  parts.push(`<circle class="lane-node ${laneColor(row.color)}" cx="${cx}" cy="${cy}" r="${NODE_R}"/>`);
  return `<svg class="history-graph" width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">${parts.join('')}</svg>`;
}

/* ── 各级视图 ───────────────────────────────────────────── */

function repoPicker(): string {
  const api = need();
  if (repoList.length <= 1) return '';
  return `<div class="history-repos">${repoList.map((repo) => {
    const active = repo.root === repoRoot;
    return `<button class="history-repo${active ? ' active' : ''}" data-history-repo="${api.escapeHtml(repo.root)}" title="${api.escapeHtml(repo.root)}">${api.escapeHtml(repo.name || repo.relative || api.t('scm.branchLabel'))}</button>`;
  }).join('')}</div>`;
}

function logMarkup(): string {
  const api = need();
  if (!commits.length) return `${logHeaderMarkup()}<p class="inspector-empty">${api.t('history.empty')}</p>`;
  const items = commits.map((commit, index) => {
    const row = rows[index];
    // 合并提交必须显式标出：泳道图上它是两条线的汇合点，列表里也应能看出「这不是普通提交」。
    const merge = commit.parents.length > 1 ? `<span class="history-merge">${api.t('history.merge')}</span>` : '';
    const refs = commit.refs.map((ref) => `<span class="history-ref">${api.escapeHtml(ref)}</span>`).join('');
    return `<button class="history-row" data-history-commit="${api.escapeHtml(commit.sha)}" title="${api.escapeHtml(`${commit.shortSha} ${commit.subject}`)}">
      ${graphSvg(row)}
      <span class="history-body">
        <span class="history-subject">${api.escapeHtml(commit.subject || api.t('history.noSubject'))}</span>
        <span class="history-meta"><span class="history-sha">${api.escapeHtml(commit.shortSha)}</span><span class="history-author">${api.escapeHtml(commit.author)}</span><span class="history-time">${api.escapeHtml(api.relativeTime(commit.date))}</span>${merge}${refs}</span>
      </span>
    </button>`;
  }).join('');
  const more = truncated
    ? `<button class="history-more" data-history-more>${api.t('history.loadMore')}</button>`
    : '';
  return `${logHeaderMarkup()}<div class="history-list-wrap">${items}${more}</div>`;
}

/** 列表页头：标题 + 刷新。历史不会自己变，所以不轮询，只留一个显式刷新。 */
function logHeaderMarkup(): string {
  const api = need();
  const label = api.t('history.refresh');
  return `<div class="history-head"><b class="history-title">${api.t('history.title')}</b><button class="history-refresh" data-history-refresh title="${label}" aria-label="${label}">${api.icon('regen')}</button></div>`;
}

function headerMarkup(title: string, back?: 'log' | 'files'): string {
  const api = need();
  return `<div class="history-head">
    ${back ? `<button class="history-back" data-history-back="${back}">${api.icon('arrow-left')}<span>${api.t('scm.back')}</span></button>` : ''}
    <b class="history-title" title="${api.escapeHtml(title)}">${api.escapeHtml(title)}</b>
  </div>`;
}

function filesMarkup(files: GitCommitFileEntry[], message?: string): string {
  const api = need();
  if (!files.length) return `<p class="inspector-empty">${api.escapeHtml(message ?? api.t('history.noFiles'))}</p>`;
  return `<div class="history-files">${files.map((file) => {
    const label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
    return `<button class="history-file" data-history-file="${api.escapeHtml(file.path)}" title="${api.escapeHtml(label)}">
      <span class="history-file-code history-code-${api.escapeHtml(file.code)}">${api.escapeHtml(file.code)}</span>
      <span class="history-file-path">${api.escapeHtml(label)}</span>
    </button>`;
  }).join('')}</div>`;
}

/** 文件视图：diff 在上、该提交时的完整内容在下，一次给全（来回切太烦）。 */
function fileMarkup(sha: string, path: string, result: { ok: boolean; content?: string; diff?: string; binary?: boolean; truncated?: boolean; message?: string }): string {
  const api = need();
  if (!result.ok) return `<p class="inspector-empty">${api.escapeHtml(result.message ?? api.t('history.failed'))}</p>`;
  // 统一 diff 走行级渲染（红绿底色 + 双行号）；解析不了才退回原文（二进制、mode-only 改动）。
  const rendered = result.diff?.trim() ? renderUnifiedDiff(result.diff, { moreLines: (n) => api.t('tool.moreLines', { n }) }) : null;
  const diff = rendered
    ? rendered
    : result.diff?.trim()
      ? `<pre class="file-preview diff-preview scm-diff">${api.escapeHtml(result.diff)}</pre>`
      : `<p class="inspector-empty">${api.t('history.noDiff')}</p>`;
  const body = result.binary
    ? `<p class="inspector-empty">${api.t('history.binary')}</p>`
    : result.content?.trim()
      ? `<pre class="file-preview scm-diff">${api.escapeHtml(result.content)}</pre>`
      : `<p class="inspector-empty">${api.t('history.emptyFile')}</p>`;
  return `<div class="history-file-view">
    <p class="history-file-head"><code>${api.escapeHtml(path)}</code><span>${api.escapeHtml(sha.slice(0, 8))}</span></p>
    <h3>${api.t('history.diffTitle')}</h3>${diff}
    <h3>${api.t('history.contentTitle')}</h3>${body}
    ${result.truncated ? `<p class="scm-hint">${api.t('history.truncated')}</p>` : ''}
  </div>`;
}

/* ── 渲染与数据加载 ─────────────────────────────────────── */

function paint(container: HTMLElement, inner: string): void {
  container.innerHTML = `${repoPicker()}${inner}`;
  wire(container);
}

/** 事件挂载。整块 innerHTML 重建后必须重挂，所以每个渲染入口都要过一遍 wire。 */
function wire(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('[data-history-repo]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.historyRepo ?? '';
      if (!next || next === repoRoot) return;
      repoRoot = next;
      commits = [];
      rows = [];
      walker = new GraphWalker();
      truncated = false;
      view = 'log';
      selectedSha = '';
      void loadPage(container);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-history-commit]').forEach((button) => {
    button.addEventListener('click', () => {
      const sha = button.dataset.historyCommit ?? '';
      if (sha) void openCommit(container, sha);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-history-more]').forEach((button) => {
    button.addEventListener('click', () => void loadPage(container));
  });
  // 刷新 = 丢掉已有分页，从最新一条重来（历史会变，但只有用户要求时才重读）。
  container.querySelectorAll<HTMLButtonElement>('[data-history-refresh]').forEach((button) => {
    button.addEventListener('click', () => {
      commits = [];
      rows = [];
      walker = new GraphWalker();
      truncated = false;
      view = 'log';
      selectedSha = '';
      selectedPath = '';
      void loadPage(container);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-history-back]').forEach((button) => {
    button.addEventListener('click', () => {
      // 逐级退回：文件 → 文件列表 → 提交列表。数据都还在内存里，直接重绘即可。
      if (button.dataset.historyBack === 'files' && view === 'file') { view = 'files'; selectedPath = ''; void openCommit(container, selectedSha); return; }
      view = 'log';
      selectedSha = '';
      selectedPath = '';
      paint(container, logMarkup());
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-history-file]').forEach((button) => {
    button.addEventListener('click', () => {
      const path = button.dataset.historyFile;
      if (path) void openFile(container, path);
    });
  });
}

async function loadPage(container: HTMLElement): Promise<void> {
  const api = need();
  if (loading || !repoRoot) return;
  loading = true;
  const seq = ++sequence;
  const key = workspaceKey;
  const root = repoRoot;
  const target = { ...currentTarget(), repoRoot: root };
  if (!commits.length) container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  try {
    const result = await api.log(target, { limit: PAGE_SIZE, skip: commits.length });
    if (seq !== sequence || key !== workspaceKey || root !== repoRoot || !visible) return;
    if (!result.ok) {
      paint(container, `<p class="inspector-empty">${api.escapeHtml(result.message ?? api.t('history.failed'))}</p>`);
      return;
    }
    for (const commit of result.commits) {
      commits.push(commit);
      // walker 跨页累积：第二页的行必须接着第一页的 lane 画，否则图会错位。
      rows.push(walker.push({ sha: commit.sha, parents: commit.parents }));
    }
    truncated = result.truncated;
    view = 'log';
    paint(container, logMarkup());
  } catch (cause) {
    if (seq !== sequence || key !== workspaceKey || !visible) return;
    paint(container, `<p class="inspector-empty">${api.escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p>`);
  } finally {
    if (seq === sequence) loading = false;
  }
}

async function openCommit(container: HTMLElement, sha: string): Promise<void> {
  const api = need();
  const seq = ++sequence;
  const key = workspaceKey;
  const root = repoRoot;
  selectedSha = sha;
  view = 'files';
  selectedPath = '';
  const commit = commits.find((item) => item.sha === sha);
  const title = commit ? `${commit.shortSha} ${commit.subject}` : sha.slice(0, 8);
  container.innerHTML = `${repoPicker()}${headerMarkup(title, 'log')}<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  wire(container);
  try {
    const result = await api.commitFiles({ ...currentTarget(), repoRoot: root }, sha);
    if (seq !== sequence || key !== workspaceKey || root !== repoRoot || !visible) return;
    paint(container, `${headerMarkup(title, 'log')}${filesMarkup(result.files ?? [], result.message)}`);
  } catch (cause) {
    if (seq !== sequence || key !== workspaceKey || !visible) return;
    paint(container, `${headerMarkup(title, 'log')}<p class="inspector-empty">${api.escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p>`);
  }
}

async function openFile(container: HTMLElement, path: string): Promise<void> {
  const api = need();
  const seq = ++sequence;
  const key = workspaceKey;
  const root = repoRoot;
  const sha = selectedSha;
  selectedPath = path;
  view = 'file';
  container.innerHTML = `${repoPicker()}${headerMarkup(path, 'files')}<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  wire(container);
  try {
    const result = await api.commitFile({ ...currentTarget(), repoRoot: root }, sha, path);
    if (seq !== sequence || key !== workspaceKey || root !== repoRoot || !visible) return;
    paint(container, `${headerMarkup(path, 'files')}${fileMarkup(sha, path, result)}`);
  } catch (cause) {
    if (seq !== sequence || key !== workspaceKey || !visible) return;
    paint(container, `${headerMarkup(path, 'files')}<p class="inspector-empty">${api.escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p>`);
  }
}

/**
 * 打开/刷新历史视图。工作空间变了就整份丢掉重来（提交列表属于某个仓库，跨空间没有意义）。
 */
export async function refreshHistory(container: HTMLElement): Promise<void> {
  const api = need();
  visible = true;
  const nextKey = currentKey();
  if (nextKey !== workspaceKey) {
    workspaceKey = nextKey;
    resetState();
  }
  if (repoRoot && commits.length && view === 'log') { paint(container, logMarkup()); return; }
  const seq = ++sequence;
  const key = workspaceKey;
  container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  const result = await api.repos(currentTarget());
  if (seq !== sequence || key !== workspaceKey || !visible) return;
  repoList = result.repos ?? [];
  if (!repoList.length) {
    container.innerHTML = `<p class="inspector-empty">${api.escapeHtml(result.message ?? api.t('history.noRepo'))}</p>`;
    return;
  }
  // 默认选第一个仓库（主仓库）；嵌套仓库/子模块用顶部按钮切。
  if (!repoList.some((repo) => repo.root === repoRoot)) repoRoot = repoList[0].root;
  await loadPage(container);
}

export function closeHistory(): void {
  visible = false;
  // 递增序号让在途请求的回执全部作废：关掉面板后再回写 DOM 会闪。
  sequence += 1;
  loading = false;
}

/** 语言切换等需要重绘时用：保留已加载的提交与展开位置。 */
export function repaintHistory(container: HTMLElement): void {
  if (!visible) return;
  if (view === 'files' && selectedSha) { void openCommit(container, selectedSha); return; }
  if (view === 'file' && selectedPath) { void openFile(container, selectedPath); return; }
  paint(container, logMarkup());
}