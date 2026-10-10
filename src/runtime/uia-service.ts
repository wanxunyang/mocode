/**
 * UI Automation 常驻服务(Windows):computer 工具的「元素之眼」(design-notes/computer-use-rpa.md §2.1)。
 *
 * 为什么独立成进程而不是塞进 input-injector:
 *  1. 元素树遍历可能要几百 ms 到数秒,注入器是串行管道,混在一起会让 click 排在慢 tree 后面;
 *  2. UIAutomationClient 程序集加载是一次性成本,只有真用到元素能力时才该付;
 *  3. 故障隔离:目标应用无响应时 UIA 的跨进程 COM 调用会挂住,超时只杀本进程,不影响注入与抓屏。
 *
 * 协议与 input-injector.ts / screen-capture-service.ts 同构:stdin NDJSON `{id, op, ...}`,
 * stdout NDJSON `{id, ok, detail?, ...}`;IdleGuard 空闲回收;单 op 超时即 failAll 杀进程、下次惰性重建。
 *
 * 只提供两个原语,其余语义(选择器、ref、norm1000)全在 TS 侧(uia-selector.ts,可单测):
 *  - tree:遍历窗口元素树(CacheRequest 批量取属性,避免每属性一次跨进程调用);
 *  - act:按「hwnd + 子序号路径」重新定位元素,校验 role/name 未变后执行 pattern 动作或取实时矩形。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { filterEnv } from '../sandbox/index.js';
import { IdleGuard, envInt } from './idle-guard.js';
import { parseRawTree, type UiaRawTree, type UiaRect } from './uia-selector.js';

export type UiaActKind = 'invoke' | 'toggle' | 'select' | 'expand' | 'setvalue' | 'focus' | 'rect';

export interface UiaTreeRequest {
  /** 省略 = 当前前台窗口。 */
  hwnd?: number;
  /** 原始遍历节点上限(展示上限由 TS 侧 selectDisplayNodes 另行控制)。 */
  maxNodes?: number;
  maxDepth?: number;
  /** PowerShell 侧自限时:到点返回已收集部分 + truncated,不触发进程级超时。 */
  timeMs?: number;
}

export interface UiaActRequest {
  hwnd: number;
  /** uia-selector 的子序号路径,如 "0.3.1";根为 ""。 */
  path: string;
  kind: UiaActKind;
  text?: string;
  /** 防竞态:路径指向的元素 role/name 与预期不符(界面已重排)即报 ELEMENT_GONE,不误操作。 */
  expectRole?: string;
  expectName?: string;
}

export interface UiaService {
  tree(req: UiaTreeRequest, signal?: AbortSignal): Promise<UiaRawTree>;
  act(req: UiaActRequest, signal?: AbortSignal): Promise<{ rect: UiaRect }>;
  dispose(): Promise<void>;
}

/** 元素已消失/已变化(界面重排、窗口关闭)。computer 工具据此提示模型重新 inspect。 */
export class UiaElementGoneError extends Error {}

const DEFAULT_TREE_NODES = 800;
const DEFAULT_TREE_DEPTH = 25;
/** PowerShell 侧自限 6s,TS 侧进程级超时 10s 兜底(ConvertTo-Json 大树本身也要时间)。 */
const DEFAULT_TREE_TIME_MS = 6000;
const TREE_OP_TIMEOUT_MS = 10000;
const ACT_OP_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_MS = 3 * 60 * 1000;
/** 名称截断长度:与 PowerShell 侧 Clip-Name 一致(expectName 比较依赖它)。 */
export const UIA_NAME_MAX = 200;

