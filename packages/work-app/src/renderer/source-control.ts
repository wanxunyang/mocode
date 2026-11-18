import type { LocaleKey } from '../i18n/index.js';
import type { PanelEnvelope } from './panels.js';
import { renderUnifiedDiff } from './unified-diff.js';

export interface GitFileView {
  path: string;
  previousPath?: string;
  code: string;
  conflict?: boolean;
}

export interface GitStatusView {
  ok: boolean;
  isRepo: boolean;
  root: string;
  branch: string;
  hasHead: boolean;
  staged: GitFileView[];
  changes: GitFileView[];
  conflicted: boolean;
  /** HEAD 处于 detached 时 branch 为空，改用 head 展示。 */
  detached?: boolean;
  /** HEAD 的短 sha。 */
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  message?: string;
}

/** 一个工作空间里发现的一个仓库（主仓库 / 嵌套仓库 / 子模块 / 工作树）。 */
export interface GitRepoView {
  root: string;
  name: string;
  relative: string;
  kind: 'workspace' | 'nested' | 'submodule' | 'worktree';
  status: GitStatusView;
}

interface GitMutationView {
  ok: boolean;
  status?: GitStatusView;
  commit?: string;
  message?: string;
}

export interface SourceControlTarget {
  taskId?: string;
  projectId?: string;
  /** 目标仓库根；缺省为工作空间自身（主仓库）。 */
  repoRoot?: string;
}

export interface SourceControlDeps {
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string;
  icon: (name: string) => string;
  escapeHtml: (value: string) => string;
  toast: (level: 'info' | 'success' | 'warn' | 'error', text: string, durationMs?: number) => void;
  currentTaskId: () => string | undefined;
  currentProjectId: () => string | undefined;
  /** 工作空间里全部仓库及各自的 status。 */
  repos: (target: SourceControlTarget) => Promise<{ ok: boolean; repos: GitRepoView[]; message?: string }>;
  diff: (target: SourceControlTarget, path: string, staged: boolean) => Promise<{ ok: boolean; content?: string; truncated?: boolean; message?: string }>;
  stage: (target: SourceControlTarget, paths?: string[]) => Promise<GitMutationView>;
  unstage: (target: SourceControlTarget, paths?: string[]) => Promise<GitMutationView>;
  commit: (target: SourceControlTarget, message: string) => Promise<GitMutationView>;
  generate: (command: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<PanelEnvelope>;
}

let deps: SourceControlDeps | null = null;
/** 当前工作空间里发现的全部仓库；每个仓库自带一份 status。 */
let repoList: GitRepoView[] = [];
let reposLoaded = false;
let reposMessage = '';
let workspaceKey = '';
let requestSequence = 0;
// 空间/任务切换与关闭面板都会递增；A→B→A 也不能让旧操作回写新视图。
let operationSequence = 0;
let generating = false;
let generateController: AbortController | null = null;
let busy = false;
let visible = false;
let showingDiff = false;
let selectedFile: { repoRoot: string; path: string; staged: boolean } | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** 提交信息草稿按「工作空间 + 仓库」隔离：多个仓库各自一份，互不覆盖。 */
const draftMemory = new Map<string, string>();

/**
 * AI 生成提交信息的语言。与界面语言解耦：默认英文（提交信息恒英文是既定口径），
 * 需要中文时由用户在提交框上方显式切换，选择跨工作空间保留。
 */
type GenerateLang = 'zh-CN' | 'en-US';
const GENERATE_LANG_KEY = 'mocode-work-scm-generate-lang';
let generateLang: GenerateLang = readGenerateLang();

function readGenerateLang(): GenerateLang {
  try { return localStorage.getItem(GENERATE_LANG_KEY) === 'zh-CN' ? 'zh-CN' : 'en-US'; } catch { return 'en-US'; }
}
function setGenerateLang(value: GenerateLang): void {
  generateLang = value;
  try { localStorage.setItem(GENERATE_LANG_KEY, value); } catch { /* 语言偏好仅作增强 */ }
}

function draftKey(repoRoot: string): string {
  return `${workspaceKey}#${repoRoot}`;
}
function draftFor(repoRoot: string): string {
  const key = draftKey(repoRoot);
  const cached = draftMemory.get(key);
  if (cached !== undefined) return cached;
  try { return localStorage.getItem(`mocode-work-scm-draft:${key}`) ?? ''; } catch { return ''; }
}
function setDraft(repoRoot: string, value: string): void {
  const key = draftKey(repoRoot);
  draftMemory.set(key, value);
  try { localStorage.setItem(`mocode-work-scm-draft:${key}`, value); } catch { /* 草稿仅作增强 */ }
}
function suspendSourceControl(): void {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
  visible = false;
  requestSequence += 1;
  operationSequence += 1;
  generateController?.abort();
  generateController = null;
  generating = false;
  busy = false;
}

export function initSourceControl(injected: SourceControlDeps): void {
  deps = injected;
}

function need(): SourceControlDeps {
  if (!deps) throw new Error('Source control is not initialized.');
  return deps;
}

function currentKey(): string {
  const api = need();
  const taskId = api.currentTaskId();
  const projectId = api.currentProjectId() ?? '';
  // 同一任务换绑空间也要换草稿；无任务空间切换不能带走 A 项目的待提交信息。
  return taskId ? `task:${taskId}:project:${projectId}` : `project:${projectId}`;
}

function currentTarget(): SourceControlTarget {
  const api = need();
  return { taskId: api.currentTaskId(), projectId: api.currentProjectId() };
}

function errorText(raw: string | undefined): string {
  const { t } = need();
  if (!raw || raw === 'NO_STAGED_CHANGES') return t('scm.noStaged');
  const known: Record<string, LocaleKey> = {
    NOT_REPOSITORY: 'scm.notRepo',
    EMPTY_COMMIT_MESSAGE: 'scm.emptyMessage',
    COMMIT_MESSAGE_TOO_LONG: 'scm.messageTooLong',
    UNRESOLVED_CONFLICTS: 'scm.conflicts',
    PATH_NOT_CHANGED: 'scm.pathChanged',
    INVALID_PATH: 'scm.pathChanged',
    INVALID_PATHS: 'scm.pathChanged',
  };
  return known[raw] ? t(known[raw]) : raw;
}

function fileLabel(file: GitFileView): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}

