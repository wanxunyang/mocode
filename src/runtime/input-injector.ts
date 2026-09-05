/**
 * OS 级输入注入(computer 工具的「手」)。
 *
 * 架构:InputInjector 接口与实现解耦——
 * - 阶段一(MVP,本文件):PowerShell 常驻子进程,stdin 收 NDJSON 动作、stdout 回 NDJSON 结果,
 *   P/Invoke user32.dll(SendInput / SetCursorPos / GetCursorPos / mouse_event)。零新依赖。
 * - 阶段二(终态,本轮不做):rust/ enigo 二进制,同协议替换。
 *
 * 非 Windows 平台 MVP 显式抛错(诚实降级),不静默假装支持。
 * 键名映射接受 Anthropic 风格键名(Return / Alt_L / ctrl+s),在 TS 侧映射成 VK 码,
 * PowerShell 只负责按 VK 码发键——映射逻辑留在可单测的 TS 里。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { filterEnv } from '../sandbox/index.js';

export interface InputInjector {
  /** 绑定当前动作批次的 abort signal(每次 computer.execute 调用前设置)。 */
  bindSignal(signal: AbortSignal | undefined): void;
  moveTo(x: number, y: number): Promise<void>;
  click(button: 'left' | 'right' | 'middle', count: 1 | 2 | 3): Promise<void>;
  mouseDown(button: 'left' | 'right' | 'middle'): Promise<void>;
  mouseUp(button: 'left' | 'right' | 'middle'): Promise<void>;
  /** 按住左键拖动到目标(配合 mouseDown 使用;内部只是 move,拖拽语义由 down+move+up 组合)。 */
  dragTo(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  /** combo 形如 'Return' / 'ctrl+s' / 'ctrl+shift+t'。 */
  pressKey(combo: string): Promise<void>;
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>;
  cursorPosition(): Promise<{ x: number; y: number }>;
  dispose(): Promise<void>;
}

// ── Anthropic 键名 → Windows VK 码 ─────────────────────────────────────

const VK_NAMED: Record<string, number> = {
  return: 0x0d, enter: 0x0d, escape: 0x1b, esc: 0x1b, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  page_up: 0x21, pageup: 0x21, page_down: 0x22, pagedown: 0x22, prior: 0x21, next: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
  ctrl: 0x11, control: 0x11, control_l: 0xa2, ctrl_l: 0xa2, control_r: 0xa3, ctrl_r: 0xa3,
  alt: 0x12, alt_l: 0xa4, alt_r: 0xa5, option: 0x12,
  shift: 0x10, shift_l: 0xa0, shift_r: 0xa1,
  super_l: 0x5b, super: 0x5b, meta: 0x5b, win: 0x5b, cmd: 0x5b, command: 0x5b,
  caps_lock: 0x14, num_lock: 0x90, scroll_lock: 0x91, print_screen: 0x2c, snapshot: 0x2c,
  minus: 0xbd, equals: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf,
  semicolon: 0xba, quote: 0xde, bracketleft: 0xdb, bracketright: 0xdd, backslash: 0xdc, backquote: 0xc0,
};

for (let i = 1; i <= 12; i++) VK_NAMED[`f${i}`] = 0x6f + i;

