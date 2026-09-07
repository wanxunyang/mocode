/**
 * computer 工具:桌面 GUI 操控闭环。
 *
 * 结构:校验(纯函数,可单测) → 动作前截屏(拿物理分辨率做 norm1000 换算) →
 * InputInjector 注入动作 → 动作后重截屏 → 缩放 → modelAttachments 回灌。
 * 模型只面对归一化 0-1000 坐标网格,从不感知物理分辨率/DPI/多屏。
 *
 * 安全:risk=dangerous(权限弹窗默认高亮「拒绝」),plan 模式常驻屏蔽,
 * /cu off 时既不进 schema 也被运行时兜底拦截。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { jailResolve } from '../../sandbox/index.js';
import { captureDesktop } from '../../runtime/screen-capture.js';
import {
  decodePng,
  encodePng,
  downscale,
  fitToLongEdge,
  crop,
  readPngSize,
  diffRatio,
  normToPhysical,
  normRectToPhysical,
  physicalToNorm,
  isNormCoord,
  type PngImage,
} from '../../runtime/screen-pipeline.js';
import { createInputInjector, type InputInjector } from '../../runtime/input-injector.js';
import type { Tool, ToolOutcome } from '../types.js';

/**
 * 喂模型的截图长边上限。1280 是 Anthropic 的兼容下限,1568 对齐主流视觉模型原生分辨率 ——
 * 4K 屏上小字/密集 UI 的定位精度提升明显,代价是每张图多约 300 token。可用
 * MOCODE_CU_MAX_EDGE 覆盖。
 */
const DEFAULT_MAX_EDGE = 1568;
function maxEdge(): number {
  const raw = Number(process.env.MOCODE_CU_MAX_EDGE);
  if (!Number.isFinite(raw) || raw < 256 || raw > 4096) return DEFAULT_MAX_EDGE;
  return Math.round(raw);
}

/**
 * 帧间差异低于此比例就认为「屏幕没变」,跳过回灌。
 * 0.005 = 0.5%,足以吃掉抗锯齿/光标抖动,又不会漏掉真实重绘(局部重绘通常 >1%)。
 */
const DEFAULT_DIFF_THRESHOLD = 0.005;
function diffThreshold(): number {
  // 空串必须显式回落:Number('') === 0,而 0 能通过下面的区间校验 —— 用户在 .env 里清空这个
  // 变量(注释掉的常见写法)会静默把去重关掉。0 是合法的显式值(关闭去重),空不是。
  const rawEnv = process.env.MOCODE_CU_DIFF_THRESHOLD;
  if (rawEnv === undefined || rawEnv.trim() === '') return DEFAULT_DIFF_THRESHOLD;
  const raw = Number(rawEnv);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return DEFAULT_DIFF_THRESHOLD;
  return raw;
}

const WAIT_MAX_MS = 10000;
const SCROLL_MAX = 10;

const ACTIONS = [
  'screenshot',
  'zoom',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'type',
  'key',
  'scroll',
  'wait',
  'cursor_position',
] as const;
type ComputerAction = (typeof ACTIONS)[number];

const ACTIONS_NEEDING_COORDINATE: ReadonlySet<ComputerAction> = new Set([
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'scroll',
]);

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isNormCoord(v[0]) && isNormCoord(v[1]);
}

/**
 * 校验 computer 调用参数。返回 null 表示通过,否则返回面向模型的错误消息。
 * 纯函数,独立可单测。
 */
