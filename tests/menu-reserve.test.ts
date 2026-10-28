import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { stdout } from 'node:process';
import * as content from '../src/ui/content.js';
import { state } from '../src/ui/layout-internal/state.js';
import { getGeo } from '../src/ui/layout-internal/screen.js';
import { setMenuReserve, viewportAbsStart } from '../src/ui/layout-internal/scroll.js';

// 介入面板(ask_human / 权限)在 RUNNING 态弹出时,菜单必须给正文让出底部行,
// 而不是把最关键的命令/diff/ask_human 行直接盖掉。这里用 stdout 桩验证视口几何,
// 不依赖真 TTY(state.active 直置、stdout.rows/columns/write 打桩)。

const ROWS = 12;
const COLS = 40;
let writes: string[] = [];
let rowsBackup: number | undefined;
let colsBackup: number | undefined;
let writeBackup: typeof stdout.write;

function setupStubs(): void {
  writes = [];
  rowsBackup = stdout.rows;
  colsBackup = stdout.columns;
  writeBackup = stdout.write.bind(stdout);
  Object.defineProperty(stdout, 'rows', { value: ROWS, configurable: true });
  Object.defineProperty(stdout, 'columns', { value: COLS, configurable: true });
  // 测试桩:吞掉所有 ANSI 写屏,只记录是否写过。
  Object.defineProperty(stdout, 'write', {
    configurable: true,
    value: (s: string): boolean => {
      writes.push(s);
      return true;
    },
  });
  state.active = true;
  state.menuReserveRows = 0;
  state.scrollOffset = 0;
  state.footerH = 6; // 与 enterAltScreen 默认一致 → contentBottom = 6
  content.reset();
}

function restoreStubs(): void {
  Object.defineProperty(stdout, 'rows', { value: rowsBackup, configurable: true });
  Object.defineProperty(stdout, 'columns', { value: colsBackup, configurable: true });
  Object.defineProperty(stdout, 'write', { configurable: true, value: writeBackup });
  state.active = false;
  state.menuReserveRows = 0;
  state.scrollOffset = 0;
  content.reset();
}

/** 喂 n 个已提交物理行进内容缓冲(最后一行也 breakRow,totalRows === n,无悬空当前行)。 */
function feed(n: number, prefix = 'line'): void {
  for (let i = 1; i <= n; i++) {
    content.feedChar(`${prefix}-${i}`);
    content.breakRow();
  }
}

/** 去掉行尾 reset,便于人读断言。 */
const plain = (lines: string[]): string[] => lines.map((l) => l.replace(/\x1b\[0m$/, ''));

describe('介入面板菜单预留行(menuReserveRows)', () => {
  afterEach(restoreStubs);

  it('无预留时视口高 = contentBottom,尾窗从最新行起', () => {
    setupStubs();
    feed(getGeo().contentBottom);
    assert.equal(state.menuReserveRows, 0);
    // breakRow 后始终留一个空"当前行":6 个已提交行 + 1 空当前行 = 7,窗口起点 1。
    assert.equal(content.totalRows(), getGeo().contentBottom + 1);
    assert.equal(viewportAbsStart(), 1);
  });

  it('预留 N 行后,有效视口收缩为 contentBottom-N,最新正文整体上移到菜单上沿之上', () => {
    setupStubs();
    feed(6); // 6 个已提交行 + 1 空当前行
    setMenuReserve(3); // 菜单占底部 3 行 → 有效正文区只剩 3 行
    assert.equal(state.menuReserveRows, 3);
    // 有效视口尾窗 3 行:line-5、line-6 与空"当前行"(续写位);line-4 及更早被推出顶部,而非被菜单盖住。
    assert.equal(viewportAbsStart(), 7 - 3);
    assert.deepEqual(plain(content.sliceFromEnd(0, getGeo().contentBottom - 3)), ['line-5', 'line-6', '']);
  });

  it('设置预留时把超过压缩视口上限的滚动偏移钳回', () => {
    setupStubs();
    feed(20); // 21 个缓冲行(含空当前行)
    // 先在满视口(contentBottom=6)滚到中段:offset=10。
    state.scrollOffset = 10;
    // 菜单占 4 行 → 有效视口 2 行,最大 offset = 21-2 = 19(10 仍合法,不变)。
    setMenuReserve(4);
    assert.equal(state.scrollOffset, 10);
    // 再滚到很旧(offset=20 > 19),随后菜单缩短释放为满视口:setMenuReserve(0) 重算上限 21-6=15,钳回。
    state.scrollOffset = 20;
    setMenuReserve(0);
    assert.equal(state.scrollOffset, 15);
  });

  it('释放预留后恢复满内容区,底部行重新可见', () => {
    setupStubs();
    feed(6);
    setMenuReserve(3);
    assert.equal(viewportAbsStart(), 4);
    setMenuReserve(0);
    assert.equal(state.menuReserveRows, 0);
    assert.equal(viewportAbsStart(), 1);
  });

  it('预留行数被钳到 contentBottom-1,极端矮窗也不会把正文区压成 0/负', () => {
    setupStubs();
    setMenuReserve(999);
    assert.equal(state.menuReserveRows, getGeo().contentBottom - 1);
    assert.ok(getGeo().contentBottom - state.menuReserveRows >= 1);
  });

  it('设置相同预留值时不重画(↑↓ 导航菜单高度不变不闪屏)', () => {
    setupStubs();
    setMenuReserve(2);
    writes.length = 0;
    setMenuReserve(2);
    assert.equal(writes.length, 0);
  });

  it('非激活 TUI 下 setMenuReserve 为空操作', () => {
    setupStubs();
    state.active = false;
    setMenuReserve(3);
    assert.equal(state.menuReserveRows, 0);
  });
});
