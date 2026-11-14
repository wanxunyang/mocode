import type { LocaleKey } from '../i18n/index.js';
import type { PanelEnvelope } from './panels.js';

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
  message?: string;
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
}

export interface SourceControlDeps {
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string;
  icon: (name: string) => string;
  escapeHtml: (value: string) => string;
  toast: (level: 'info' | 'success' | 'warn' | 'error', text: string, durationMs?: number) => void;
  currentTaskId: () => string | undefined;
  currentProjectId: () => string | undefined;
  status: (target: SourceControlTarget) => Promise<GitStatusView>;
  diff: (target: SourceControlTarget, path: string, staged: boolean) => Promise<{ ok: boolean; content?: string; truncated?: boolean; message?: string }>;
  stage: (target: SourceControlTarget, paths?: string[]) => Promise<GitMutationView>;
  unstage: (target: SourceControlTarget, paths?: string[]) => Promise<GitMutationView>;
  commit: (target: SourceControlTarget, message: string) => Promise<GitMutationView>;
  generate: (command: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<PanelEnvelope>;
}

let deps: SourceControlDeps | null = null;
let snapshot: GitStatusView | null = null;
let workspaceKey = '';
let requestSequence = 0;
// 空间/任务切换与关闭面板都会递增；A→B→A 也不能让旧操作回写新视图。
let operationSequence = 0;
let generating = false;
let generateController: AbortController | null = null;
let busy = false;
let visible = false;
let showingDiff = false;
let selectedFile: { path: string; staged: boolean } | null = null;
let draft = '';
let draftSaved = '';
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const drafts = new Map<string, string>();

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

function saveDraft(key: string, value: string): void {
  drafts.set(key, value);
  try { localStorage.setItem(`mocode-work-scm-draft:${key}`, value); } catch { /* 草稿仅作增强 */ }
}
function loadDraft(key: string): string {
  const cached = drafts.get(key);
  if (cached !== undefined) return cached;
  try { return localStorage.getItem(`mocode-work-scm-draft:${key}`) ?? ''; } catch { return ''; }
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
  if (workspaceKey) saveDraft(workspaceKey, draft);
  draftSaved = draft;
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

function fileRows(files: GitFileView[], staged: boolean): string {
  const { escapeHtml, t, icon } = need();
  if (!files.length) return `<p class="scm-empty">${t(staged ? 'scm.noStagedShort' : 'scm.clean')}</p>`;
  return files.map((file) => {
    const action = staged ? 'unstage' : 'stage';
    const title = t(staged ? 'scm.unstageFile' : 'scm.stageFile');
    const conflict = file.conflict ? ` title="${t('scm.conflictHint')}"` : '';
    return `<div class="scm-file-row"><button class="scm-file-name" data-scm-diff="${escapeHtml(file.path)}" data-staged="${staged}" title="${escapeHtml(fileLabel(file))}"><span class="scm-file-path">${escapeHtml(fileLabel(file))}</span><span class="scm-file-code"${conflict}>${escapeHtml(file.code)}</span></button><button class="scm-file-action" data-scm-action="${action}" data-path="${escapeHtml(file.path)}" title="${title}" aria-label="${title}">${icon(staged ? 'minus' : 'plus')}</button></div>`;
  }).join('');
}

function langMarkup(): string {
  const { t } = need();
  const options: Array<{ code: GenerateLang; labelKey: LocaleKey }> = [
    { code: 'en-US', labelKey: 'scm.langEn' },
    { code: 'zh-CN', labelKey: 'scm.langZh' },
  ];
  return `<div class="scm-lang" role="radiogroup" aria-label="${t('scm.generateLang')}">${options.map(({ code, labelKey }) => `<button class="scm-lang-option" data-scm-lang="${code}" role="radio" aria-checked="${generateLang === code}" title="${t('scm.generateLang')}">${t(labelKey)}</button>`).join('')}</div>`;
}

function statusMarkup(status: GitStatusView): string {
  const { t, icon, escapeHtml } = need();
  const stagedDisabled = status.staged.length ? '' : ' disabled';
  const changesDisabled = status.changes.length ? '' : ' disabled';
  return `<section class="scm-branch"><span>${icon('branch')}<b>${escapeHtml(status.branch || t('scm.unborn'))}</b></span><button data-scm-action="refresh" class="scm-icon-button" title="${t('scm.refresh')}" aria-label="${t('scm.refresh')}">${icon('regen')}</button></section>
    ${status.conflicted ? `<p class="scm-warning">${t('scm.conflicts')}</p>` : ''}
    <section class="scm-group"><header><h3>${t('scm.staged')} <span>${status.staged.length}</span></h3><button data-scm-action="unstage-all"${stagedDisabled} title="${t('scm.unstageAll')}">${icon('minus')}<span>${t('scm.all')}</span></button></header><div class="scm-files">${fileRows(status.staged, true)}</div></section>
    <section class="scm-group"><header><h3>${t('scm.changes')} <span>${status.changes.length}</span></h3><button data-scm-action="stage-all"${changesDisabled} title="${t('scm.stageAll')}">${icon('plus')}<span>${t('scm.all')}</span></button></header><div class="scm-files">${fileRows(status.changes, false)}</div></section>
    <section class="scm-commit"><div class="scm-commit-head"><label for="scm-message">${t('scm.messageLabel')}</label>${langMarkup()}</div><textarea id="scm-message" rows="4" maxlength="10000" placeholder="${t('scm.messagePlaceholder')}"></textarea><p class="scm-hint">${t('scm.commitHint')}</p><div class="scm-commit-actions"><button data-scm-action="generate" class="scm-ai"${stagedDisabled}>${icon('sparkles')}<span>${t('scm.generate')}</span></button><button data-scm-action="commit" class="scm-primary"${stagedDisabled}>${icon('check')}<span>${t('scm.commit')}</span></button></div></section>`;
}

function wireDiff(container: HTMLElement): void {
  container.querySelector<HTMLButtonElement>('[data-scm-action="back"]')?.addEventListener('click', () => {
    showingDiff = false;
    selectedFile = null;
    void refreshSourceControl(container);
  });
}

async function showFileDiff(container: HTMLElement, path: string, staged: boolean): Promise<void> {
  const api = need();
  const key = workspaceKey;
  const seq = ++requestSequence;
  const target = currentTarget();
  selectedFile = { path, staged };
  showingDiff = true;
  container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  try {
    const result = await api.diff(target, path, staged);
    if (seq !== requestSequence || key !== workspaceKey || !visible) return;
    const title = staged ? api.t('scm.stagedDiff') : api.t('scm.workingDiff');
    container.innerHTML = `<div class="scm-diff-header"><button data-scm-action="back">${api.icon('arrow-left')}<span>${api.t('scm.back')}</span></button><span>${api.escapeHtml(title)}</span></div><h3 class="scm-diff-path">${api.escapeHtml(path)}</h3><pre class="file-preview diff-preview scm-diff">${api.escapeHtml(result.content ?? errorText(result.message))}</pre>${result.truncated ? `<p class="scm-hint">${api.t('scm.diffTruncated')}</p>` : ''}`;
    wireDiff(container);
  } catch (cause) {
    if (seq !== requestSequence || !visible) return;
    container.innerHTML = `<div class="scm-diff-header"><button data-scm-action="back">${api.icon('arrow-left')}<span>${api.t('scm.back')}</span></button></div><p class="scm-error">${api.escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p>`;
    wireDiff(container);
  }
}

async function mutate(container: HTMLElement, action: 'stage' | 'unstage', paths?: string[]): Promise<void> {
  if (busy || generating) return;
  busy = true;
  const operation = ++operationSequence;
  const api = need();
  const key = workspaceKey;
  const target = currentTarget();
  container.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = action === 'stage'
      ? await api.stage(target, paths)
      : await api.unstage(target, paths);
    if (operation !== operationSequence || key !== workspaceKey || !visible) return;
    if (!result.ok) { api.toast('error', errorText(result.message), 6000); return; }
    if (result.status) snapshot = result.status;
    draftSaved = draft;
    renderSourceControl(container);
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

async function generate(container: HTMLElement): Promise<void> {
  if (generating || busy || !snapshot?.staged.length) return;
  generating = true;
  const controller = new AbortController();
  generateController = controller;
  const operation = ++operationSequence;
  const api = need();
  const key = workspaceKey;
  const target = currentTarget();
  const message = container.querySelector<HTMLTextAreaElement>('#scm-message');
  if (message) draft = message.value;
  draftSaved = draft;
  renderSourceControl(container);
  try {
    const response = await api.generate({ type: 'commit_message', ...target, language: generateLang }, { signal: controller.signal });
    if (response.type === 'cancelled' || operation !== operationSequence || key !== workspaceKey || !visible) return;
    if (response.type === 'error') { api.toast('error', errorText(response.error), 6500); return; }
    const generated = typeof response.payload?.message === 'string' ? response.payload.message.trim() : '';
    if (!generated) { api.toast('error', api.t('scm.generateFailed'), 5000); return; }
    // AI 只替换输入框；提交始终由用户再次检查并点击。
    draft = generated;
    draftSaved = generated;
    saveDraft(key, generated);
    const textarea = container.querySelector<HTMLTextAreaElement>('#scm-message');
    if (textarea) { textarea.value = generated; textarea.focus(); }
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

async function commit(container: HTMLElement): Promise<void> {
  if (busy || generating || !snapshot?.staged.length) return;
  const api = need();
  const message = container.querySelector<HTMLTextAreaElement>('#scm-message')?.value ?? draft;
  draft = message;
  if (!message.trim()) { api.toast('warn', api.t('scm.emptyMessage'), 3500); return; }
  busy = true;
  const operation = ++operationSequence;
  const key = workspaceKey;
  const target = currentTarget();
  container.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = await api.commit(target, message);
    if (operation !== operationSequence || key !== workspaceKey || !visible) return;
    if (!result.ok) { api.toast('error', errorText(result.message), 6500); return; }
    snapshot = result.status ?? snapshot;
    draft = '';
    draftSaved = '';
    saveDraft(key, '');
    renderSourceControl(container);
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
  if (showingDiff && selectedFile) { void showFileDiff(container, selectedFile.path, selectedFile.staged); return; }
  if (!snapshot) { container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`; return; }
  if (!snapshot.ok || !snapshot.isRepo) {
    container.innerHTML = `<section class="scm-unavailable">${api.icon('branch')}<p>${api.t('scm.notRepo')}</p>${snapshot.message ? `<small>${api.escapeHtml(errorText(snapshot.message))}</small>` : ''}</section>`;
    return;
  }
  const scrollTop = container.scrollTop;
  const previousMessage = container.querySelector<HTMLTextAreaElement>('#scm-message');
  const selection = previousMessage && document.activeElement === previousMessage
    ? { start: previousMessage.selectionStart, end: previousMessage.selectionEnd } : null;
  container.innerHTML = statusMarkup(snapshot);
  const textarea = container.querySelector<HTMLTextAreaElement>('#scm-message');
  if (textarea) {
    textarea.value = draft;
    textarea.disabled = generating || busy;
    textarea.addEventListener('input', () => {
      draft = textarea.value;
      draftSaved = draft;
      saveDraft(workspaceKey, draft);
    });
    if (selection) {
      textarea.focus();
      textarea.setSelectionRange(Math.min(selection.start, draft.length), Math.min(selection.end, draft.length));
    }
  }
  container.querySelectorAll<HTMLButtonElement>('[data-scm-action]').forEach((button) => {
    if (button.dataset.scmAction === 'refresh') button.disabled = busy;
    else button.disabled = busy || generating;
  });
  if (generating) {
    const button = container.querySelector<HTMLButtonElement>('[data-scm-action="generate"]');
    if (button) button.innerHTML = `${api.icon('loader')}<span>${api.t('scm.generating')}</span>`;
  }
  container.querySelectorAll<HTMLButtonElement>('[data-scm-lang]').forEach((button) => {
    button.disabled = busy || generating;
    button.addEventListener('click', () => {
      const next: GenerateLang = button.dataset.scmLang === 'zh-CN' ? 'zh-CN' : 'en-US';
      if (next === generateLang) return;
      setGenerateLang(next);
      // 只重绘选择态：输入框内容来自 draft，不受影响。
      renderSourceControl(container);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-scm-diff]').forEach((button) => button.addEventListener('click', () => {
    const path = button.dataset.scmDiff;
    if (path) void showFileDiff(container, path, button.dataset.staged === 'true');
  }));
  container.querySelectorAll<HTMLButtonElement>('[data-scm-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.scmAction;
    if (action === 'refresh') void refreshSourceControl(container);
    else if (action === 'stage') void mutate(container, 'stage', [button.dataset.path!]);
    else if (action === 'unstage') void mutate(container, 'unstage', [button.dataset.path!]);
    else if (action === 'stage-all') void mutate(container, 'stage');
    else if (action === 'unstage-all') void mutate(container, 'unstage');
    else if (action === 'generate') void generate(container);
    else if (action === 'commit') void commit(container);
  }));
  container.scrollTop = scrollTop;
}

export async function refreshSourceControl(container: HTMLElement): Promise<void> {
  const api = need();
  const nextKey = currentKey();
  if (nextKey !== workspaceKey) {
    suspendSourceControl();
    workspaceKey = nextKey;
    snapshot = null;
    selectedFile = null;
    showingDiff = false;
    draft = loadDraft(nextKey);
    draftSaved = draft;
    generating = false;
    busy = false;
  }
  visible = true;
  if (showingDiff && selectedFile) { await showFileDiff(container, selectedFile.path, selectedFile.staged); return; }
  const seq = ++requestSequence;
  const key = workspaceKey;
  const target = currentTarget();
  const message = container.querySelector<HTMLTextAreaElement>('#scm-message');
  if (message) { draft = message.value; draftSaved = draft; }
  // 定时刷新不能把正在输入的内容重置成 loading。
  if (!snapshot) container.innerHTML = `<p class="inspector-loading">${api.t('inspector.loading')}</p>`;
  try {
    const result = await api.status(target);
    if (seq !== requestSequence || key !== workspaceKey || !visible) return;
    snapshot = result;
    draft = draftSaved;
    renderSourceControl(container);
    if (!generating && !busy && refreshTimer === null) {
      refreshTimer = setInterval(() => {
        if (visible && !busy && !generating && !document.hidden) void refreshSourceControl(container);
      }, 5_000);
    }
  } catch (cause) {
    if (seq !== requestSequence || !visible) return;
    container.innerHTML = `<p class="scm-error">${api.escapeHtml(cause instanceof Error ? cause.message : String(cause))}</p>`;
  }
}

export function closeSourceControl(): void {
  suspendSourceControl();
}

/** 菜单/语言切换重绘时复用同一份状态，但显式刷新仍读取最新暂存区。 */
export function reopenSourceControl(container: HTMLElement): void {
  const api = need();
  const nextKey = currentKey();
  if (nextKey !== workspaceKey) {
    suspendSourceControl();
    workspaceKey = nextKey;
    snapshot = null;
    selectedFile = null;
    showingDiff = false;
    draft = loadDraft(nextKey);
    draftSaved = draft;
  }
  visible = true;
  // 关闭期间外部编辑器可能改过 Git，重开时总是读最新状态并恢复轮询。
  void refreshSourceControl(container);
}
