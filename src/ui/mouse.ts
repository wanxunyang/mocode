// SGR 鼠标报表重组器(叶子,仅正则,无依赖)。
//
// 背景:layout 进 alt 屏时发 \x1B[?1000h + \x1B[?1006h 启 SGR 鼠标追踪,终端把滚轮/点击发为
// \x1B[<button;col;rowM(按下/滚轮/拖动)或 m(释放)。但 Node readline 的 emitKeypressEvents
// 不认 `<` 为 CSI 参数字节,把一条报表拆成 `\x1b[<` + 逐字符 共 9 个 keypress(数字/`;`/`M` 有
// 可打印 name,会被当文本砸进输入框)。本模块在 keypress 层重组:每个 keypress 的 key.sequence
// 喂入 consumeMouse,内部状态机把 fragment 拼回完整报表,期间所有 fragment 返回 suppress=true
// 让调用方吞掉,完整报表解出滚轮方向后返回 wheel(±1)由调用方调 layout.scrollBy(wheel*5)。
//
// 触发可靠:首 fragment `\x1b[<` 是 SGR 鼠标独有——真 Esc 的 key.name==='escape'、sequence==='\x1b';
// 人按 Esc 再按 < 得 `\x1b<`(meta-<),不进 CSI 分支。故 `\x1b[<` 单 keypress 只能是 SGR 报表开头。
// 后续 fragment 同步背靠背到达(终端一次发整条报表,readline 在同一 onData chunk 内同步抛完)。

/** 单条完整报表(非 g:用于 test,不推进 lastIndex);捕获 button。 */
const REPORT_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/;
/** 全局报表(用于 matchAll 取所有完整报表,取末条)。 */
const REPORT_RE_G = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
/** 收集中 buf 允许的形状:\x1b[< 后跟 [0-9;] 任意个,末尾可选一个 M/m(未完成或刚完成)。 */
const PARTIAL_RE = /^\x1b\[<[0-9;]*[Mm]?$/;
const START = '\x1b[<';

/** button & 64 为滚轮:64=上(+1)、65=下(-1);其余(点击/拖动/移动/释放)→ 0。 */
function wheelDir(button: number): number {
  if (!(button & 64)) return 0;
  return button & 1 ? -1 : +1;
}

/**
 * 纯函数:从可能含 ≥1 条完整报表的串里取末条滚轮方向(+1 上 / -1 下 / 0 无或非滚轮)。
 * 供"整体抛出整条报表"的前向兼容分支与测试用(当前 Node 拆碎,正常路径走 consumeMouse)。
 */
export function wheelFromReport(seq: string): number {
  let last = 0;
  for (const m of seq.matchAll(REPORT_RE_G)) {
    last = wheelDir(Number(m[1]));
  }
  return last;
}

let collecting = false;
let buf = '';
let stallTimer: NodeJS.Timeout | null = null;

function resetState(): void {
  collecting = false;
  buf = '';
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

/** 复位内部收集状态(退出 alt 屏 / 测试间清污染)。 */
export function resetMouse(): void {
  resetState();
}

function armStall(): void {
  if (stallTimer) clearTimeout(stallTimer);
  // 100ms 内未收齐视为畸形/丢失,丢半截(终端报表原子发出,跨 chunk >100ms 罕见;有界安全)。
  const t = setTimeout(resetState, 100);
  t.unref();
  stallTimer = t;
}

/**
 * 喂入一个 keypress 的 key.sequence,返回 { suppress, wheel }。
 *  - suppress=true:本 keypress 是鼠标 fragment(或完整报表),调用方须 return 吞掉。
 *  - wheel≠0:刚重组出一条完整滚轮报表,调用方调 layout.scrollBy(wheel*5)。
 *  - suppress=false:非鼠标,放行正常处理。
 */
export function consumeMouse(seq: string): { wheel: number; suppress: boolean } {
  if (!collecting) {
    if (!seq.startsWith(START)) return { wheel: 0, suppress: false };
    // 前向兼容:若未来 Node 整体抛整条报表(含完整 \x1B[<…M),直接解。
    if (REPORT_RE.test(seq)) return { wheel: wheelFromReport(seq), suppress: true };
    // 开收:首 fragment(典型 readline 的 `\x1b[<`,或 `\x1b[<64;5;` 半截)。
    collecting = true;
    buf = seq;
    armStall();
    return { wheel: 0, suppress: true };
  }
  // 收集中:追加。
  buf += seq;
  if (REPORT_RE.test(buf)) {
    const wheel = wheelFromReport(buf);
    resetState();
    return { wheel, suppress: true };
  }
  if (PARTIAL_RE.test(buf)) {
    // 合法未完成形状(无 M/m 终止)—— 继续等下一 fragment。
    return { wheel: 0, suppress: true };
  }
  // 偏离合法形状:畸形垃圾(报表跨 chunk 超时/编码异常)。丢半截,吞掉不打扰。
  resetState();
  return { wheel: 0, suppress: true };
}
