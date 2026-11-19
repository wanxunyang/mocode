/// <reference lib="dom" />

/**
 * 「按天」折线图的护栏（用户反馈：「默认显示好早之前的」「太小了看不清」「要能往左拖」）：
 *  1. 一天固定宽度 → 一年窗口画布 ≈ 7300px，比视口宽得多，横向滚动条才有得拖。
 *  2. 图是折线（一条 polyline，一天一个点），不是 365 根 2px 的柱子。
 *  3. 滚动起点由 panels 的 attachUsageCharts 设成最右端（最新一天），打开即「最近一个月」。
 *     这条在真实 DOM 里生效，测试容器的 scroll 字段是空的，所以只验证画布足够宽。
 *
 * 只断言渲染出来的 HTML 字符串，不搭真实 DOM：这类「图长什么样」的 bug 全在拼接逻辑里，
 * 用假 DOM 反而会替代码掩盖问题（例如桩不支持 class 选择器就静默返回空数组）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initPanels,
  handlePanelEvent,
  renderPanel,
  type PanelEnvelope,
} from '../../packages/work-app/src/renderer/panels.js';

interface SentCommand {
  type: string;
  id: string;
  days?: number;
  scope?: string;
}

function dayAt(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 一天一行；最后一天给个峰值，用来验证纵轴归一。 */
function globalReport(days: number): PanelEnvelope['payload'] {
  const rows = Array.from({ length: days }, (_all, index) => ({
    day: dayAt(index - days + 1),
    input: index === days - 1 ? 9_000 : 100 + index,
    output: 10,
    calls: index === days - 1 ? 40 : 2,
    sessions: 1,
  }));
  return {
    scope: 'global',
    days,
    summary: {
      fromDay: rows[0]!.day,
      toDay: rows[rows.length - 1]!.day,
      total: { input: 123_456, output: 7_890, cached: 1_000, reasoning: 20, calls: 88 },
      byDay: rows,
      byModel: [],
      byWorkspace: [],
    },
    calendar: { fromDay: rows[0]!.day, toDay: rows[rows.length - 1]!.day, days: rows },
  };
}

/** 一个只收集 innerHTML 的容器：面板的查询在这里一律返回空，断言只看拼出来的字符串。 */
function captureContainer(): { element: HTMLElement; html: () => string } {
  const box = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  return { element: box as unknown as HTMLElement, html: () => box.innerHTML };
}

test('用量面板首屏查近一年并把按天图画成可横向滚动的折线', async () => {
  const sent: SentCommand[] = [];
  initPanels({
    t: (key) => String(key),
    icon: () => '',
    escapeHtml: (value) => value,
    toast: () => {},
    currentTaskId: () => undefined,
    currentSessionId: () => undefined,
    reloadTask: () => {},
    send: async (command) => {
      const typed = command as unknown as SentCommand;
      sent.push(typed);
      // 主进程就地算完会立刻回一个 usage_report：这里同步回执，省掉等待。
      if (typed.type === 'usage') {
        handlePanelEvent({
          type: 'event',
          event: 'usage_report',
          requestId: typed.id,
          payload: globalReport(Number(typed.days)),
        });
      }
      return { ok: true };
    },
  });

  const view = captureContainer();
  await renderPanel('usage', view.element);
  const html = view.html();

  const usage = sent.filter((command) => command.type === 'usage');
  assert.equal(usage.length, 1, '首屏只该发一次 usage 请求');
  assert.equal(usage[0]!.days, 365, '首屏默认窗口必须是近一年（否则画布不够宽、没得拖）');
  assert.equal(usage[0]!.scope, 'global');

  // 画布宽度 = 天数 × 每天固定像素：这是「横向可拖」的前提，也保证点不挤在一起。
  const canvas = /<div class="usage-line-canvas" style="width:(\d+)px"/.exec(html);
  assert.ok(canvas, '按天图必须有一个固定宽度的画布容器');
  assert.equal(Number(canvas[1]), 365 * 20, '画布宽度 = 365 天 × 20px');
  assert.match(html, /class="usage-line-scroll"[^>]*/, '画布外层必须可横向滚动');

  // 折线：一条 polyline + 365 个点（一天一个），面积用同一串坐标闭合。
  const path = /<polyline class="usage-line-path" points="([^"]+)"/.exec(html);
  assert.ok(path, '按天图必须是一条折线（polyline），不是柱子');
  const points = path[1]!.trim().split(/\s+/);
  assert.equal(points.length, 365, '窗口 365 天 → 折线上 365 个点');
  // 最后一天是峰值 → 归一后应贴顶（y 接近 0），第一天更矮（y 更大）。
  const lastY = Number(points[points.length - 1]!.split(',')[1]);
  const firstY = Number(points[0]!.split(',')[1]);
  assert.ok(lastY < 1, `峰值应贴顶，实际 y=${lastY}`);
  assert.ok(firstY > lastY, '非峰值日的 y 必须更大（更靠下）');

  // 旧的「柱宽按天数收缩」实现整套消失，否则 365 天又会缩成一条线。
  assert.doesNotMatch(html, /usage-col-wrap|--col-w/);
  // 命中的是一排按钮（键盘可达），不是 SVG 里画点。
  assert.equal((html.match(/data-usage-line-hit/g) ?? []).length, 365);
});
