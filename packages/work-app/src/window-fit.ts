/**
 * 窗口尺寸 / 位置收进显示器工作区的纯计算（主进程侧，不碰 Electron）。
 *
 * 背景：Windows 跨显示器拖动时**保留窗口原尺寸**。把高 1067px 的窗口拖到工作区只有
 * 960px 的屏上，窗口就比自己所在的屏还高；而输入卡按设计贴在窗口底边
 * （.workspace 是 flex column，.composer-area 是最后一项），整块输入框于是被推出屏幕外，
 * 用户看到的就是「看不到输入框」——而且窗沿已经顶到屏幕顶，拖也救不回来。
 * 渲染层无从修：它只是忠实地按窗口尺寸排版。
 *
 * 抽成纯函数是为了能直接单测边界（双屏坐标可以是负数、窗口比屏还大、已经在框内）。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浮点坐标（HiDPI 换算后）收敛到整数像素：setBounds 传小数在 Windows 上会被舍入成怪值。 */
function toInt(value: number): number {
  return Math.round(value);
}

/**
 * 算出「完全落在工作区内」的 bounds。
 *
 * - 尺寸只在**超出**工作区时收缩，绝不放大：用户的尺寸偏好必须保住，窗口小于屏不是问题。
 * - 位置只在**越界**时平移，仍然放不下的部分靠收缩解决。
 * - 已经合规时返回 null —— 调用方据此避免无意义的 setBounds（每次 setBounds 都会触发
 *   resize 事件，跟用户的拖拽互相打架，也会在非 100% DPI 下累积舍入误差）。
 */
export function clampToWorkArea(bounds: Rect, area: Rect): Rect | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, area.x, area.y, area.width, area.height].every(Number.isFinite)) return null;
  if (area.width <= 0 || area.height <= 0) return null;

  const width = Math.min(toInt(bounds.width), area.width);
  const height = Math.min(toInt(bounds.height), area.height);
  const x = Math.min(Math.max(toInt(bounds.x), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(toInt(bounds.y), area.y), area.y + area.height - height);

  const unchanged = width === toInt(bounds.width) && height === toInt(bounds.height)
    && x === toInt(bounds.x) && y === toInt(bounds.y);
  return unchanged ? null : { x, y, width, height };
}