export function validateComputerArgs(args: Record<string, unknown>): string | null {
  const action = args.action as ComputerAction;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    return `unknown action "${String(args.action)}"; expected one of: ${ACTIONS.join(', ')}`;
  }
  if (ACTIONS_NEEDING_COORDINATE.has(action) && !isPair(args.coordinate)) {
    return `action "${action}" requires coordinate: [x, y] integers in normalized 0-1000 space`;
  }
  if (action === 'left_click_drag' && !isPair(args.coordinate_to)) {
    return 'action "left_click_drag" requires coordinate_to: [x, y] integers in normalized 0-1000 space';
  }
  if (action === 'zoom') {
    const r = args.region;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(isNormCoord)) {
      return 'action "zoom" requires region: [x, y, w, h] integers in normalized 0-1000 space';
    }
    if ((r[2] as number) <= 0 || (r[3] as number) <= 0) {
      return 'zoom region w/h must be > 0';
    }
  }
  if (action === 'type' || action === 'key') {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return `action "${action}" requires a non-empty text string`;
    }
  }
  if (action === 'scroll') {
    const dir = args.scroll_direction;
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
      return 'action "scroll" requires scroll_direction: up|down|left|right';
    }
    const amount = args.scroll_amount ?? 3;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > SCROLL_MAX) {
      return `scroll_amount must be an integer in 1-${SCROLL_MAX}`;
    }
  }
  if (action === 'wait') {
    const ms = args.duration_ms;
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > WAIT_MAX_MS) {
      return `action "wait" requires duration_ms: integer in 1-${WAIT_MAX_MS}`;
    }
  }
  return null;
}

/**
 * 屏幕几何:截图尺寸与点击坐标尺寸**必须分开**。
 * - shotW/H:抓到的位图尺寸,只用于裁剪(zoom)与展示;
 * - physW/H:主屏真实物理分辨率,只用于 norm1000 → SetCursorPos 换算。
 * 在 DPI 虚拟化生效时(默认 PowerShell 是 DPI UNAWARE)两者差一个缩放比(150% 屏上为 1.5×),
 * 若混用会导致所有点击落在正确位置的 1/scale 处。
 */
interface ScreenState {
  shotW: number;
  shotH: number;
  physW: number;
  physH: number;
  originX: number;
  originY: number;
}

/**
 * 会话级几何缓存。显示器分辨率/DPI 在一次会话里几乎不变,而每次调用都重抓一次屏只为拿
 * 宽高是纯粹的浪费 —— 抓屏是整条链路最贵的一步(冷启动 PowerShell + 4K 位图 CopyFromScreen)。
 * 缓存后每个输入动作只需**一次**抓屏(动作后的重截屏),比原来少一半。
 *
 * 失效:每次动作后的重截屏都会回传 geometry,与之不符就立即更新缓存并提示模型重试
 * (插拔外接屏 / 改缩放比时,这一步的坐标是用旧几何算的,必须让模型知道)。
 */
let geometryCache: ScreenState | null = null;

/** 会话级上一帧(已 downscale),用于差分。/cu off 时清空。 */
let lastFrame: PngImage | null = null;

export function resetComputerState(): void {
  geometryCache = null;
  lastFrame = null;
}

/** 抓一次主屏并返回几何信息。Windows 走 captureDesktop 的 geometry(零解码);其余平台只读 IHDR。 */
async function capturePrimary(signal?: AbortSignal): Promise<{ path: string } & ScreenState> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = jailResolve(`.mocode/screenshots/computer-${ts}-${Math.random().toString(36).slice(2, 8)}.png`);
  await mkdir(dirname(outputPath), { recursive: true });
  const cap = await captureDesktop(outputPath, 'primary', signal);
  if (cap.status !== 'passed') {
    throw new Error(`screenshot capture failed: ${cap.detail}`);
  }
  const g = cap.geometry;
  if (g && g.shotW > 0 && g.shotH > 0 && g.physW > 0 && g.physH > 0) {
    return {
      path: outputPath,
      shotW: g.shotW,
      shotH: g.shotH,
      physW: g.physW,
      physH: g.physH,
      originX: g.originX,
      originY: g.originY,
    };
  }
  // 非 Windows 或 geometry 缺失:只读 IHDR,不要为了两个数字解码 14MB 像素。
  const size = readPngSize(await readFile(outputPath));
  if (!size) throw new Error('screenshot captured but its dimensions could not be read');
  return {
    path: outputPath,
    shotW: size.width,
    shotH: size.height,
    physW: size.width,
    physH: size.height,
    originX: 0,
    originY: 0,
  };
}

