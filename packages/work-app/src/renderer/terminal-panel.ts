/**
 * 终端面板（渲染层）。
 *
 * PTY 在主进程（terminal-host.ts）—— 原生模块 + 能 spawn 任意 shell，不能进渲染进程。
 * 这里只做三件事：挂 xterm、把用户按键 writ 过去、把主进程推来的输出 write 进屏幕。
 *
 * 与 agent 的联动刻意做成「不新增工具」的一条窄通道：
 *  - cwd 由主进程取当前空间根，和 agent 的 run_command 同一起点；
 *  - 选中输出 → 「发给 agent」把它作为引用块塞进输入框（用户自己决定发不发）；
 *  - agent 跑过的命令 → 「填入」写进 PTY（不回车），用户按回车才执行。
 * 后者尤其重要：agent 的 run_command 是独立子进程，终端里的 shell 看不到它的环境，
 * 但一条命令贴过去至少省掉手打；真要共享会话得让 agent 走这条 PTY，那是另一件事。
 */

// 只引类型：渲染层没有打包器，运行期靠 index.html 里的 <script> 提供 window.Terminal。
import type { Terminal as XTerm, ITheme } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface TerminalPanelApi {
  t: (key: string, vars?: Record<string, string | number>) => string;
  icon: (name: string) => string;
  escapeHtml: (value: string) => string;
  /** 当前空间 id（任务归属空间优先）。undefined = 纯任务，主进程落到 scratch 目录。 */
  currentProjectId: () => string | undefined;
  open: (payload: { projectId?: string; cols: number; rows: number }) => Promise<{ ok: boolean; shell?: string; cwd?: string; cols?: number; rows?: number; reused?: boolean; replay?: string; message?: string }>;
  write: (data: string) => Promise<{ ok: boolean }>;
  resize: (cols: number, rows: number) => Promise<{ ok: boolean }>;
  close: () => Promise<{ ok: boolean }>;
  onData: (callback: (payload: { projectId: string; chunk: string }) => void) => () => void;
  onExit: (callback: (payload: { projectId: string; exitCode: number }) => void) => () => void;
  /** 把一段文本追加到输入框（「发给 agent」）。 */
  insertPrompt: (text: string) => void;
  toast: (level: 'info' | 'warn' | 'error', text: string) => void;
}

interface XtermGlobals {
  Terminal: new (options: Record<string, unknown>) => XTerm;
  FitAddon: { FitAddon: new () => FitAddon };
}

let api: TerminalPanelApi | null = null;
let root: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let term: XTerm | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let detachData: (() => void) | null = null;
let detachExit: (() => void) | null = null;
/** 面板是否打开（关掉时只是 display:none，xterm 与 PTY 都继续活着）。 */
let panelVisible = false;
let ready = false;
/** 正在打开：xterm 的 fit 是异步的（字体度量），重入会开出两个 PTY。 */
let opening = false;
/** 当前面板绑定的空间；换空间要重开终端（PTY 的 cwd 绑在那个空间上）。 */
let boundProject = '';
/** 已挂到屏幕上的输出长度，用于「重开/切回」时判断是否需要补屏。 */
let wroteAnything = false;
/** 面板还没就绪时用户点「填入终端」留下的命令，PTY 起来后补写。 */
let pendingFill = '';

function need(): TerminalPanelApi {
  if (!api) throw new Error('terminal panel not initialized');
  return api;
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

/** 从 CSS 变量读主题：xterm 不吃 oklch 变量名，必须拿计算后的颜色值。 */
function themeFromCss(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    background: pick('--surface-content', '#1b1c1f'),
    foreground: pick('--text-default', '#e8e8e8'),
    cursor: pick('--color-accent', '#8ab4a0'),
    selectionBackground: pick('--surface-hover', '#3a3d42'),
    black: '#202124', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
    brightBlack: '#5c6370', brightRed: '#ef7b85', brightGreen: '#b3d98a',
    brightYellow: '#f0d089', brightBlue: '#7cc0f5', brightMagenta: '#d69ae8', brightCyan: '#70c8d4', brightWhite: '#ffffff',
  };
}

