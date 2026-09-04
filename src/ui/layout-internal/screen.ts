// L0 屏幕原语:ANSI 序列表 / CUP / 几何 / 滚动区域 / 续写位归位。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { stdout } from 'node:process';
import { displayWidth, truncateDisplayHead } from '../render.js';
import type { Geo } from '../layout-types.js';
import { state } from './state.js';

/**
 * 全屏 TUI 布局:alt screen + 单滚动区域(内容区)+ 区域外固定底栏(状态行 + 输入框)。
 *
 * 只依赖最成熟、Windows(WT / conhost)最稳的 ANSI 子集:
 *  - alt screen        \x1B[?1049h / \x1B[?1049l
 *  - DECSTBM 滚动区域  \x1B[<top>;<bottom>r   (区域内写满自动在区域内滚动,区域外底栏不被顶)
 *  - 逐行擦除          \x1B[2K / \x1B[K        (菜单 / 清屏,绝不用 ED \x1B[J 做边界擦除)
 *  - CUP 绝对定位      \x1B[<row>;<col>H
 * 不用原点模式(\x1B[?6h)、不依赖 ED 边界、不用 DECSC/DECRC、不用 IL/DL/SU/SD——这些在 conhost 上不可靠。
 *
 * 续写位(contentRow / contentCol)由 contentWrite 按字符宽度 + 折行模拟跟踪;CUP 到它即可随时回到内容续写位,
 * 故底栏刷新(状态行 / spinner)无需保存/恢复光标——CUP 回续写位即可。
 *
 * 关键洞察:RUNNING 态也支持 typeahead 输入与滚动回看。INPUT 态光标常驻输入框;RUNNING 态光标在续写位,
 * 运行中打的字经 paintRunningInput(非 dim)回显(占位行换成已打文本,光标停在编辑位,不与流式争用);
 * 运行中可滚动回看——contentWrite 在 scrollOffset>0 时只喂缓冲不物理写(否则新流式覆盖 viewport 历史行),
 * 回尾(scrollOffset===0)才 cup 续写位写出。两态切换不重设区域(底栏高度恒 = 2),仅多行输入换行撑高时才 setRegion。
 *
 * 非 TTY:全部空操作,contentWrite 退化为 stdout.write,与改造前内联行为一致。
 */

// 可变运行态全部集中在 ./state.ts 的共享单例;本文件只留纯常量与函数。

/** 是否处于全屏 TUI(alt screen)激活态。非 TTY / 嵌入宿主(host)下为 false。
 *  子 agent 等异步路径据此判断能否把中间过程实时写入主内容区。 */
export function isTuiActive(): boolean {
  return state.active;
}

export const esc = {
  altOn: '\x1B[?1049h',
  altOff: '\x1B[?1049l',
  // 完整鼠标追踪:1000=按键(按下/释放)+ 1002=拖动 motion + 1006=SGR 编码。
  // 拿到按下/拖动/释放的坐标后,由 layout 在应用层维护选区(mouse.ts 重组报表 → handleMouseEvent):
  //  - 左键:内容区按下开选区、拖动扩展(触边自动翻页跨屏)、释放只留高亮,不自动复制;输入框不响应
  //    (不干扰正常打字/焦点)。
  //  - 右键(单击,press→release 未拖动):落在输入框 → 读剪贴板贴入(setPasteHandler 回调);
  //    落在内容区 → 复制当前选区(若有)到剪贴板(clipboard.ts),静默不弹提示。
  //  - 滚轮报表(button&64)转 scrollBy。
  // 代价:终端原生框选被鼠标捕获接管——想用终端原生选区可按住 Shift(多数终端放行)。
  // 1007l=关闭 Alternate Scroll Mode:VSCode xterm.js 进 alt screen(?1049)后默认开 1007,
  // 滚轮发 Up/Down 方向键而非 SGR 鼠标报表;不关的话滚轮会绕过 mouse.swallow 直接触发
  // prompt 的历史导航(recallPrevious/recallNext)→ "输入框打字时滚轮跳到上一条历史消息"。
  mouseOn: '\x1B[?1007l\x1B[?1000h\x1B[?1002h\x1B[?1006h',
  mouseOff: '\x1B[?1006l\x1B[?1002l\x1B[?1000l\x1B[?1007h', // 关:反序;末尾恢复 1007(交还终端默认)
  cursorShow: '\x1B[?25h',
  cursorHide: '\x1B[?25l',
  clearLine: '\x1B[2K',
  home: '\x1B[H',
};