/** 取当前屏幕几何:命中缓存则不抓屏(path 为 undefined)。 */
async function resolveScreen(signal?: AbortSignal): Promise<{ screen: ScreenState; path?: string }> {
  if (geometryCache) return { screen: geometryCache };
  const shot = await capturePrimary(signal);
  geometryCache = {
    shotW: shot.shotW,
    shotH: shot.shotH,
    physW: shot.physW,
    physH: shot.physH,
    originX: shot.originX,
    originY: shot.originY,
  };
  return { screen: geometryCache, path: shot.path };
}

/** 用最新一次抓屏的几何校正缓存;返回 true 表示本次动作的坐标可能是用过期几何算的。 */
function syncGeometry(shot: ScreenState): boolean {
  const prev = geometryCache;
  const changed =
    !prev ||
    prev.physW !== shot.physW ||
    prev.physH !== shot.physH ||
    prev.shotW !== shot.shotW ||
    prev.shotH !== shot.shotH ||
    prev.originX !== shot.originX ||
    prev.originY !== shot.originY;
  geometryCache = { ...shot };
  return changed && prev !== null;
}

interface Frame {
  dataUrl: string;
  bytes: number;
  dispW: number;
  dispH: number;
  /** 与上一帧的差异比例;undefined = 无基准(会话首帧)。 */
  diff?: number;
}

/** 读 PNG 文件 → 缩放 → 编码 → dataUrl,顺带算出与上一帧的差异。 */
async function toAttachment(path: string, m?: ComputerMetric): Promise<Frame & { img: PngImage }> {
  let t = Date.now();
  const png = decodePng(await readFile(path));
  if (m) m.decodeMs += Date.now() - t;
  t = Date.now();
  const { img } = downscale(png, maxEdge());
  if (m) m.scaleMs += Date.now() - t;
  const prev = lastFrame;
  let diff: number | undefined;
  if (prev && prev.width === img.width && prev.height === img.height) {
    diff = diffRatio(prev, img);
  }
  t = Date.now();
  const buf = encodePng(img);
  if (m) m.encodeMs += Date.now() - t;
  return {
    dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    bytes: buf.length,
    dispW: img.width,
    dispH: img.height,
    diff,
    img,
  };
}

/** 回灌了一帧:把它设为新的差分基准。 */
function commitFrame(img: PngImage): void {
  lastFrame = img;
}

async function executeAction(
  injector: InputInjector,
  action: ComputerAction,
  args: Record<string, unknown>,
  screen: ScreenState,
): Promise<string> {
  const { physW, physH, originX, originY } = screen;
  // norm1000 → 虚拟桌面物理像素:先按物理分辨率缩放,再叠加主屏原点(多屏)。
  const toPhys = (pair: [number, number]): [number, number] => {
    const [x, y] = normToPhysical(pair[0], pair[1], physW, physH);
    return [originX + x, originY + y];
  };
  switch (action) {
    case 'mouse_move': {
      const [x, y] = toPhys(args.coordinate as [number, number]);
      await injector.moveTo(x, y);
      return `moved cursor to (${x}, ${y})`;
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const [x, y] = toPhys(args.coordinate as [number, number]);
      await injector.moveTo(x, y);
      const button = action.startsWith('right') ? 'right' : action.startsWith('middle') ? 'middle' : 'left';
      const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
      await injector.click(button, count as 1 | 2 | 3);
      return `${action} at (${x}, ${y})`;
    }
    case 'left_mouse_down':
    case 'left_mouse_up': {
      const [x, y] = toPhys(args.coordinate as [number, number]);
      await injector.moveTo(x, y);
      if (action === 'left_mouse_down') await injector.mouseDown('left');
      else await injector.mouseUp('left');
      return `${action} at (${x}, ${y})`;
    }
    case 'left_click_drag': {
      const [x0, y0] = toPhys(args.coordinate as [number, number]);
      const [x1, y1] = toPhys(args.coordinate_to as [number, number]);
      await injector.moveTo(x0, y0);
      await injector.mouseDown('left');
      await injector.dragTo(x1, y1);
      await injector.mouseUp('left');
      return `dragged from (${x0}, ${y0}) to (${x1}, ${y1})`;
    }
    case 'type': {
      await injector.typeText(args.text as string);
      return `typed ${(args.text as string).length} characters`;
    }
    case 'key': {
      await injector.pressKey(args.text as string);
      return `pressed key combo "${args.text}"`;
    }
    case 'scroll': {
      const [x, y] = toPhys(args.coordinate as [number, number]);
      await injector.moveTo(x, y);
      const amount = (args.scroll_amount as number | undefined) ?? 3;
      await injector.scroll(args.scroll_direction as 'up' | 'down' | 'left' | 'right', amount);
      return `scrolled ${args.scroll_direction} by ${amount} at (${x}, ${y})`;
    }
    case 'wait': {
      await new Promise((r) => setTimeout(r, args.duration_ms as number));
      return `waited ${args.duration_ms}ms`;
    }
    case 'cursor_position': {
      const pos = await injector.cursorPosition();
      const [nx, ny] = physicalToNorm(pos.x - originX, pos.y - originY, physW, physH);
      return `cursor at physical (${pos.x}, ${pos.y}) = normalized (${nx}, ${ny})`;
    }
    default:
      throw new Error(`no executor for action "${action}"`);
  }
}

