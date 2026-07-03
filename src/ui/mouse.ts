// SGR 鼠标报表重组器 + 事件分发(叶子:仅正则 + 回调,无 UI 依赖)。
//
// 背景:layout 进 alt 屏时发 \x1B[?1000h + \x1B[?1002h + \x1B[?1006h,启用:
//   1000 = 按键事件追踪(按下 / 释放),1002 = 拖动追踪(按住键移动时上报 motion),
//   1006 = SGR 编码 → \x1B[<btn;col;rowM(按下 / 拖动)或 \x1B[<btn;col;rowm(释放)。
// 有了 1002 的拖动上报,才能实现"按住左键拖过多屏 → 应用层维护选区 → 松开复制"(仿 Claude Code)。
//
// 但 Node readline 的 emitKeypressEvents 不认 `<` 为 CSI 参数字节,把一条报表拆成 `\x1b[<` +
// 逐字符共 ≥9 个 keypress(数字 / `;` / `M` 有可打印 name,会被当文本砸进输入框)。故本模块在
// keypress 层重组:每个 keypress 的 key.sequence 喂入 swallow,内部状态机把 fragment 拼回完整报表,
// 期间所有 fragment 返回 true(调用方须 return 吞掉,防砸进输入框);报表拼齐后解析成结构化
// MouseEvent 派发给已注册的 handler(layout 注册,做滚动 / 选区 / 复制)。
//
// 触发可靠:首 fragment `\x1b[<` 是 SGR 鼠标独有——真 Esc 的 sequence==='\x1b';人按 Esc 再按 <
// 得 `\x1b<`(meta-<),不进 CSI 分支。故 `\x1b[<` 开头只能是 SGR 报表。

export type MouseEvent =
  | { type: 'wheel'; dir: number } // dir: +1=上(看更旧), -1=下(看更新)
  | { type: 'press'; col: number; row: number; button: number }
  | { type: 'drag'; col: number; row: number; button: number }
  | { type: 'release'; col: number; row: number; button: number };

/** 单条完整报表(捕获 button / col / row / 终止符 M|m)。 */
const REPORT_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
/** 全局版:一个 chunk 里可能背靠背多条(拖动 motion 连发),matchAll 取全部。 */
const REPORT_RE_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** 收集中 buf 允许的形状:\x1b[< 后跟 [0-9;] 任意个,末尾可选一个 M/m(未完成或刚完成)。 */
const PARTIAL_RE = /^\x1b\[<[0-9;]*[Mm]?$/;
const START = '\x1b[<';

let handler: ((e: MouseEvent) => void) | null = null;
let collecting = false;
let buf = '';

/** 注册事件回调(layout 进 alt 屏时注册)。 */
export function setHandler(fn: ((e: MouseEvent) => void) | null): void {
  handler = fn;
}

/** 复位内部收集状态(退出 alt 屏 / 测试间清污染)。 */
export function resetMouse(): void {
  collecting = false;
  buf = '';
}

/** button 位:64=滚轮(&1 区分上下),32=拖动 motion,低 2 位=键(0=左,1=中,2=右)。 */
function emit(button: number, col: number, row: number, term: string): void {
  if (!handler) return;
  if (button & 64) {
    handler({ type: 'wheel', dir: button & 1 ? -1 : +1 });
    return;
  }
  const btn = button & 3;
  if (term === 'm') {
    handler({ type: 'release', col, row, button: btn });
    return;
  }
  if (button & 32) {
    handler({ type: 'drag', col, row, button: btn });
    return;
  }
  handler({ type: 'press', col, row, button: btn });
}

/** 解出串中所有完整报表并按序派发(拖动 motion 一个 chunk 多条时全处理)。 */
function dispatchAll(s: string): void {
  for (const m of s.matchAll(REPORT_RE_G)) {
    emit(Number(m[1]), Number(m[2]), Number(m[3]), m[4]);
  }
}

/**
 * 喂入一个 keypress 的 key.sequence。
 * 返回 true=本 keypress 是鼠标 fragment(或完整报表),调用方须 return 吞掉;
 * 返回 false=非鼠标,放行正常处理。完整报表拼齐时同步派发 MouseEvent 给 handler。
 */
export function swallow(seq: string): boolean {
  if (!seq) return false;
  if (!collecting) {
    if (!seq.startsWith(START)) return false;
    // 单 keypress 已含完整报表(未来 Node 可能整体抛):直接解。
    if (REPORT_RE.test(seq)) {
      dispatchAll(seq);
      return true;
    }
    collecting = true;
    buf = seq;
    return true;
  }
  buf += seq;
  if (REPORT_RE.test(buf)) {
    dispatchAll(buf);
    resetMouse();
    return true;
  }
  if (PARTIAL_RE.test(buf)) return true; // 合法未完成形状,继续等
  resetMouse(); // 偏离合法形状:畸形垃圾,丢半截,吞掉不打扰
  return true;
}