/** 把 'ctrl+shift+t' / 'Return' 这类组合键解析为 VK 码数组(修饰键在前)。未知键名抛错。 */
export function mapKeyComboToVk(combo: string): number[] {
  const parts = combo
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error(`empty key combo: "${combo}"`);
  return parts.map((part) => {
    const key = part.toLowerCase();
    const named = VK_NAMED[key];
    if (named !== undefined) return named;
    if (key.length === 1) {
      const c = key.charCodeAt(0);
      if (c >= 0x61 && c <= 0x7a) return c - 0x20; // a-z → 0x41-0x5A
      if (c >= 0x30 && c <= 0x39) return c; // 0-9
      const punct = VK_NAMED[{ '-': 'minus', '=': 'equals', ',': 'comma', '.': 'period', '/': 'slash', ';': 'semicolon', "'": 'quote', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash', '`': 'backquote' }[key] ?? ''];
      if (punct !== undefined) return punct;
    }
    throw new Error(`unknown key name: "${part}" in combo "${combo}"`);
  });
}

// ── PowerShell 常驻进程协议 ─────────────────────────────────────────────

/** PowerShell 侧脚本:加载 P/Invoke 声明一次,然后 NDJSON 循环收动作。 */
const PS_INJECTOR_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class Inject {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
  '  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);',
  '  public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }',
  '  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }',
  '}',
  '"@',
  'function Send-VkCombo([int[]]$vks) {',
  '  $size = [Runtime.InteropServices.Marshal]::SizeOf([type]"Inject+INPUT")',
  '  foreach ($vk in $vks) {',
  '    $inp = New-Object "Inject+INPUT"',
  '    $inp.type = 1',
  '    $inp.U.ki.wVk = $vk',
  '    $inp.U.ki.dwFlags = 0',
  '    [Inject]::SendInput(1, [Inject+INPUT[]]@($inp), $size) | Out-Null',
  '  }',
  '  [array]::Reverse($vks)',
  '  foreach ($vk in $vks) {',
  '    $inp = New-Object "Inject+INPUT"',
  '    $inp.type = 1',
  '    $inp.U.ki.wVk = $vk',
  '    $inp.U.ki.dwFlags = 2',
  '    [Inject]::SendInput(1, [Inject+INPUT[]]@($inp), $size) | Out-Null',
  '  }',
  '}',
  'function Send-UnicodeText([string]$text) {',
  '  $size = [Runtime.InteropServices.Marshal]::SizeOf([type]"Inject+INPUT")',
  '  for ($i = 0; $i -lt $text.Length; $i++) {',
  '    $code = [int][char]$text[$i]',
  '    foreach ($flag in @(4, 6)) {',
  '      $inp = New-Object "Inject+INPUT"',
  '      $inp.type = 1',
  '      $inp.U.ki.wVk = 0',
  '      $inp.U.ki.wScan = $code',
  '      $inp.U.ki.dwFlags = $flag',
  '      [Inject]::SendInput(1, [Inject+INPUT[]]@($inp), $size) | Out-Null',
  '    }',
  '  }',
  '}',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  $resp = @{ id = 0; ok = $false; detail = "" }',
  '  try {',
  '    $req = $line | ConvertFrom-Json',
  '    $resp.id = $req.id',
  '    switch ($req.op) {',
  '      "ping" { $resp.ok = $true }',
  '      "move" { [Inject]::SetCursorPos([int]$req.x, [int]$req.y) | Out-Null; $resp.ok = $true }',
  '      "click" {',
  '        $flags = switch ($req.button) { "right" { @(8, 16) } "middle" { @(32, 64) } default { @(2, 4) } }',
  '        for ($n = 0; $n -lt [int]$req.count; $n++) {',
  '          [Inject]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)',
  '          [Inject]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)',
  '          if ($n -lt [int]$req.count - 1) { Start-Sleep -Milliseconds 40 }',
  '        }',
  '        $resp.ok = $true',
  '      }',
  '      "mousedown" {',
  '        $flag = switch ($req.button) { "right" { 8 } "middle" { 32 } default { 2 } }',
  '        [Inject]::mouse_event($flag, 0, 0, 0, [UIntPtr]::Zero); $resp.ok = $true',
  '      }',
  '      "mouseup" {',
  '        $flag = switch ($req.button) { "right" { 16 } "middle" { 64 } default { 4 } }',
  '        [Inject]::mouse_event($flag, 0, 0, 0, [UIntPtr]::Zero); $resp.ok = $true',
  '      }',
  '      "type" { Send-UnicodeText([string]$req.text); $resp.ok = $true }',
  '      "key" { Send-VkCombo([int[]]$req.vks); $resp.ok = $true }',
  '      "scroll" {',
  '        $amt = [int]$req.amount * 120',
  '        if ($req.direction -eq "down" -or $req.direction -eq "left") { $amt = -$amt }',
  '        $flag = if ($req.direction -eq "left" -or $req.direction -eq "right") { 4096 } else { 2048 }',
  '        [Inject]::mouse_event($flag, 0, 0, $amt, [UIntPtr]::Zero); $resp.ok = $true',
  '      }',
  '      "cursor" {',
  '        $p = New-Object "Inject+POINT"',
  '        [Inject]::GetCursorPos([ref]$p) | Out-Null',
  '        $resp.x = $p.X; $resp.y = $p.Y; $resp.ok = $true',
  '      }',
  '      default { $resp.detail = "unknown op: $($req.op)" }',
  '    }',
  '  } catch {',
  '    $resp.ok = $false',
  '    $resp.detail = $_.Exception.Message',
  '  }',
  '  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

const OP_TIMEOUT_MS = 10000;

interface PendingOp {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class PowerShellInjector implements InputInjector {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingOp>();
  private stdoutBuf = '';
  private lastError = '';

  private ensureProcess(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_INJECTOR_SCRIPT],
      { env: filterEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.stdoutBuf = '';
    this.lastError = '';
    this.child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.lastError = (this.lastError + chunk.toString('utf8')).slice(-2000);
    });
    this.child.on('exit', () => this.failAll(new Error(`injector process exited${this.lastError ? `: ${this.lastError.trim()}` : ''}`)));
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

  private call(op: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failAll(new Error(`injector op "${op}" timed out after ${OP_TIMEOUT_MS}ms`));
        reject(new Error(`injector op "${op}" timed out`));
      }, OP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.failAll(new Error('aborted'));
        reject(new Error('Input injection aborted.'));
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
    }).then(async (resp) => {
      if (resp.ok !== true) {
        throw new Error(`injector op "${op}" failed: ${String(resp.detail ?? 'unknown error')}`);
      }
      return resp;
    });
  }

  private signal: AbortSignal | undefined;
  /** 每次动作批次绑定一次 signal(computer 工具 execute 时设置)。 */
  bindSignal(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  async moveTo(x: number, y: number): Promise<void> {
    await this.call('move', { x, y }, this.signal);
  }
  async click(button: 'left' | 'right' | 'middle', count: 1 | 2 | 3): Promise<void> {
    await this.call('click', { button, count }, this.signal);
  }
  async mouseDown(button: 'left' | 'right' | 'middle'): Promise<void> {
    await this.call('mousedown', { button }, this.signal);
  }
  async mouseUp(button: 'left' | 'right' | 'middle'): Promise<void> {
    await this.call('mouseup', { button }, this.signal);
  }
  async dragTo(x: number, y: number): Promise<void> {
    await this.call('move', { x, y }, this.signal);
  }
  async typeText(text: string): Promise<void> {
    await this.call('type', { text }, this.signal);
  }
  async pressKey(combo: string): Promise<void> {
    const vks = mapKeyComboToVk(combo);
    await this.call('key', { vks }, this.signal);
  }
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    await this.call('scroll', { direction, amount }, this.signal);
  }
  async cursorPosition(): Promise<{ x: number; y: number }> {
    const resp = await this.call('cursor', {}, this.signal);
    return { x: Number(resp.x) || 0, y: Number(resp.y) || 0 };
  }
  async dispose(): Promise<void> {
    this.failAll(new Error('injector disposed'));
  }
}

let singleton: PowerShellInjector | null = null;

/**
 * 取当前平台的 InputInjector。Windows 用 PowerShell 常驻进程(惰性启动);
 * 其它平台显式抛错——宁可诚实报「不支持」,也不静默失败。
 */
export function createInputInjector(): InputInjector {
  if (process.platform !== 'win32') {
    throw new Error(
      `computer use input injection is not yet supported on ${process.platform} ` +
        '(Windows MVP via PowerShell; Rust enigo injector is the planned cross-platform path).',
    );
  }
  singleton ??= new PowerShellInjector();
  return singleton;
}

/** 关闭常驻注入进程(REPL 退出 / /cu off 时调用)。 */
export async function disposeInputInjector(): Promise<void> {
  if (singleton) {
    await singleton.dispose();
    singleton = null;
  }
}