/** 「暂存的更改」/「更改」两个分组的折叠状态，按「空间 + 仓库 + 分组」记。 */
type ScmGroup = 'staged' | 'changes';
const COLLAPSED_KEY = 'mocode-work-scm-collapsed';

/** 折叠偏好跨任务共用（只与仓库有关，与哪个任务在看无关），所以键里不带 taskId。 */
let collapsedGroups = readCollapsedGroups();

function readCollapsedGroups(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function collapsedKey(repoRoot: string, group: ScmGroup): string {
  return `${need().currentProjectId() ?? ''}#${repoRoot}#${group}`;
}

function isGroupCollapsed(repoRoot: string, group: ScmGroup): boolean {
  return collapsedGroups.has(collapsedKey(repoRoot, group));
}

function toggleGroupCollapsed(repoRoot: string, group: ScmGroup): void {
  const key = collapsedKey(repoRoot, group);
  if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups])); } catch { /* 偏好仅作增强 */ }
}

/**
 * 提交框随内容长高：默认一行（CSS 的 min-height），内容换行后按 scrollHeight 撑开，
 * 到 168px 封顶转为内部滚动。
 *
 * 手动量高度而不是交给 CSS：草稿是渲染后由 JS 写进 `value` 的（见 renderSourceControl），
 * 纯 CSS 方案不会因为这次赋值重新算高度，草稿多行时框还停在一行。所以走 renderer 的
 * resizePrompt 同一套：先置 auto 再取 scrollHeight —— 不重置的话高度只会单调变大，删字后收不回去。
 * 三个入口都要量：重绘后写草稿、用户输入、AI 生成回填。
 */
