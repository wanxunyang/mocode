import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin } from 'node:process';
import * as layout from '../ui/layout.js';
import * as mouse from '../ui/mouse.js';
import { promptComposer } from '../ui/composer.js';
import { appendCurrentSessionRuntimeEvent } from '../session/index.js';

/** stdin 的 keypress 事件接口(emitKeypressEvents 后发,不在 ReadStream 类型里)。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  off(event: 'keypress', listener: (str: string, key: Key) => void): this;
}
const emitter = stdin as unknown as KeypressEmitter;

// ── 运行态交互(typeahead 输入 + 滚动回看 + Ctrl+C 中断 + Ctrl+G 输入面板)──
// 只在 await runAgent() 期间挂载;/resume /rollback /compact 等走 askLine(cooked readline)的分支不挂(避免抢 stdin)。
let runningInput = ''; // 运行中已打字缓冲(agent 结束后预填下一轮 INPUT 态;经输入面板可含换行)
let runningCursor = 0; // 缓冲内光标字符索引(0..len);运行态支持任意位置编辑,与空闲态一致
let runningPlaceholder = '';
let currentAbort: AbortController | null = null;
let listening = false; // onRunningKey 是否处于挂载期(start → stop 之间)
/** 运行态打开的输入面板(Ctrl+G);非 null = 面板仍开着。主循环进 INPUT 态前须等它关闭,否则两个 keypress 监听抢键。 */
let composerPending: Promise<void> | null = null;

/** 获取运行中输入缓冲(agent 结束后预填下一轮 INPUT 态)。 */
export function getRunningInput(): string {
  return runningInput;
}

/** 清空运行中输入缓冲(预填已消费后调用)。 */
export function clearRunningInput(): void {
  runningInput = '';
  runningCursor = 0;
}

/**
 * 等待运行态打开的输入面板关闭(无则立即返回)。
 * agent 可能在面板打开期间结束:主循环在进入 INPUT 态(promptWithSlashMenu 挂自己的 keypress)前必须 await,
 * 面板确认的内容随后经 getRunningInput 预填进输入框。
 */
export function waitForRunningComposer(): Promise<void> {
  return composerPending ?? Promise.resolve();
}

/** 单行回显:换行折为空格(等长替换,光标索引不变),防多行内容撑破底栏输入行。 */
function paint(): void {
  layout.paintRunningInput(runningInput.replace(/[\r\n]/g, ' '), runningCursor, runningPlaceholder);
}

/**
 * Ctrl+G(运行态):打开输入面板编辑 typeahead 缓冲。
 * 期间摘掉 onRunningKey(面板自己挂 keypress),并标记 overlay——流式输出 / 状态行心跳 / spinner 帧只喂缓冲
 * 不物理写,否则 80ms 心跳与流式会覆盖弹窗、抢走光标。关闭后整幅重画;确认的内容写回 typeahead 缓冲(不发送)。
 */
async function openRunningComposer(): Promise<void> {
  emitter.off('keypress', onRunningKey);
  layout.setOverlayActive(true);
  let result: { text: string | null } = { text: null };
  try {
    result = await promptComposer({ initialText: runningInput });
  } finally {
    layout.setOverlayActive(false);
    if (listening) {
      // agent 仍在跑:恢复运行态监听(面板 finish 会 pause stdin,这里续上)
      emitter.on('keypress', onRunningKey);
      stdin.resume();
    }
    layout.repaintViewport();
    layout.drawStatusBar();
  }
  if (result.text != null) {
    runningInput = result.text;
    runningCursor = runningInput.length;
  }
  if (listening) paint();
}

