/**
 * computer 工具:桌面 GUI 操控闭环(设计 docs/computer-use-design.md)。
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
  normToPhysical,
  normRectToPhysical,
  physicalToNorm,
  isNormCoord,
} from '../../runtime/screen-pipeline.js';
import { createInputInjector, type InputInjector } from '../../runtime/input-injector.js';
import type { Tool, ToolOutcome } from '../types.js';

/** 喂模型的截图长边上限(Anthropic 推荐区间)。 */
const MAX_EDGE = 1280;
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

interface ScreenState {
  physW: number;
  physH: number;
}

/** 抓一次主屏并返回物理分辨率。 */
async function capturePrimary(signal?: AbortSignal): Promise<{ path: string } & ScreenState> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = jailResolve(`.mocode/screenshots/computer-${ts}-${Math.random().toString(36).slice(2, 8)}.png`);
  await mkdir(dirname(outputPath), { recursive: true });
  const cap = await captureDesktop(outputPath, 'primary', signal);
  if (cap.status !== 'passed') {
    throw new Error(`screenshot capture failed: ${cap.detail}`);
  }
  const png = decodePng(await readFile(outputPath));
  return { path: outputPath, physW: png.width, physH: png.height };
}

/** 读 PNG 文件 → 缩放 → 编码 → dataUrl。 */
async function toAttachment(path: string): Promise<{ dataUrl: string; bytes: number; dispW: number; dispH: number }> {
  const png = decodePng(await readFile(path));
  const { img } = downscale(png, MAX_EDGE);
  const buf = encodePng(img);
  return {
    dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    bytes: buf.length,
    dispW: img.width,
    dispH: img.height,
  };
}

async function executeAction(
  injector: InputInjector,
  action: ComputerAction,
  args: Record<string, unknown>,
  screen: ScreenState,
): Promise<string> {
  const { physW, physH } = screen;
  const toPhys = (pair: [number, number]): [number, number] => normToPhysical(pair[0], pair[1], physW, physH);
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
      const [nx, ny] = physicalToNorm(pos.x, pos.y, physW, physH);
      return `cursor at physical (${pos.x}, ${pos.y}) = normalized (${nx}, ${ny})`;
    }
    default:
      throw new Error(`no executor for action "${action}"`);
  }
}

export const computerTool: Tool = {
  name: 'computer',
  description:
    'Control the desktop GUI: move/click the mouse, type text, press keys, scroll, and zoom into screen regions. ' +
    'Every action returns a fresh screenshot as a visual attachment — inspect it before the next action and self-correct. ' +
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
      return { status: 'error', code: 'INVALID_ARGUMENTS', retryable: false, output: `Invalid computer action: ${invalid}` };
    }
    const action = args.action as ComputerAction;

    let injector: InputInjector;
    try {
      injector = createInputInjector();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'error', code: 'EXECUTION_ERROR', retryable: false, output: message };
    }
    injector.bindSignal(ctx?.signal);

    try {
      // 动作前截屏:拿物理分辨率(norm1000 → 物理像素换算的基础)。
      const before = await capturePrimary(ctx?.signal);
      const screen: ScreenState = { physW: before.physW, physH: before.physH };

      // zoom:不注入输入,裁 region 放大回灌。
      if (action === 'zoom') {
        const rect = normRectToPhysical(args.region as [number, number, number, number], screen.physW, screen.physH);
        const png = decodePng(await readFile(before.path));
        const zoomed = fitToLongEdge(crop(png, rect.x, rect.y, rect.w, rect.h), MAX_EDGE);
        const buf = encodePng(zoomed);
        return {
          status: 'success',
          code: 'OK',
          retryable: false,
          output:
            `Zoomed into region ${JSON.stringify(args.region)} → physical (${rect.x}, ${rect.y}, ${rect.w}×${rect.h}), ` +
            `magnified to ${zoomed.width}×${zoomed.height}. The attached image shows ONLY this region — ` +
            `coordinates you output still map to the FULL screen, so do not reuse this region's local coordinates for clicks.`,
          modelAttachments: [
            { type: 'image', name: 'computer-zoom.png', mime: 'image/png', dataUrl: `data:image/png;base64,${buf.toString('base64')}` },
          ],
        };
      }

      // screenshot:只截屏回灌(target 可指定 all)。
      if (action === 'screenshot') {
        let shotPath = before.path;
        if (args.target === 'all') {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const allPath = jailResolve(`.mocode/screenshots/computer-${ts}-all.png`);
          await mkdir(dirname(allPath), { recursive: true });
          const cap = await captureDesktop(allPath, 'all', ctx?.signal);
          if (cap.status !== 'passed') throw new Error(`screenshot capture failed: ${cap.detail}`);
          shotPath = allPath;
        }
        const att = await toAttachment(shotPath);
        return {
          status: 'success',
          code: 'OK',
          retryable: false,
          output:
            `Screenshot captured (physical ${screen.physW}×${screen.physH}, shown at ${att.dispW}×${att.dispH}). ` +
            'Coordinates remain normalized 0-1000 over the primary screen. Visual content is attached to the next model request.',
          modelAttachments: [{ type: 'image', name: 'computer-screenshot.png', mime: 'image/png', dataUrl: att.dataUrl }],
        };
      }

      // 输入动作:注入 → 重截屏回灌(wait 也回灌,等待后界面往往已变化)。
      const summary = await executeAction(injector, action, args, screen);
      const after = await capturePrimary(ctx?.signal);
      const att = await toAttachment(after.path);
      return {
        status: 'success',
        code: 'OK',
        retryable: false,
        output:
          `${summary}. Screen re-captured (physical ${screen.physW}×${screen.physH}, shown at ${att.dispW}×${att.dispH}): ` +
          'inspect the attached screenshot to verify the result before the next action.',
        modelAttachments: [{ type: 'image', name: 'computer-result.png', mime: 'image/png', dataUrl: att.dataUrl }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx?.signal?.aborted || /aborted/i.test(message)) {
        return { status: 'aborted', code: 'ABORTED', retryable: false, output: message };
      }
      return { status: 'error', code: 'EXECUTION_ERROR', retryable: false, output: `computer action failed: ${message}` };
    }
  },
};
