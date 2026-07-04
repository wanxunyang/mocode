// Mood class 切换 / 气泡淡出 / 皮肤动作覆盖 <link> 回退——纯逻辑部分,从 renderer.ts 抽出。
// 不 import 'electron',不引用真实的全局 window/document,只操作调用方传入的、符合
// "最小 DOM 元素形状"接口(ElementLike/LinkElementLike)的对象,使这部分逻辑可以脱离真实浏览器
// 环境(本项目未安装 jsdom)被单元测试覆盖——与任务 4 里 main.ts → mood-tracker.ts 的抽取方式同构。

import type { MoodKind } from '../mood.js';

/** 最小 classList 形状:够本模块 add/remove/contains 用,不要求是真实 DOMTokenList。 */
export interface ClassListLike {
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  contains(token: string): boolean;
}

/** 最小元素形状:够本模块操作 mood class / 气泡文本用,不要求是真实 HTMLElement。 */
export interface ElementLike {
  classList: ClassListLike;
  textContent: string | null;
}

/** 最小 <link> 元素形状:够本模块设置 href 用,不要求是真实 HTMLLinkElement。 */
export interface LinkElementLike {
  href: string;
}

/** 气泡文案自动淡出隐藏前的默认展示时长(design.md "情绪 → 演出的驱动"默认假设);
 *  运行期可由 MOCODE_PET_QUIP_VISIBLE_MS 环境变量(经 preload.ts → window.petBridge.quipVisibleMs)覆盖,
 *  不用重新打包就能调"宠物说一句话停多久"。 */
export const QUIP_VISIBLE_MS = 6000;

export const ALL_MOOD_CLASSES = [
  'mood-tired',
  'mood-bored',
  'mood-urging',
  'mood-frustrated',
  'mood-flustered',
] as const;

/** MoodKind → CSS class 映射表(与 state class 独立叠加,不互相替换,见 renderer.ts STATE_CLASS 同一写法风格)。 */
export const MOOD_CLASS: Record<MoodKind, string> = {
  frustrated: 'mood-frustrated',
  flustered: 'mood-flustered',
  urging: 'mood-urging',
  tired: 'mood-tired',
  bored: 'mood-bored',
};

/** 应用 mood class:mood 为 null 时移除全部 mood class(五种互斥,批量移除后按需添加一个)。 */
export function applyMood(container: ElementLike, mood: MoodKind | null): void {
  container.classList.remove(...ALL_MOOD_CLASSES);
  if (mood !== null) {
    container.classList.add(MOOD_CLASS[mood]);
  }
}

/** 设置/清空皮肤个性化动作覆盖 <link> 的 href:有 motionFile 则指向该皮肤的个性化动作覆盖 CSS,
 *  否则清空(浏览器 <link> 加载失败/空 href 本身不抛异常,天然静默回退到通用样式,见 design.md)。 */
export function applySkinMotion(link: LinkElementLike, motionFile?: string): void {
  link.href = motionFile ? `../assets/pets/${motionFile}` : '';
}

export interface BubbleController {
  /** 展示气泡文案:淡入,visibleMs 后自动淡出(只移除可见 class,不清空文本/不影响 mood class,
   *  下次新文案到达时再更新文本并重新触发淡入)。 */
  showQuip(bubbleEl: ElementLike, quip: string, visibleMs: number): void;
}

/** 定时器句柄的最小形状:不绑定 Node 的 NodeJS.Timeout 还是浏览器的 number,由注入的实现自行决定, */
export type TimerHandle = unknown;
export type SetTimeoutLike = (callback: () => void, ms: number) => TimerHandle;
export type ClearTimeoutLike = (handle: TimerHandle) => void;

const defaultSetTimeout: SetTimeoutLike = (callback, ms) => setTimeout(callback, ms);
const defaultClearTimeout: ClearTimeoutLike = (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]);

/**
 * 创建一个独立的气泡淡出控制器。用工厂函数注入 setTimeout/clearTimeout 而非依赖模块级
 * 共享的定时器句柄变量,便于测试里传入模拟定时器(不必真实等待 QUIP_VISIBLE_MS)。
 */
export function createBubbleController(
  setTimeoutFn: SetTimeoutLike = defaultSetTimeout,
  clearTimeoutFn: ClearTimeoutLike = defaultClearTimeout,
): BubbleController {
  let hideTimer: TimerHandle | null = null;

  function showQuip(bubbleEl: ElementLike, quip: string, visibleMs: number): void {
    bubbleEl.textContent = quip;
    bubbleEl.classList.add('pet-bubble-visible');
    if (hideTimer !== null) {
      clearTimeoutFn(hideTimer);
    }
    hideTimer = setTimeoutFn(() => {
      bubbleEl.classList.remove('pet-bubble-visible');
    }, visibleMs);
  }

  return { showQuip };
}