const COMMIT_BOX_MAX = 168;
function resizeCommitBox(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  // scrollHeight 在元素未挂到文档/未布局时会是 0：别把高度写成 0px，交给 CSS 的 min-height 兜住。
  const measured = textarea.scrollHeight;
  textarea.style.height = Number.isFinite(measured) && measured > 0 ? `${Math.min(measured, COMMIT_BOX_MAX)}px` : '';
}

function fileRows(repoRoot: string, files: GitFileView[], staged: boolean): string {
  const { escapeHtml, t, icon } = need();
  const repo = escapeHtml(repoRoot);
  if (!files.length) return `<p class="scm-empty">${t(staged ? 'scm.noStagedShort' : 'scm.clean')}</p>`;
  return files.map((file) => {
    const action = staged ? 'unstage' : 'stage';
    const title = t(staged ? 'scm.unstageFile' : 'scm.stageFile');
    const conflict = file.conflict ? ` title="${t('scm.conflictHint')}"` : '';
    return `<div class="scm-file-row"><button class="scm-file-name" data-scm-diff="${escapeHtml(file.path)}" data-scm-repo="${repo}" data-staged="${staged}" title="${escapeHtml(fileLabel(file))}"><span class="scm-file-path">${escapeHtml(fileLabel(file))}</span><span class="scm-file-code"${conflict}>${escapeHtml(file.code)}</span></button><button class="scm-file-action" data-scm-action="${action}" data-scm-repo="${repo}" data-path="${escapeHtml(file.path)}" title="${title}" aria-label="${title}">${icon(staged ? 'minus' : 'plus')}</button></div>`;
  }).join('');
}

/**
 * 一个分组（暂存区 / 更改）：标题行可点，点一下折叠文件列表。
 * 默认展开 —— 与 VS Code 一致；收起状态记住，5 秒轮询重绘也不会把它弹回来
 * （重绘读的就是 collapsedGroups，不在 DOM 里存状态）。
 */
function groupMarkup(repoRoot: string, files: GitFileView[], staged: boolean): string {
  const { escapeHtml, t, icon } = need();
  const group: ScmGroup = staged ? 'staged' : 'changes';
  const collapsed = isGroupCollapsed(repoRoot, group);
  const repo = escapeHtml(repoRoot);
  const disabled = files.length ? '' : ' disabled';
  return `<section class="scm-group${collapsed ? ' is-collapsed' : ''}">
      <header><button class="scm-group-toggle" data-scm-toggle="${group}" data-scm-repo="${repo}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${t('scm.toggleGroup')}">${icon(collapsed ? 'chevron-right' : 'chevron-down')}<span class="scm-group-title">${t(staged ? 'scm.staged' : 'scm.changes')}</span><span class="scm-group-count">${files.length}</span></button><button data-scm-action="${staged ? 'unstage-all' : 'stage-all'}" data-scm-repo="${repo}"${disabled} title="${t(staged ? 'scm.unstageAll' : 'scm.stageAll')}">${icon(staged ? 'minus' : 'plus')}<span>${t('scm.all')}</span></button></header>
      <div class="scm-files">${fileRows(repoRoot, files, staged)}</div>
    </section>`;
}

function langMarkup(): string {
  const { t } = need();
  const options: Array<{ code: GenerateLang; labelKey: LocaleKey }> = [
    { code: 'en-US', labelKey: 'scm.langEn' },
    { code: 'zh-CN', labelKey: 'scm.langZh' },
  ];
  return `<div class="scm-lang" role="radiogroup" aria-label="${t('scm.generateLang')}">${options.map(({ code, labelKey }) => `<button class="scm-lang-option" data-scm-lang="${code}" role="radio" aria-checked="${generateLang === code}" title="${t('scm.generateLang')}">${t(labelKey)}</button>`).join('')}</div>`;
}