// ── 埋点 ────────────────────────────────────────────────────────────────
// 优化必须可度量:先有基线 p50/p95,再谈优化。这里不走 turnLifecycle(ToolContext 拿不到),
// 用模块级 ring buffer + /cu status 暴露,零依赖、零 I/O、不污染 TUI。

export interface ComputerMetric {
  action: string;
  captureMs: number;
  decodeMs: number;
  scaleMs: number;
  encodeMs: number;
  injectMs: number;
  totalMs: number;
  bytes: number;
  diff?: number;
  /** 差分命中、未回灌图片。 */
  skipped: boolean;
}

const METRIC_CAP = 50;
const metrics: ComputerMetric[] = [];

function recordMetric(m: ComputerMetric): void {
  metrics.push(m);
  if (metrics.length > METRIC_CAP) metrics.shift();
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return Math.round(s[i]);
}

export interface ComputerMetricsSummary {
  count: number;
  totalP50: number;
  totalP95: number;
  captureP50: number;
  skippedRatio: number;
  avgBytes: number;
  last?: ComputerMetric;
}

export function getComputerMetrics(): ComputerMetricsSummary {
  const totals = metrics.map((m) => m.totalMs);
  const caps = metrics.map((m) => m.captureMs);
  const skipped = metrics.filter((m) => m.skipped).length;
  const bytes = metrics.reduce((a, m) => a + m.bytes, 0);
  return {
    count: metrics.length,
    totalP50: pct(totals, 50),
    totalP95: pct(totals, 95),
    captureP50: pct(caps, 50),
    skippedRatio: metrics.length ? skipped / metrics.length : 0,
    avgBytes: metrics.length ? Math.round(bytes / metrics.length) : 0,
    last: metrics[metrics.length - 1],
  };
}

export function resetComputerMetrics(): void {
  metrics.length = 0;
}

