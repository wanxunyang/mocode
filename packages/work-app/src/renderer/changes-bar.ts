/**
 * 「本轮改动」长条列表的**纯字符串渲染**（无 DOM、无 i18n 运行时依赖）。
 *
 * 用途：一次任务跑完后，在会话最下面摆出这轮 agent 改过的文件，一个文件一条长条，
 * 点开就是该文件相对 HEAD 的 diff。
 *
 * 为什么单独成模块：与 plan-panel.ts 同理由 —— 这份 markup 决定「用户一眼看到什么」，
 * 抽出来才能在 node 环境里断言，文案由调用方注入（切语言即时生效）。
 */

export interface ChangesBarFile {
  path: string;
  /** 相对 HEAD 的新增行数；拿不到统计时按 0 处理（只显示路径）。 */
  added: number;
  removed: number;
  untracked: boolean;
}

export interface ChangesBarLabels {
  /** 「本轮改动 · 3 个文件」 */
  title: (n: number) => string;
  /** 「查看全部」 */
  all: string;
  /** 「新文件」角标 */
  untracked: string;
  /** 单条长条的 title / aria-label：「查看 {path} 的改动」 */
  open: (path: string) => string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

/** 路径拆成「目录 + 文件名」：目录弱化成前缀，文件名才是用户扫读的对象。 */
function splitPath(path: string): { dir: string; base: string } {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0
    ? { dir: '', base: normalized }
    : { dir: normalized.slice(0, slash + 1), base: normalized.slice(slash + 1) };
}

function statsHtml(file: ChangesBarFile, labels: ChangesBarLabels): string {
  const parts: string[] = [];
  if (file.untracked) parts.push(`<span class="changes-bar-badge">${escapeHtml(labels.untracked)}</span>`);
  if (file.added > 0) parts.push(`<span class="diff-add">+${file.added}</span>`);
  if (file.removed > 0) parts.push(`<span class="diff-del">-${file.removed}</span>`);
  return parts.length ? `<span class="changes-bar-stat">${parts.join('')}</span>` : '';
}

/** 卡片内层 HTML。调用方负责塞进容器并挂事件（见 renderer.ts 的 syncChangesBar）。 */
export function changesBarHtml(files: ChangesBarFile[], labels: ChangesBarLabels): string {
  const rows = files.map((file) => {
    const { dir, base } = splitPath(file.path);
    return `<li><button type="button" class="changes-bar-row" data-change-path="${escapeHtml(file.path)}" title="${escapeHtml(labels.open(file.path))}" aria-label="${escapeHtml(labels.open(file.path))}">`
      + `<span class="changes-bar-mark" data-icon="edit"></span>`
      + `<span class="changes-bar-name">${escapeHtml(base)}</span>`
      + (dir ? `<span class="changes-bar-dir">${escapeHtml(dir)}</span>` : '')
      + statsHtml(file, labels)
      + `<span class="changes-bar-go" data-icon="chevron-right"></span>`
      + `</button></li>`;
  }).join('');
  return `<div class="changes-bar-card">
  <div class="changes-bar-head">
    <span class="changes-bar-title">${escapeHtml(labels.title(files.length))}</span>
    <button type="button" class="changes-bar-all" data-changes-all>${escapeHtml(labels.all)}</button>
  </div>
  <ul class="changes-bar-list">${rows}</ul>
</div>`;
}