/** 分支标识：detached 用短 sha（VS Code 同口径），否则分支名，空仓库提示尚无提交。 */
function branchLabel(status: GitStatusView): string {
  const { t } = need();
  if (status.branch) return status.branch;
  return status.head ?? t('scm.unborn');
}

function upstreamMarkup(status: GitStatusView): string {
  const { escapeHtml } = need();
  if (!status.upstream) return '';
  const counts = [status.ahead ? `↑${status.ahead}` : '', status.behind ? `↓${status.behind}` : ''].filter(Boolean).join(' ');
  return `<span class="scm-upstream" title="${escapeHtml(status.upstream)}">${escapeHtml(status.upstream)}${counts ? ` ${escapeHtml(counts)}` : ''}</span>`;
}

/**
 * 一个仓库一块：仓库名 + 分支/上游标识 + 自己的暂存区/更改 + 自己的提交框与 AI 生成。
 * 多仓库时各块互不影响：提交只动这个仓库的 index，AI 生成也只读这个仓库的暂存 diff。
 *
 * 这里刻意不放提交历史：历史在「历史」页，那边有分页、泳道、文件列表与行级 diff；
 * 在这个面板里再摆一份残缺的最近提交，只是把同一份信息读两遍。
 */
function repoMarkup(repo: GitRepoView): string {
  const { t, icon, escapeHtml } = need();
  const status = repo.status;
  const root = escapeHtml(repo.root);
  const stagedDisabled = status.staged.length ? '' : ' disabled';
  const kindLabel = repo.kind === 'workspace'
    ? ''
    : `<span class="scm-repo-kind">${t(repo.kind === 'submodule' ? 'scm.kindSubmodule' : repo.kind === 'worktree' ? 'scm.kindWorktree' : 'scm.kindNested')}</span>`;
  const heading = repo.kind === 'workspace' ? (repo.name || t('scm.branchLabel')) : repo.name;
  const unavailable = `<section class="scm-repo"><header class="scm-repo-head"><span class="scm-repo-name" title="${root}">${icon('branch')}<b>${escapeHtml(heading)}</b></span>${kindLabel}</header><p class="scm-empty">${escapeHtml(status.message ? errorText(status.message) : t('scm.notRepo'))}</p></section>`;
  if (!status.ok || !status.isRepo) return unavailable;
  return `<section class="scm-repo" data-scm-repo-group="${root}">
    <header class="scm-repo-head">
      <span class="scm-repo-name" title="${root}">${icon('branch')}<b>${escapeHtml(heading)}</b></span>
      ${kindLabel}
      <span class="scm-repo-branch${status.detached ? ' detached' : ''}">${escapeHtml(branchLabel(status))}</span>
      ${upstreamMarkup(status)}
      <button data-scm-action="refresh" data-scm-repo="${root}" class="scm-icon-button" title="${t('scm.refresh')}" aria-label="${t('scm.refresh')}">${icon('regen')}</button>
    </header>
    ${status.conflicted ? `<p class="scm-warning">${t('scm.conflicts')}</p>` : ''}
    ${groupMarkup(repo.root, status.staged, true)}
    ${groupMarkup(repo.root, status.changes, false)}
    <section class="scm-commit"><div class="scm-commit-head"><label>${t('scm.messageLabel')}</label>${langMarkup()}</div><textarea data-scm-message="${root}" rows="1" maxlength="10000" placeholder="${t('scm.messagePlaceholder')}"></textarea><p class="scm-hint">${t('scm.commitHint')}</p><div class="scm-commit-actions"><button data-scm-action="generate" data-scm-repo="${root}" class="scm-ai"${stagedDisabled}>${icon('sparkles')}<span>${t('scm.generate')}</span></button><button data-scm-action="commit" data-scm-repo="${root}" class="scm-primary"${stagedDisabled}>${icon('check')}<span>${t('scm.commit')}</span></button></div></section>
  </section>`;
}