/**
 * 打开（或复用）当前空间的 shell 并把最近输出补到屏幕上。
 *
 * 复用语义来自主进程：同一空间第二次 open 返回 reused:true 且不回放，
 * 因为这份 xterm 里的内容本来就在。换空间 / 进程刚起来 / 自己重启时才补屏。
 */
async function openTerminal(): Promise<void> {
  if (!term || opening) return;
  const panel = need();
  const projectId = panel.currentProjectId();
  const key = projectId ?? '';
  if (ready && key === boundProject) return;
  opening = true;
  try {
    fit?.fit();
    const result = await panel.open({ ...(projectId ? { projectId } : {}), cols: term.cols, rows: term.rows });
    if (!result.ok) {
      ready = false;
      boundProject = '';
      setStatus(result.message ?? panel.t('terminal.failed'));
      return;
    }
    ready = true;
    boundProject = key;
    if (result.reused) {
      // 复用的是同一份屏：不清屏，接着写就行。
      wroteAnything = true;
    } else {
      // 新 shell：清屏后写回主进程的回放缓冲（切走再切回不至于一片空白）。
      term.reset();
      wroteAnything = false;
      if (result.replay) {
        term.write(result.replay);
        wroteAnything = true;
      }
    }
    if (result.cols && result.rows && (result.cols !== term.cols || result.rows !== term.rows)) {
      term.resize(result.cols, result.rows);
    }
    setStatus([result.shell, result.cwd].filter(Boolean).join('  ·  '));
    if (pendingFill) {
      const command = pendingFill;
      pendingFill = '';
      void need().write(command);
    }
    term.focus();
  } finally {
    opening = false;
  }
}

function applyVisibility(): void {
  if (!root || !term) return;
  if (!panelVisible) return;
  // 面板从 display:none 变可见后，xterm 的行高/列宽要重新量：隐藏期间 fit 算出的尺寸是 0。
  requestAnimationFrame(() => {
    fit?.fit();
    if (ready) void need().resize(term!.cols, term!.rows);
    term?.focus();
  });
}

/** 面板打开（工具箱切到终端视图 / 首次打开）。 */
export function showTerminalPanel(): void {
  if (!root) return;
  panelVisible = true;
  root.classList.remove('hidden');
  applyVisibility();
  void openTerminal();
}

/** 面板关闭：只隐藏，PTY 与屏幕内容都留着（agent 跑着的服务不该因为切视图被杀）。 */
export function hideTerminalPanel(): void {
  panelVisible = false;
  root?.classList.add('hidden');
}

/** 切空间后调用：PTY 的 cwd 绑在空间上，必须换一份。 */
export function refreshTerminalProject(): void {
  if (!root) return;
  const key = need().currentProjectId() ?? '';
  if (key === boundProject) return;
  ready = false;
  boundProject = '';
  if (panelVisible) void openTerminal();
}

/** 主题切换后调用：xterm 只在创建时吃 theme，必须显式重设并重绘。 */
export function refreshTerminalTheme(): void {
  if (!term) return;
  term.options.theme = themeFromCss();
}

/** 语言切换后重刷工具条文案（按钮 title / aria 是建时写死的）。 */
export function refreshTerminalLabels(): void {
  if (!root || !api) return;
  const t = api.t;
  for (const [selector, key] of [
    ['[data-terminal="restart"]', 'terminal.restart'],
    ['[data-terminal="send"]', 'terminal.sendToAgent'],
    ['[data-terminal="clear"]', 'terminal.clear'],
  ] as const) {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (!button) continue;
    button.title = t(key);
    button.setAttribute('aria-label', t(key));
  }
}

/**
 * 「填入 agent 刚才那条命令」：不回车，等用户确认。
 *
 * 面板刚被点开时 PTY 可能还在启动（xterm 的 fit 是异步的），所以命令先记着，
 * openTerminal 就绪后立刻补写进去 —— 否则用户点了按钮什么也不会发生。
 */