/** 运行态按键:滚动优先,再 Ctrl+C 中断,再 Ctrl+G 面板,再 typeahead 编辑(单行,Enter=无操作)。 */
function onRunningKey(_str: string, key?: Key): void {
  if (!key) return;
  // 鼠标 fragment:重组 + 派发给 layout.handleMouseEvent(滚轮/框选/复制)。
  if (mouse.swallow(key.sequence ?? '')) return;
  // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页,↑/↓ 每次 5 行(键盘)。
  // 运行态无输入光标,↑/↓ 无其他用途,直接作滚动。
  if (key.name === 'pageup' || key.name === 'pagedown' || key.name === 'up' || key.name === 'down') {
    const pageH = layout.getGeo().contentBottom;
    if (key.name === 'pageup') layout.scrollBy(pageH);
    else if (key.name === 'pagedown') layout.scrollBy(-pageH);
    else if (key.name === 'up') layout.scrollBy(5);
    else layout.scrollBy(-5);
    return;
  }
  // 用户在交互(非滚动键)→ 暂停流式物理写,避免光标去 contentRow 扰动 IME 候选窗(停手后自动 flush)
  layout.setUserActive();
  // 滚动回看时打字 / 编辑(typeahead)不回尾——保持历史视图,便于运行中边看历史边预输入;
  // 回尾时机:Enter 在运行态是 no-op,真正回尾发生在 agent 结束后 INPUT 态按 Enter 提交(见 prompt.ts submit 前)。
  // Ctrl+C 4 层语义(RUNNING 态):有 typeahead → 清空(层 1,不中断);空 → abort(层 2,中断 agent)。
  // 两次 Ctrl+C 才中断(先清 typeahead 再 abort),与 INPUT 态 onCtrlC 的 fish 式一致。
  // raw 模式下 Ctrl+C 是按键不触发 SIGINT;signal 经 executeTool 串进工具,run_command/web_fetch 即时被杀。
  if (key.ctrl && key.name === 'c') {
    if (runningInput.length > 0) {
      runningInput = '';
      runningCursor = 0;
      paint();
    } else if (currentAbort && !currentAbort.signal.aborted) {
      appendCurrentSessionRuntimeEvent('abort', { phase: 'requested', source: 'keyboard' });
      currentAbort.abort();
    }
    return;
  }
  // Ctrl+G:打开输入面板(与 INPUT 态一致;确认只填回 typeahead 缓冲,agent 结束后预填,不发送)
  if (key.ctrl && key.name === 'g') {
    if (!composerPending) {
      composerPending = openRunningComposer()
        .catch(() => undefined)
        .finally(() => {
          composerPending = null;
        });
    }
    return;
  }
  const s = key.sequence ?? '';
  // 光标移动(单行 typeahead,光标可任意位置,与空闲态一致)
  if (key.name === 'left') {
    runningCursor = Math.max(0, runningCursor - 1);
    paint();
    return;
  }
  if (key.name === 'right') {
    runningCursor = Math.min(runningInput.length, runningCursor + 1);
    paint();
    return;
  }
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
    runningCursor = 0;
    paint();
    return;
  }
  if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
    runningCursor = runningInput.length;
    paint();
    return;
  }
  if (key.name === 'backspace') {
    if (runningCursor > 0) {
      runningInput = runningInput.slice(0, runningCursor - 1) + runningInput.slice(runningCursor);
      runningCursor--;
      paint();
    }
    return;
  }
  if (key.name === 'delete') {
    if (runningCursor < runningInput.length) {
      runningInput = runningInput.slice(0, runningCursor) + runningInput.slice(runningCursor + 1);
      paint();
    }
    return;
  }
  if (key.name === 'escape') {
    runningInput = '';
    runningCursor = 0;
    paint();
    return;
  }
  // Enter / Ctrl+J:运行中 no-op(单行 typeahead;agent 结束后预填,用户在 INPUT 态按 Enter 提交)
  if (key.name === 'return' || key.name === 'enter' || (key.ctrl && key.name === 'j')) {
    return;
  }
  // 可打印字符(>= 空格,非 ctrl/meta)→ 光标处插入 + 非 dim 回显(与空闲态一致)
  if (s && s >= ' ' && !key.ctrl && !key.meta) {
    runningInput = runningInput.slice(0, runningCursor) + s + runningInput.slice(runningCursor);
    runningCursor += s.length;
    paint();
  }
}

/** 鼠标右键单击输入框(未拖动)时 layout 读剪贴板后回调:在光标处插入 typeahead 缓冲(单行,换行折为空格)。 */
function onRunningMousePaste(text: string): void {
  const flat = text.replace(/[\r\n]+/g, ' ');
  runningInput = runningInput.slice(0, runningCursor) + flat + runningInput.slice(runningCursor);
  runningCursor += flat.length;
  paint();
}

/** 进入运行态:挂 keypress 监听 + raw mode + 新建 abort 控制器,返回其 signal。在 await runAgent 前、enterRunningMode 后调。 */
export function startRunningListener(placeholder: string): AbortSignal {
  runningPlaceholder = placeholder;
  runningInput = '';
  runningCursor = 0;
  emitKeypressEvents(stdin); // 幂等:首轮 prompt 已永久挂解析器,这里防御性再调
  try {
    stdin.setRawMode(true);
  } catch {
    // 非 TTY / 不支持 raw:监听器仍挂(按键可能不来,不影响 agent)
  }
  stdin.resume();
  emitter.on('keypress', onRunningKey);
  listening = true;
  layout.setPasteHandler(onRunningMousePaste); // 鼠标右键单击输入框(未拖动)→ 读剪贴板贴入
  const ac = new AbortController();
  currentAbort = ac;
  return ac.signal;
}

/**
 * 退出运行态:摘监听 + 清 abort。不 pause / 不 setRawMode(false)——紧接着 promptWithSlashMenu 自己接管 raw。
 * 若输入面板仍开着,面板继续持有键盘;关闭时据 listening=false 不再恢复运行态监听(主循环 await waitForRunningComposer)。
 */
export function stopRunningListener(): void {
  listening = false;
  emitter.off('keypress', onRunningKey);
  layout.setPasteHandler(null);
  currentAbort = null;
}