function wireDiff(container: HTMLElement): void {
  container.querySelector<HTMLButtonElement>('[data-scm-action="back"]')?.addEventListener('click', () => {
    showingDiff = false;
    selectedFile = null;
    void refreshSourceControl(container);
  });
}

async function showFileDiff(container: HTMLElement, repoRoot: string, path: string, staged: boolean): Promise<void> {
  const api = need();
  const key = workspaceKey;
  const seq = ++requestSequence;
  const target: SourceControlTarget = { ...currentTarget(), repoRoot };
  selectedFile = { repoRoot, path, staged };
  showingDiff = true;
  container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  try {
    const result = await api.diff(target, path, staged);
    if (seq !== requestSequence || key !== workspaceKey || !visible) return;
    const title = staged ? api.t('scm.stagedDiff') : api.t('scm.workingDiff');
    const text = result.content ?? errorText(result.message);
    // 统一 diff 走并排行级渲染（左原始 / 右改动后、双行号、红绿底 + 语法高亮）；
    // 解析不了才退回原文 <pre>，例如二进制文件、mode-only 改动、冲突提示 —— 那几种
    // 本来就没有可染色的行。
    const rendered = renderUnifiedDiff(text, {
      moreLines: (n) => api.t('tool.moreLines', { n }),
      oldSide: api.t('diff.oldSide'),
      newSide: api.t('diff.newSide'),
    });
    const body = rendered ?? `<pre class="file-preview diff-preview scm-diff">${api.escapeHtml(text)}</pre>`;
    container.innerHTML = `<div class="scm-diff-header"><button data-scm-action="back">${api.icon('arrow-left')}<span>${api.t('scm.back')}</span></button><span>${api.escapeHtml(title)}</span></div><h3 class="scm-diff-path">${api.escapeHtml(path)}</h3>${body}${result.truncated ? `<p class="scm-hint">${api.t('scm.diffTruncated')}</p>` : ''}`;
    wireDiff(container);
  } catch (cause) {
    if (seq !== requestSequence || !visible) return;
    container.innerHTML = `<div class="scm-diff-header"><button data-scm-action="back">${api.icon('arrow-left')}<span>${api.t('scm.back')}</span></button></div><p class="scm-error">${api.escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p>`;
    wireDiff(container);
  }
}

async function mutate(container: HTMLElement, repoRoot: string, action: 'stage' | 'unstage', paths?: string[]): Promise<void> {
  if (busy || generating) return;
  busy = true;
  const operation = ++operationSequence;
  const api = need();
  const key = workspaceKey;
  const target: SourceControlTarget = { ...currentTarget(), repoRoot };
  container.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = action === 'stage'
      ? await api.stage(target, paths)
      : await api.unstage(target, paths);
    if (operation !== operationSequence || key !== workspaceKey || !visible) return;
    if (!result.ok) { api.toast('error', errorText(result.message), 6000); return; }
  } catch (cause) {
    if (operation !== operationSequence || key !== workspaceKey || !visible) return;
    api.toast('error', cause instanceof Error ? cause.message : String(cause), 6000);
    await refreshSourceControl(container);
  } finally {
    if (operation !== operationSequence) return;
    busy = false;
    if (key === workspaceKey && visible) await refreshSourceControl(container);
  }
}

