// dom-mood.ts 的单元测试(tasks.md 6.1):mood class 切换、气泡淡出、皮肤动作覆盖 <link> 回退。
// 不依赖 jsdom——用手写的最小 stub 对象(ElementLike/LinkElementLike 形状)覆盖场景,
// 气泡淡出场景额外用手写假定时器替代真实 setTimeout/clearTimeout,避免测试真实等待 3000ms。
//
// 运行:npx tsx packages/pet-app/src/renderer/dom-mood.test.ts

import {
  applyMood,
  applySkinMotion,
  createBubbleController,
  ALL_MOOD_CLASSES,
  type ElementLike,
  type LinkElementLike,
} from './dom-mood.js';

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

/** 基于 Set<string> 实现的最小 classList stub,不依赖 jsdom/真实 DOMTokenList。 */
function createStubElement(): ElementLike {
  const classes = new Set<string>();
  return {
    classList: {
      add(...tokens: string[]): void {
        for (const t of tokens) classes.add(t);
      },
      remove(...tokens: string[]): void {
        for (const t of tokens) classes.delete(t);
      },
      contains(token: string): boolean {
        return classes.has(token);
      },
    },
    textContent: null,
  };
}

// ── 场景A:mood class 切换,始终只有一个 ──────────────────────────────────
{
  const el = createStubElement();

  const assertOnlyMoodClass = (activeClass: string | null, label: string): void => {
    for (const cls of ALL_MOOD_CLASSES) {
      const shouldContain = cls === activeClass;
      assert(
        el.classList.contains(cls) === shouldContain,
        `${label}:class ${cls} ${shouldContain ? '应存在' : '应不存在'}`,
      );
    }
  };

  applyMood(el, 'tired');
  assertOnlyMoodClass('mood-tired', "applyMood(el, 'tired') 后");

  applyMood(el, 'frustrated');
  assertOnlyMoodClass('mood-frustrated', "applyMood(el, 'frustrated') 后(上一个 mood class 应已被移除)");

  applyMood(el, 'bored');
  assertOnlyMoodClass('mood-bored', "applyMood(el, 'bored') 后");

  applyMood(el, null);
  assertOnlyMoodClass(null, 'applyMood(el, null) 后(全部 mood class 应被移除)');
}

// ── 场景B:气泡文案自动淡出,不影响 mood class ────────────────────────────
{
  // 手写假定时器:自己维护一个回调队列,fakeSetTimeout 记录 {fn, ms} 并返回自增 id,
  // fakeClearTimeout 从队列里移除;flush() 手动触发所有待执行回调,不必真实等待。
  interface QueuedTimer {
    id: number;
    fn: () => void;
    ms: number;
  }
  let nextId = 1;
  let queue: QueuedTimer[] = [];
  let clearCallCount = 0;

  const fakeSetTimeout = (fn: () => void, ms: number): number => {
    const id = nextId++;
    queue.push({ id, fn, ms });
    return id;
  };
  const fakeClearTimeout = (handle: unknown): void => {
    clearCallCount++;
    queue = queue.filter((t) => t.id !== handle);
  };
  const flush = (): void => {
    const toRun = queue;
    queue = [];
    for (const t of toRun) t.fn();
  };

  const bubbleController = createBubbleController(fakeSetTimeout, fakeClearTimeout);

  const bubbleEl = createStubElement();
  const stageEl = createStubElement();

  applyMood(stageEl, 'tired');

  bubbleController.showQuip(bubbleEl, '测试文案', 3000);
  assert(bubbleEl.textContent === '测试文案', 'showQuip 后 bubbleEl.textContent 应为传入的文案');
  assert(
    bubbleEl.classList.contains('pet-bubble-visible') === true,
    'showQuip 后 bubbleEl 应带有 pet-bubble-visible class(淡入)',
  );

  flush();
  assert(
    bubbleEl.classList.contains('pet-bubble-visible') === false,
    'flush 假定时器后 bubbleEl 应移除 pet-bubble-visible class(淡出)',
  );
  assert(
    bubbleEl.textContent === '测试文案',
    'flush 假定时器后 bubbleEl.textContent 仍保留原文案(淡出不清空文本)',
  );

  assert(
    stageEl.classList.contains('mood-tired') === true,
    '气泡淡出不影响舞台元素的 mood class(两者互不干扰)',
  );

  // 额外验证:连续调用两次 showQuip,第一次的定时器应被 clearTimeoutFn 正确清除。
  bubbleController.showQuip(bubbleEl, '第一条', 3000);
  const clearCountBefore = clearCallCount;
  const queueLenAfterFirst = queue.length;
  bubbleController.showQuip(bubbleEl, '第二条', 3000);
  assert(
    clearCallCount === clearCountBefore + 1,
    '第二次 showQuip 调用应触发一次 clearTimeoutFn(清除第一次的定时器)',
  );
  assert(
    queue.length === queueLenAfterFirst,
    '第二次 showQuip 后队列里第一次的定时器已被移除,队列长度不因残留旧定时器而增长',
  );
  assert(bubbleEl.textContent === '第二条', '第二次 showQuip 后文案应更新为最新一次的内容');
}

// ── 场景C:皮肤动作覆盖 link 回退 ─────────────────────────────────────────
{
  const link: LinkElementLike = { href: '' };

  applySkinMotion(link, '01-robo-cat.motion.css');
  assert(
    link.href === '../assets/pets/01-robo-cat.motion.css',
    "applySkinMotion(link, '01-robo-cat.motion.css') 应设置对应路径的 href",
  );

  applySkinMotion(link, undefined);
  assert(link.href === '', 'applySkinMotion(link, undefined) 应清空 href(回退通用样式)');

  applySkinMotion(link, '02-robo-dog.motion.css');
  applySkinMotion(link);
  assert(link.href === '', '再次设置后不传第二参数调用 applySkinMotion(link),最终 href 应被清空');
}

console.log(`\nOK: ${passed} passed, 0 failed`);