const PS_UIA_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MoUia {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '}',
  '"@',
  // DPI 感知必须先于 UIA 加载:BoundingRectangle 按调用进程的 awareness 返回坐标,
  // 不声明的话 150% 缩放下矩形是逻辑像素,与 SetCursorPos 的物理像素差一个缩放比。
  'try { if (-not [MoUia]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][MoUia]::SetProcessDPIAware() } } catch { }',
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  '$AE = [System.Windows.Automation.AutomationElement]',
  '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  '$cr = New-Object System.Windows.Automation.CacheRequest',
  'foreach ($p in @($AE::NameProperty, $AE::ControlTypeProperty, $AE::AutomationIdProperty, $AE::ClassNameProperty,',
  '  $AE::BoundingRectangleProperty, $AE::IsEnabledProperty, $AE::IsOffscreenProperty, $AE::IsPasswordProperty,',
  '  $AE::ProcessIdProperty, $AE::IsInvokePatternAvailableProperty, $AE::IsValuePatternAvailableProperty,',
  '  $AE::IsTogglePatternAvailableProperty, $AE::IsSelectionItemPatternAvailableProperty,',
  '  $AE::IsExpandCollapsePatternAvailableProperty, $AE::IsScrollPatternAvailableProperty,',
  '  [System.Windows.Automation.ValuePattern]::ValueProperty)) { $cr.Add($p) }',
  '$cr.TreeScope = [System.Windows.Automation.TreeScope]::Element',
  `function Clip-Name([string]$s) { if ($null -eq $s) { return "" }; if ($s.Length -gt ${UIA_NAME_MAX}) { return $s.Substring(0, ${UIA_NAME_MAX}) }; return $s }`,
  'function To-Rect($r) {',
  '  if ($r.IsEmpty -or [double]::IsInfinity($r.Width) -or [double]::IsInfinity($r.Height)) { return @{ x = 0; y = 0; w = 0; h = 0 } }',
  '  return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }',
  '}',
  'function Role-Of($ct) { if ($null -eq $ct) { return "Custom" }; return ($ct.ProgrammaticName -replace "^ControlType\\.", "") }',
  'function Node-Info($el, [int]$parent, [int]$depth, [string]$path) {',
  '  $c = $el.Cached',
  '  $pats = @()',
  '  if ($el.GetCachedPropertyValue($AE::IsInvokePatternAvailableProperty)) { $pats += "invoke" }',
  '  if ($el.GetCachedPropertyValue($AE::IsValuePatternAvailableProperty)) { $pats += "value" }',
  '  if ($el.GetCachedPropertyValue($AE::IsTogglePatternAvailableProperty)) { $pats += "toggle" }',
  '  if ($el.GetCachedPropertyValue($AE::IsSelectionItemPatternAvailableProperty)) { $pats += "select" }',
  '  if ($el.GetCachedPropertyValue($AE::IsExpandCollapsePatternAvailableProperty)) { $pats += "expand" }',
  '  if ($el.GetCachedPropertyValue($AE::IsScrollPatternAvailableProperty)) { $pats += "scroll" }',
  '  $isPwd = [bool]$c.IsPassword',
  '  $n = @{ parent = $parent; depth = $depth; path = $path; role = (Role-Of $c.ControlType); name = (Clip-Name ([string]$c.Name));',
  '    automationId = [string]$c.AutomationId; className = [string]$c.ClassName; rect = (To-Rect $c.BoundingRectangle);',
  '    enabled = [bool]$c.IsEnabled; offscreen = [bool]$c.IsOffscreen; isPassword = $isPwd; patterns = $pats }',
  // 密码框永不读 Value(TS 侧 parseRawTree 还有一道双保险)。
  '  if (-not $isPwd -and ($pats -contains "value")) {',
  '    $v = $el.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)',
  '    if ($v -is [string] -and $v.Length -gt 0) { if ($v.Length -gt 60) { $v = $v.Substring(0, 60) }; $n.value = $v }',
  '  }',
  '  return $n',
  '}',
  'function Resolve-Hwnd($req) {',
  '  if ($req.hwnd) { return [IntPtr]::new([long]$req.hwnd) }',
  '  $h = [MoUia]::GetForegroundWindow()',
  '  if ($h -eq [IntPtr]::Zero) { throw "no foreground window" }',
  '  return $h',
  '}',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  $resp = @{ id = 0; ok = $false; detail = "" }',
  '  try {',
  '    $req = $line | ConvertFrom-Json',
  '    $resp.id = $req.id',
  '    switch ($req.op) {',
  '      "ping" { $resp.ok = $true }',
  '      "tree" {',
  '        $hwnd = Resolve-Hwnd $req',
  '        $root = $AE::FromHandle($hwnd).GetUpdatedCache($cr)',
  '        $sw = [Diagnostics.Stopwatch]::StartNew()',
  '        $maxN = [int]$req.maxNodes; $maxD = [int]$req.maxDepth; $maxMs = [int]$req.timeMs',
  '        $nodes = New-Object System.Collections.ArrayList',
  '        [void]$nodes.Add((Node-Info $root (-1) 0 ""))',
  '        $queue = New-Object System.Collections.Queue',
  '        $queue.Enqueue(@($root, 0, 0, ""))',
  '        $trunc = $false',
  // BFS:保证 parent 下标恒小于子节点下标(parseRawTree 的约定);path 记 ControlView 子序号。
  '        while ($queue.Count -gt 0 -and -not $trunc) {',
  '          $item = $queue.Dequeue(); $el = $item[0]; $id = [int]$item[1]; $d = [int]$item[2]; $pp = [string]$item[3]',
  '          if ($d -ge $maxD) { continue }',
  '          $k = 0',
  '          try { $ch = $walker.GetFirstChild($el, $cr) } catch { $ch = $null }',
  '          while ($null -ne $ch) {',
  '            if ($nodes.Count -ge $maxN -or $sw.ElapsedMilliseconds -gt $maxMs) { $trunc = $true; break }',
  '            $cp = if ($pp) { "$pp.$k" } else { "$k" }',
  '            try {',
  '              [void]$nodes.Add((Node-Info $ch $id ($d + 1) $cp))',
  '              $queue.Enqueue(@($ch, ($nodes.Count - 1), ($d + 1), $cp))',
  '            } catch { }',
  '            $k++',
  '            try { $ch = $walker.GetNextSibling($ch, $cr) } catch { $ch = $null }',
  '          }',
  '        }',
  '        $procId = [int]$root.Cached.ProcessId',
  '        $pname = ""',
  '        try { $pname = (Get-Process -Id $procId).ProcessName } catch { }',
  '        $resp.window = @{ hwnd = $hwnd.ToInt64(); title = (Clip-Name ([string]$root.Cached.Name)); processName = $pname; pid = $procId; rect = $nodes[0].rect }',
  '        $resp.nodes = $nodes',
  '        $resp.truncated = $trunc',
  '        $resp.elapsedMs = $sw.ElapsedMilliseconds',
  '        $resp.ok = $true',
  '      }',
  '      "act" {',
  '        $el = $AE::FromHandle([IntPtr]::new([long]$req.hwnd))',
  '        if ($req.path) {',
  '          foreach ($seg in ([string]$req.path).Split(".")) {',
  '            $ch = $walker.GetFirstChild($el)',
  '            for ($i = 0; $i -lt [int]$seg -and $null -ne $ch; $i++) { $ch = $walker.GetNextSibling($ch) }',
  '            if ($null -eq $ch) { throw "ELEMENT_GONE: element path no longer exists" }',
  '            $el = $ch',
  '          }',
  '        }',
  '        $role = Role-Of $el.Current.ControlType',
  '        if ($req.expectRole -and $role -ne [string]$req.expectRole) { throw "ELEMENT_GONE: expected $($req.expectRole), found $role" }',
  '        if ($null -ne $req.expectName -and (Clip-Name ([string]$el.Current.Name)) -ne [string]$req.expectName) { throw "ELEMENT_GONE: element name changed" }',
  '        switch ([string]$req.kind) {',
  '          "invoke" { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }',
  '          "toggle" { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }',
  '          "select" { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }',
  '          "expand" {',
  '            $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)',
  '            if ($ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $ec.Collapse() } else { $ec.Expand() }',
  '          }',
  '          "setvalue" {',
  '            if ($el.Current.IsPassword) { throw "refusing to set value of a password field" }',
  '            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)',
  '            if ($vp.Current.IsReadOnly) { throw "element is read-only" }',
  '            $vp.SetValue([string]$req.text)',
  '          }',
  '          "focus" { $el.SetFocus() }',
  '          "rect" { }',
  '          default { throw "unknown act kind: $($req.kind)" }',
  '        }',
  '        $resp.rect = To-Rect $el.Current.BoundingRectangle',
  '        $resp.ok = $true',
  '      }',
  '      default { $resp.detail = "unknown op: $($req.op)" }',
  '    }',
  '  } catch {',
  '    $resp.ok = $false',
  '    $resp.detail = $_.Exception.Message',
  '  }',
  '  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 6))',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

interface PendingOp {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** UIPI / COM 拒绝访问的典型报文:给模型一句能行动的解释,而不是裸 COM 异常。 */
function explainUiaError(detail: string): string {
  if (/access.?denied|0x80070005|E_ACCESSDENIED/i.test(detail)) {
    return (
      `${detail} (the target window likely runs elevated; a non-admin mocode cannot inspect or ` +
      'operate it — this is a Windows UIPI restriction)'
    );
  }
  return detail;
}

class PowerShellUiaService implements UiaService {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingOp>();
  private stdoutBuf = '';
  private lastError = '';
  private idle: IdleGuard;

  constructor(idleMs: number) {
    this.idle = new IdleGuard(idleMs, () => {
      void this.dispose();
    });
  }

  private ensureProcess(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UIA_SCRIPT],
      { env: filterEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.stdoutBuf = '';
    this.lastError = '';
    this.child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.lastError = (this.lastError + chunk.toString('utf8')).slice(-2000);
    });
    this.child.on('exit', () =>
      this.failAll(new Error(`UIA process exited${this.lastError ? `: ${this.lastError.trim()}` : ''}`)),
    );
    this.child.on('error', (err) => this.failAll(err));
    return this.child;
  }

  private onStdout(text: string): void {
    this.stdoutBuf += text;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非协议行(Add-Type 警告等),忽略
      }
      const id = typeof msg.id === 'number' ? msg.id : -1;
      const op = this.pending.get(id);
      if (!op) continue;
      this.pending.delete(id);
      clearTimeout(op.timer);
      op.resolve(msg);
    }
  }

  private failAll(error: Error): void {
    for (const [, op] of this.pending) {
      clearTimeout(op.timer);
      op.reject(error);
    }
    this.pending.clear();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* 进程已退出 */
      }
      this.child = null;
    }
  }

  private call(
    op: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // UIA 挂起(目标应用无响应)是常态故障:超时直接杀进程,下次惰性重建。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failAll(new Error(`UIA op "${op}" timed out after ${timeoutMs}ms`));
        reject(new Error(`UIA op "${op}" timed out after ${timeoutMs}ms (target application may be unresponsive)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.failAll(new Error('aborted'));
        reject(new Error('UIA operation aborted.'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        child.stdin!.write(`${JSON.stringify({ id, op, ...params })}\n`, 'utf8');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }).then((resp) => {
      this.idle.touch();
      if (resp.ok !== true) {
        const detail = String(resp.detail ?? 'unknown error');
        if (detail.includes('ELEMENT_GONE')) throw new UiaElementGoneError(detail.replace(/^.*ELEMENT_GONE:\s*/, ''));
        throw new Error(`UIA op "${op}" failed: ${explainUiaError(detail)}`);
      }
      return resp;
    });
  }

  async tree(req: UiaTreeRequest, signal?: AbortSignal): Promise<UiaRawTree> {
    const resp = await this.call(
      'tree',
      {
        hwnd: req.hwnd ?? 0,
        maxNodes: req.maxNodes ?? DEFAULT_TREE_NODES,
        maxDepth: req.maxDepth ?? DEFAULT_TREE_DEPTH,
        timeMs: req.timeMs ?? DEFAULT_TREE_TIME_MS,
      },
      TREE_OP_TIMEOUT_MS,
      signal,
    );
    return parseRawTree(resp);
  }

  async act(req: UiaActRequest, signal?: AbortSignal): Promise<{ rect: UiaRect }> {
    const resp = await this.call(
      'act',
      {
        hwnd: req.hwnd,
        path: req.path,
        kind: req.kind,
        text: req.text ?? '',
        expectRole: req.expectRole ?? '',
        expectName: req.expectName ?? null,
      },
      ACT_OP_TIMEOUT_MS,
      signal,
    );
    const r = (resp.rect && typeof resp.rect === 'object' ? resp.rect : {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
    return { rect: { x: n(r.x), y: n(r.y), w: Math.max(0, n(r.w)), h: Math.max(0, n(r.h)) } };
  }

  async dispose(): Promise<void> {
    this.idle.stop();
    this.failAll(new Error('UIA service disposed'));
  }
}

let singleton: PowerShellUiaService | null = null;

/** 非 Windows 显式抛错(与 createInputInjector 一致的诚实降级)。 */
export function getUiaService(): UiaService {
  if (process.platform !== 'win32') {
    throw new Error(
      `UI Automation element inspection is only supported on Windows (current platform: ${process.platform}); ` +
        'use screenshot + coordinates instead.',
    );
  }
  singleton ??= new PowerShellUiaService(envInt('MOCODE_CU_UIA_IDLE_MS', DEFAULT_IDLE_MS));
  return singleton;
}

/** 关闭常驻 UIA 进程(REPL 退出 / /cu off 时调用)。 */
export async function disposeUiaService(): Promise<void> {
  if (singleton) {
    await singleton.dispose();
    singleton = null;
  }
}