export const computerTool: Tool = {
  name: 'computer',
  description:
    'Control the desktop GUI: move/click the mouse, type text, press keys, scroll, and zoom into screen regions. ' +
    'Every action re-captures the screen. If the screen is unchanged since the last screenshot you saw, no image is ' +
    'attached and the result says so — treat the previous screenshot as still current instead of assuming the action failed. ' +
    'Inspect each attached screenshot before the next action and self-correct. ' +
    'Coordinates use a normalized 0-1000 grid (x right, y down) over the primary screen; you never need the physical resolution. ' +
    'Use zoom on a tight region before clicking small or dense UI elements. Destructive or sensitive targets ' +
    '(form submit, payment, credentials, delete/send) require explicit user intent — ask first.',
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      coordinate: {
        type: 'array',
        items: { type: 'integer' },
        minItems: 2,
        maxItems: 2,
        description: '[x, y] in normalized 0-1000 space. Required for move/click/scroll/drag start.',
      },
      coordinate_to: {
        type: 'array',
        items: { type: 'integer' },
        minItems: 2,
        maxItems: 2,
        description: 'Drag destination in normalized 0-1000 space (left_click_drag only).',
      },
      text: {
        type: 'string',
        description: 'Text to type (type) or key combo like "ctrl+s" / "Return" / "ctrl+shift+t" (key).',
      },
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'integer', description: `Scroll clicks 1-${SCROLL_MAX} (default 3).` },
      region: {
        type: 'array',
        items: { type: 'integer' },
        minItems: 4,
        maxItems: 4,
        description: 'zoom only: [x, y, w, h] in normalized 0-1000 space.',
      },
      duration_ms: { type: 'integer', description: `wait only: milliseconds (1-${WAIT_MAX_MS}).` },
      target: {
        type: 'string',
        enum: ['primary', 'all'],
        description: 'screenshot only: display scope (default primary). All other actions act on the primary screen.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolOutcome> {
    const invalid = validateComputerArgs(args);
    if (invalid) {
      return {
        status: 'error',
        code: 'INVALID_ARGUMENTS',
        retryable: false,
        output: `Invalid computer action: ${invalid}`,
      };
    }
    const action = args.action as ComputerAction;

    const started = Date.now();
    const m: ComputerMetric = {
      action,
      captureMs: 0,
      decodeMs: 0,
      scaleMs: 0,
      encodeMs: 0,
      injectMs: 0,
      totalMs: 0,
      bytes: 0,
      skipped: false,
    };

    let injector: InputInjector;
    try {
      injector = createInputInjector();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'error', code: 'EXECUTION_ERROR', retryable: false, output: message };
    }
    injector.bindSignal(ctx?.signal);

    // left_mouse_down 之后若中途失败/中断,鼠标会一直处于按下状态 —— 用户的桌面就废了。
    // 这里统一在 finally 里兜底释放。
    let pendingMouseDown = false;

    try {
      // 只有 zoom / screenshot 真正需要一张新位图;输入动作只需要**几何**,命中会话缓存就不抓屏
      // (抓屏是整条链路最贵的一步,省掉这一步等于把每步的本地开销砍半)。
      let screen: ScreenState;
      let freshPath: string | undefined;
      if (action === 'zoom' || action === 'screenshot') {
        const t = Date.now();
        const shot = await capturePrimary(ctx?.signal);
        m.captureMs += Date.now() - t;
        screen = {
          shotW: shot.shotW,
          shotH: shot.shotH,
          physW: shot.physW,
          physH: shot.physH,
          originX: shot.originX,
          originY: shot.originY,
        };
        syncGeometry(screen);
        freshPath = shot.path;
      } else {
        const t = Date.now();
        const r = await resolveScreen(ctx?.signal);
        m.captureMs += Date.now() - t;
        screen = r.screen;
        freshPath = r.path;
      }

      // zoom:不注入输入,裁 region 放大回灌。裁剪发生在截图位图上,故用 shotW/shotH。
      if (action === 'zoom' && freshPath) {
        const rect = normRectToPhysical(args.region as [number, number, number, number], screen.shotW, screen.shotH);
        let t = Date.now();
        const png = decodePng(await readFile(freshPath));
        m.decodeMs += Date.now() - t;
        t = Date.now();
        const zoomed = fitToLongEdge(crop(png, rect.x, rect.y, rect.w, rect.h), maxEdge());
        m.scaleMs += Date.now() - t;
        t = Date.now();
        const buf = encodePng(zoomed);
        m.encodeMs += Date.now() - t;
        m.bytes = buf.length;
        // zoom 出的图不是全屏基准,不能喂给差分。
        lastFrame = null;
        return {
          status: 'success',
          code: 'OK',
          retryable: false,
          output:
            `Zoomed into region ${JSON.stringify(args.region)} → screenshot pixels (${rect.x}, ${rect.y}, ${rect.w}×${rect.h}), ` +
            `magnified to ${zoomed.width}×${zoomed.height}. The attached image shows ONLY this region — ` +
            `coordinates you output still map to the FULL screen, so do not reuse this region's local coordinates for clicks.`,
          modelAttachments: [
            {
              type: 'image',
              name: 'computer-zoom.png',
              mime: 'image/png',
              dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
            },
          ],
        };
      }

      // screenshot:只截屏回灌(target 可指定 all)。
      if (action === 'screenshot') {
        let shotPath = freshPath;
        if (args.target === 'all') {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const allPath = jailResolve(`.mocode/screenshots/computer-${ts}-all.png`);
          await mkdir(dirname(allPath), { recursive: true });
          const t = Date.now();
          const cap = await captureDesktop(allPath, 'all', ctx?.signal);
          m.captureMs += Date.now() - t;
          if (cap.status !== 'passed') throw new Error(`screenshot capture failed: ${cap.detail}`);
          shotPath = allPath;
        }
        const att = await toAttachment(shotPath as string, m);
        commitFrame(att.img);
        m.bytes = att.bytes;
        return {
          status: 'success',
          code: 'OK',
          retryable: false,
          output:
            `Screenshot captured (primary screen ${screen.physW}×${screen.physH} physical, shown at ${att.dispW}×${att.dispH}). ` +
            'Coordinates remain normalized 0-1000 over the primary screen. Visual content is attached to the next model request.',
          modelAttachments: [
            { type: 'image', name: 'computer-screenshot.png', mime: 'image/png', dataUrl: att.dataUrl },
          ],
        };
      }

      // 输入动作:注入 → 重截屏回灌(wait 也回灌,等待后界面往往已变化)。
      if (action === 'left_mouse_down') pendingMouseDown = true;
      let t = Date.now();
      const summary = await executeAction(injector, action, args, screen);
      m.injectMs += Date.now() - t;
      if (action === 'left_mouse_up') pendingMouseDown = false;

      t = Date.now();
      const after = await capturePrimary(ctx?.signal);
      m.captureMs += Date.now() - t;
      const geometryStale = syncGeometry(after);

      const att = await toAttachment(after.path, m);
      m.bytes = att.bytes;
      m.diff = att.diff;

      const staleNote = geometryStale
        ? ' WARNING: display geometry changed mid-action (monitor or scaling change); ' +
          'coordinates for this action used the previous geometry — verify and repeat if the click landed wrong.'
        : '';

      // 差分命中:屏幕与模型上次看到的相比没变,再发一张同样的图只是白烧 token 和 prefill。
      if (att.diff !== undefined && att.diff < diffThreshold()) {
        m.skipped = true;
        return {
          status: 'success',
          code: 'OK',
          retryable: false,
          output:
            `${summary}. No visible change on screen (frame diff ${(att.diff * 100).toFixed(2)}% < ` +
            `${(diffThreshold() * 100).toFixed(2)}% threshold) — no new screenshot is attached; ` +
            'the previous screenshot is still current. If you expected a change, the action likely did not ' +
            `take effect: re-check the target coordinates or try a different approach.${staleNote}`,
        };
      }
      commitFrame(att.img);

      return {
        status: 'success',
        code: 'OK',
        retryable: false,
        output:
          `${summary}. Screen re-captured (primary screen ${screen.physW}×${screen.physH} physical, shown at ${att.dispW}×${att.dispH}): ` +
          `inspect the attached screenshot to verify the result before the next action.${staleNote}`,
        modelAttachments: [{ type: 'image', name: 'computer-result.png', mime: 'image/png', dataUrl: att.dataUrl }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx?.signal?.aborted || /aborted/i.test(message)) {
        return { status: 'aborted', code: 'ABORTED', retryable: false, output: message };
      }
      return {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        output: `computer action failed: ${message}`,
      };
    } finally {
      if (pendingMouseDown) {
        try {
          await injector.mouseUp('left');
        } catch {
          // 释放失败也要让上层拿到原本的错误,不掩盖。
        }
      }
      m.totalMs = Date.now() - started;
      recordMetric(m);
    }
  },
};