async function generate(container: HTMLElement, repoRoot: string): Promise<void> {
  const repo = repoList.find((item) => item.root === repoRoot);
  if (generating || busy || !repo?.status.staged.length) return;
  generating = true;
  const controller = new AbortController();
  generateController = controller;
  const operation = ++operationSequence;
  const api = need();
  const key = workspaceKey;
  const target: SourceControlTarget = { ...currentTarget(), repoRoot };
  // 先把输入框里的内容写回该仓库的草稿：生成失败时用户写的东西不能丢。
  const textarea = container.querySelector<HTMLTextAreaElement>(`textarea[data-scm-message="${CSS.escape(repoRoot)}"]`);
  if (textarea) setDraft(repoRoot, textarea.value);
  renderSourceControl(container);
  try {
    // 只把「这个仓库」的暂存 diff 交给 host，并标明仓库与分支；
    // 否则同一工作空间下的多个仓库/分支会互相串提示词。
    const response = await api.generate({
      type: 'commit_message', ...target, language: generateLang,
      repo: repo.relative || repo.name,
      ...(repo.status.branch || repo.status.head ? { branch: repo.status.branch || repo.status.head } : {}),
    }, { signal: controller.signal });
    if (response.type === 'cancelled' || operation !== operationSequence || key !== workspaceKey || !visible) return;
    if (response.type === 'error') { api.toast('error', errorText(response.error), 6500); return; }
    const generated = typeof response.payload?.message === 'string' ? response.payload.message.trim() : '';
    if (!generated) { api.toast('error', api.t('scm.generateFailed'), 5000); return; }
    // AI 只替换该仓库的输入框；提交始终由用户再次检查并点击。
    setDraft(repoRoot, generated);
    const box = container.querySelector<HTMLTextAreaElement>(`textarea[data-scm-message="${CSS.escape(repoRoot)}"]`);
    // 生成的是可能多行的提交信息：直接写 value 不会触发布局，得手动再量一次高度。
    if (box) { box.value = generated; resizeCommitBox(box); box.focus(); }
    api.toast('success', api.t('scm.generated'), 3000);
  } catch (cause) {
    if (operation === operationSequence && key === workspaceKey && visible) api.toast('error', cause instanceof Error ? cause.message : String(cause), 6000);
  } finally {
    if (operation !== operationSequence) return;
    generateController = null;
    generating = false;
    if (key === workspaceKey && visible && !showingDiff) await refreshSourceControl(container);
  }
}

async function commit(container: HTMLElement, repoRoot: string): Promise<void> {
  const repo = repoList.find((item) => item.root === repoRoot);
  if (busy || generating || !repo?.status.staged.length) return;
  const api = need();
  const message = container.querySelector<HTMLTextAreaElement>(`textarea[data-scm-message="${CSS.escape(repoRoot)}"]`)?.value ?? draftFor(repoRoot);
  if (!message.trim()) { api.toast('warn', api.t('scm.emptyMessage'), 3500); return; }
  busy = true;
  const operation = ++operationSequence;
  const key = workspaceKey;
  const target: SourceControlTarget = { ...currentTarget(), repoRoot };
  container.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = await api.commit(target, message);
    if (operation !== operationSequence || key !== workspaceKey || !visible) return;
    if (!result.ok) { api.toast('error', errorText(result.message), 6500); return; }
    setDraft(repoRoot, '');
    api.toast('success', api.t('scm.committed', { commit: result.commit ?? '' }), 6500);
  } catch (cause) {
    if (operation !== operationSequence || key !== workspaceKey || !visible) return;
    api.toast('error', cause instanceof Error ? cause.message : String(cause), 6000);
    await refreshSourceControl(container);
  } finally {
    if (operation !== operationSequence) return;
    busy = false;
    if (key === workspaceKey && visible) await refreshSourceControl(container);
  }
}