/** CUP(光标绝对定位),钳到 >=1。 */
export function cup(row: number, col: number): string {
  return `\x1B[${Math.max(1, Math.round(row))};${Math.max(1, Math.round(col))}H`;
}

export function getGeo(fh: number = state.footerH): Geo {
  const rows = stdout.rows || 24;
  const cols = stdout.columns || 80;
  const f = Math.max(1, Math.min(fh, rows - 1));
  return {
    rows,
    cols,
    footerH: f,
    contentTop: 1,
    contentBottom: Math.max(1, rows - f),
  };
}

/** (重)设滚动区域 [1, rows-footerH];设完 \x1B[H 归位(conhost 设 DECSTBM 时光标留旧位置行为未定义)。 */
export function setRegion(fh: number): Geo {
  const rows = stdout.rows || 24;
  const oldBottom = Math.max(1, rows - state.footerH);
  const g = getGeo(fh);
  state.footerH = g.footerH;
  if (state.active) {
    stdout.write(`\x1B[1;${g.contentBottom}r`); // DECSTBM: top=1, bottom=contentBottom
    // 底栏缩小:原底栏行变回内容区,清掉残留底栏文本(否则提交多行后旧输入残留在底部)
    if (g.contentBottom > oldBottom) {
      let p = '';
      for (let r = oldBottom + 1; r <= g.contentBottom; r++) {
        p += cup(r, 1) + esc.clearLine;
      }
      stdout.write(p);
    }
    stdout.write(esc.home);
  }
  if (state.contentRow > g.contentBottom) state.contentRow = g.contentBottom; // 底栏撑高挤掉内容:钳到新区底
  return g;
}

/** 运行态真光标(隐藏)的归位点 = 输入框光标位:行 = 动态 contentBottom+3+planRows(resize 安全)。
 *  非 dim 运行态(与空闲态同色、可任意位置编辑)→ 归当前编辑位,供 IME 锚定气泡到光标处;
 *  dim 占位(空 + placeholder)兼容态→ 归输入框起点。供 IME 锚定。 */
export function runningCaretPos(): { row: number; col: number } {
  const g = getGeo();
  const row = g.contentBottom + 3 + state.planRows;
  if (state.lastView && !state.lastView.dim) {
    const promptW = displayWidth(state.lastView.prompt);
    const line = state.lastView.lines[state.lastView.cursorLine] ?? '';
    const before = line.slice(0, state.lastView.cursorCol);
    const col = Math.min(g.cols, promptW + displayWidth(before) + 1);
    return { row, col };
  }
  const text = state.lastView?.dim ? state.lastView.lines[0] ?? '' : '';
  const contentW = Math.max(0, g.cols - 3); // ❯ =2 + 光标=1
  const w = displayWidth(truncateDisplayHead(text, contentW));
  return { row, col: Math.min(g.cols, 2 + w + 1) };
}

export function contentMode(): void {
  if (!state.active) return;
  const g = getGeo();
  if (state.mode === 'running') {
    // 运行态(回尾 / 滚动回看均):真光标归输入框光标位(供 IME 锚定,气泡不跟流式跑)。
    // 滚动态也归输入框——否则上滑看历史时打字,IME 候选气泡会锚到内容区底而非输入框
    // (conhost IME 不跟随 cup 后续移动,须让打字前光标已在输入框)。
    const p = runningCaretPos();
    stdout.write(cup(p.row, p.col));
  } else {
    // INPUT 态:回尾归续写位,滚动回看归内容区底(viewport 锁历史;INPUT 态无 IME 锚定需求)
    stdout.write(
      cup(
        state.scrollOffset === 0 ? state.contentRow : g.contentBottom,
        state.scrollOffset === 0 ? state.contentCol : 1
      )
    );
  }
}

/** 运行态用户是否在打字(近期有按键)——是则暂停流式物理写(contentWrite/drawStatusBar/paintLiveAtCursor 跳过物理写),光标留输入框,IME 候选窗稳定不跟流式跑。 */
export function isStreamingPaused(): boolean {
  return state.mode === 'running' && Date.now() < state.userActiveUntil;
}