export function fillTerminalCommand(command: string): void {
  const value = command.trim();
  if (!value) return;
  if (!term || !ready) { pendingFill = value; return; }
  pendingFill = '';
  void need().write(value);
  term.focus();
}

export function initTerminalPanel(container: HTMLElement, terminalApi: TerminalPanelApi): void {
  api = terminalApi;
  root = container;
  const t = terminalApi.t;
  container.innerHTML = `
    <div class="terminal-toolbar">
      <button class="terminal-action" data-terminal="clear" type="button">${terminalApi.icon('trash')}</button>
      <button class="terminal-action" data-terminal="restart" type="button">${terminalApi.icon('regen')}</button>
      <span class="terminal-spacer"></span>
      <button class="terminal-action" data-terminal="send" type="button">${terminalApi.icon('arrow-up')}</button>
    </div>
    <div class="terminal-stage"></div>
    <div class="terminal-status" role="status"></div>`;
  stage = container.querySelector('.terminal-stage');
  statusEl = container.querySelector('.terminal-status');

  const globals = window as unknown as Partial<XtermGlobals>;
  if (!globals.Terminal || !globals.FitAddon) {
    setStatus(t('terminal.unavailable'));
    return;
  }
  term = new globals.Terminal({
    allowProposedApi: true,
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei Mono", monospace',
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 4000,
    theme: themeFromCss(),
  });
  fit = new globals.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(stage!);

  // 用户按键 → PTY。xterm 的 onData 已包含粘贴与回车。
  term.onData((data) => { void need().write(data); });
  // 终端里的程序改尺寸（vim / top）时 xterm 会报告 cols/rows 变化。
  term.onResize(({ cols, rows }) => { if (ready) void need().resize(cols, rows); });

  // 尺寸变化（侧栏拖拽 / 窗口缩放）= 重排 + 重报给 PTY，否则 shell 的换行位置会错。
  observer?.disconnect();
  observer = new ResizeObserver(() => {
    if (!panelVisible || !term) return;
    fit?.fit();
    if (ready) void need().resize(term.cols, term.rows);
  });
  if (stage) observer.observe(stage);

  detachData?.();
  detachData = terminalApi.onData(({ chunk }) => {
    term?.write(chunk);
    wroteAnything = true;
  });
  detachExit?.();
  detachExit = terminalApi.onExit(({ exitCode }) => {
    ready = false;
    boundProject = '';
    setStatus(t('terminal.exited', { code: exitCode }));
    term?.write(`\r\n${t('terminal.exited', { code: exitCode })}\r\n`);
  });

  container.querySelector('[data-terminal="clear"]')?.addEventListener('click', () => {
    term?.clear();
    term?.focus();
  });
  container.querySelector('[data-terminal="restart"]')?.addEventListener('click', () => {
    void (async () => {
      await need().close();
      ready = false;
      boundProject = '';
      wroteAnything = false;
      await openTerminal();
    })();
  });
  container.querySelector('[data-terminal="send"]')?.addEventListener('click', () => {
    const selection = term?.getSelection() ?? '';
    // 没有选区就送最近一屏：用户多半想要「刚才那段报错」，而不是整段历史。
    const text = (selection || lastScreenText()).trim();
    if (!text) {
      terminalApi.toast('info', t('terminal.nothingToSend'));
      return;
    }
    terminalApi.insertPrompt(text);
  });

  refreshTerminalLabels();
  setStatus(t('terminal.placeholder'));
}

/** 无选区时的兜底：取 xterm 缓冲区里最后若干行非空文本。 */
function lastScreenText(): string {
  if (!term) return '';
  const buffer = term.buffer.active;
  const lines: string[] = [];
  const start = Math.max(0, buffer.length - 40);
  for (let index = start; index < buffer.length; index++) {
    const line = buffer.getLine(index)?.translateToString(true) ?? '';
    if (line.trim()) lines.push(line.trimEnd());
  }
  return lines.join('\n');
}