function renderSourceControl(container: HTMLElement): void {
  const api = need();
  if (showingDiff && selectedFile) { void showFileDiff(container, selectedFile.repoRoot, selectedFile.path, selectedFile.staged); return; }
  if (!reposLoaded) { container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`; return; }
  if (!repoList.length) {
    container.innerHTML = `<section class="scm-unavailable">${api.icon('branch')}<p>${api.t('scm.notRepo')}</p>${reposMessage ? `<small>${api.escapeHtml(errorText(reposMessage))}</small>` : ''}</section>`;
    return;
  }
  const scrollTop = container.scrollTop;
  // 重绘是整块 innerHTML 重建：先把焦点输入框的内容与光标位置留住。
  const active = document.activeElement instanceof HTMLTextAreaElement && container.contains(document.activeElement)
    ? document.activeElement : null;
  const focusedRoot = active?.dataset.scmMessage ?? '';
  const selection = active ? { start: active.selectionStart, end: active.selectionEnd } : null;
  if (active) setDraft(focusedRoot, active.value);
  container.innerHTML = repoList.map((repo) => repoMarkup(repo)).join('');
  container.querySelectorAll<HTMLTextAreaElement>('textarea[data-scm-message]').forEach((textarea) => {
    const root = textarea.dataset.scmMessage ?? '';
    textarea.value = draftFor(root);
    textarea.disabled = generating || busy;
    resizeCommitBox(textarea);
    textarea.addEventListener('input', () => {
      setDraft(root, textarea.value);
      resizeCommitBox(textarea);
    });
    if (root === focusedRoot && selection) {
      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(Math.min(selection.start, length), Math.min(selection.end, length));
    }
  });
  container.querySelectorAll<HTMLButtonElement>('[data-scm-action]').forEach((button) => {
    if (button.dataset.scmAction === 'refresh') button.disabled = busy;
    else button.disabled = busy || generating;
  });
  if (generating) {
    container.querySelectorAll<HTMLButtonElement>('[data-scm-action="generate"]').forEach((button) => {
      button.innerHTML = `${api.icon('loader')}<span>${api.t('scm.generating')}</span>`;
    });
  }
  container.querySelectorAll<HTMLButtonElement>('[data-scm-lang]').forEach((button) => {
    button.disabled = busy || generating;
    button.addEventListener('click', () => {
      const next: GenerateLang = button.dataset.scmLang === 'zh-CN' ? 'zh-CN' : 'en-US';
      if (next === generateLang) return;
      setGenerateLang(next);
      // 只重绘选择态：输入框内容来自各自仓库的草稿，不受影响。
      renderSourceControl(container);
    });
  });
  /* 分组折叠：只切 class + 图标，不重绘整块（重绘会把滚动位置和输入框焦点一起折腾）。
   * 折叠状态同时写进 collapsedGroups，下一次轮询重绘照旧是收起的。 */
  container.querySelectorAll<HTMLButtonElement>('[data-scm-toggle]').forEach((button) => button.addEventListener('click', () => {
    const repoRoot = button.dataset.scmRepo ?? '';
    const group: ScmGroup = button.dataset.scmToggle === 'staged' ? 'staged' : 'changes';
    toggleGroupCollapsed(repoRoot, group);
    const collapsed = isGroupCollapsed(repoRoot, group);
    button.closest('.scm-group')?.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    // 箭头是已注入的 SVG（icon() 的产物没有 data-icon 占位属性），只能整颗换掉。
    const glyph = button.querySelector('svg');
    if (glyph) glyph.outerHTML = need().icon(collapsed ? 'chevron-right' : 'chevron-down');
  }));
  container.querySelectorAll<HTMLButtonElement>('[data-scm-diff]').forEach((button) => button.addEventListener('click', () => {
    const path = button.dataset.scmDiff;
    const repoRoot = button.dataset.scmRepo ?? '';
    if (path && repoRoot) void showFileDiff(container, repoRoot, path, button.dataset.staged === 'true');
  }));
  container.querySelectorAll<HTMLButtonElement>('[data-scm-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.scmAction;
    const repoRoot = button.dataset.scmRepo ?? '';
    if (action === 'refresh') void refreshSourceControl(container);
    else if (!repoRoot) return;
    else if (action === 'stage') void mutate(container, repoRoot, 'stage', [button.dataset.path!]);
    else if (action === 'unstage') void mutate(container, repoRoot, 'unstage', [button.dataset.path!]);
    else if (action === 'stage-all') void mutate(container, repoRoot, 'stage');
    else if (action === 'unstage-all') void mutate(container, repoRoot, 'unstage');
    else if (action === 'generate') void generate(container, repoRoot);
    else if (action === 'commit') void commit(container, repoRoot);
  }));
  container.scrollTop = scrollTop;
}

/** 工作空间切换时丢弃上一个空间的仓库列表与逐仓库草稿缓存。 */
function resetForWorkspace(nextKey: string): void {
  suspendSourceControl();
  workspaceKey = nextKey;
  repoList = [];
  reposLoaded = false;
  reposMessage = '';
  selectedFile = null;
  showingDiff = false;
  generating = false;
  busy = false;
}

/**
 * 跑一次渲染，失败就换成「渲染失败」空态并返回 false。
 *
 * 与「读 repos 失败」严格分开：渲染抛异常意味着这段 UI 代码自身有 bug，
 * 此时 repoList 里往往**有**数据，清空它只会把 bug 伪装成「不是 Git 仓库」。
 */
function paintSafely(container: HTMLElement, paint: () => void): boolean {
  try {
    paint();
    return true;
  } catch (cause) {
    const api = need();
    const detail = cause instanceof Error ? cause.message : String(cause);
    // 栈留在控制台：界面只给可行动的提示，细节归日志。
    console.error('[source-control] 渲染面板失败：', cause);
    // 兜底文案里刻意不调 icon()：渲染崩的原因可能就是它，错误处理里再抛一次
    // 会把原始异常整个吃掉，反倒只剩一个白面板。
    container.innerHTML = `<section class="scm-unavailable"><p>${api.t('scm.paintFailed')}</p><small>${api.escapeHtml(detail)}</small></section>`;
    return false;
  }
}

export async function refreshSourceControl(container: HTMLElement): Promise<void> {
  const api = need();
  const nextKey = currentKey();
  if (nextKey !== workspaceKey) resetForWorkspace(nextKey);
  visible = true;
  if (showingDiff && selectedFile) { await showFileDiff(container, selectedFile.repoRoot, selectedFile.path, selectedFile.staged); return; }
  const seq = ++requestSequence;
  const key = workspaceKey;
  const target = currentTarget();
  // 定时刷新不能把正在输入的内容或已渲染的面板重置成 loading。
  if (!reposLoaded) container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  let result: { ok: boolean; repos: GitRepoView[]; message?: string };
  try {
    result = await api.repos(target);
  } catch (cause) {
    // 读不到仓库列表（git 不在、目录被删…）：这才是「读不到仓库」的正确来源。
    if (seq !== requestSequence || key !== workspaceKey || !visible) return;
    reposLoaded = true;
    repoList = [];
    reposMessage = cause instanceof Error ? cause.message : String(cause);
    paintSafely(container, () => renderSourceControl(container));
    return;
  }
  if (seq !== requestSequence || key !== workspaceKey || !visible) return;
  repoList = result.repos;
  reposLoaded = true;
  reposMessage = result.message ?? '';
  if (seq !== requestSequence || key !== workspaceKey || !visible) return;
  // ⚠ 渲染必须单独兜底：它抛的是渲染器自己的 bug，与「这个目录不是 Git 仓库」无关。
  // 二者曾共用一个 catch —— 于是渲染一崩就清空 repoList 并显示「当前空间不是 Git 仓库」，
  // 真实原因只缩在 <small> 里，排查时几乎只能靠猜。
  if (!paintSafely(container, () => renderSourceControl(container))) return;
  if (!generating && !busy && refreshTimer === null) {
    refreshTimer = setInterval(() => {
      if (visible && !busy && !generating && !document.hidden) void refreshSourceControl(container);
    }, 5_000);
  }
}

export function closeSourceControl(): void {
  suspendSourceControl();
}

/** 菜单/语言切换重绘时复用同一份状态，但显式刷新仍读取最新暂存区。 */
export function reopenSourceControl(container: HTMLElement): void {
  const nextKey = currentKey();
  if (nextKey !== workspaceKey) resetForWorkspace(nextKey);
  visible = true;
  // 关闭期间外部编辑器可能改过 Git，重开时总是读最新状态并恢复轮询。
  void refreshSourceControl(container);
}