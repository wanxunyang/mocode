/**
 * work-app 渲染层的公共测试桩：一套假 DOM，供所有面板测试复用。
 *
 * 为什么要有这个文件（而不是每个测试自带一套）：
 *
 * 面板渲染函数只依赖一小撮 DOM 入口（innerHTML / querySelectorAll / addEventListener /
 * dataset / style），所以桩可行；但这个「一小撮」有十几项，且**随面板长大而变多**。
 * 之前三份手写桩各自只填了「当时用到的字段」，于是新代码一读 `style.height`
 * （resizeCommitBox 量提交框高度），旧桩就抛 TypeError —— 而 source-control 的 catch
 * 曾把这个渲染异常渲染成「当前空间不是 Git 仓库」，真实原因只缩在 <small> 里，排查只能靠猜。
 *
 * 契约：**字段一次给全**。宁可给一些暂时没人读的字段，也不要让某个面板因为桩缺一项
 * 而挂掉。要加新字段就在 FakeElement 里加，别在测试里就地补。
 */

/** 一个假元素：button / textarea 都用它表示，字段一次给全。 */
export class FakeElement {
  readonly tagName: string;
  dataset: Record<string, string>;
  disabled = false;
  textContent = '';
  innerHTML = '';
  /** 图标切换会写 `svg.outerHTML = ...`，接住即可。 */
  outerHTML = '';
  /** textarea：提交框内容由业务代码从 DOM 读回。 */
  value = '';
  /** textarea：resizeCommitBox 会写 style.height。 */
  style: Record<string, string> = {};
  /** textarea：resizeCommitBox 读它量高度。 */
  scrollHeight = 20;
  selectionStart = 0;
  selectionEnd = 0;
  /** closest(...).classList.toggle 的每次调用。 */
  toggleCalls: Array<{ selector: string; className: string; on: boolean }> = [];
  /** setAttribute 的写入记录（如 aria-expanded）。 */
  attrs = new Map<string, string>();
  private readonly handlers: Array<() => void> = [];

  constructor(tagName: string, dataset: Record<string, string> = {}) {
    this.tagName = tagName;
    this.dataset = dataset;
  }

  addEventListener(_type: string, handler: () => void): void {
    this.handlers.push(handler);
  }

  click(): void {
    this.handlers.forEach((handler) => handler());
  }

  focus(): void {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  closest(selector: string): { classList: { toggle: (className: string, on: boolean) => void } } {
    return {
      classList: {
        toggle: (className, on) => this.toggleCalls.push({ selector, className, on }),
      },
    };
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

/** `[data-x]` / `[data-x="v"]` / `textarea[data-x]` / `button` —— 只支持面板真实用到的形态。 */
function parseSelector(selector: string): { tag: string | null; attr: string | null; value: string | null } {
  const match = /^([a-z]*)(?:\[(data-[a-z-]+)(?:="([^"]*)")?\])?$/.exec(selector.trim());
  if (!match) return { tag: null, attr: null, value: null };
  return { tag: match[1] || null, attr: match[2] || null, value: match[3] ?? null };
}

/** data-scm-toggle → scmToggle（与真实 DOMStringMap 同规则）。 */
function toDatasetKey(attr: string): string {
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_all, char: string) => char.toUpperCase());
}

/**
 * 容器桩：`innerHTML` 一写就等同真实 DOM 的整块重建 —— 旧元素与它们的监听全部作废。
 *
 * 两个易错点都在这里处理掉：
 *   1. dataset 必须来自**整个开标签**。只填 selector 指定的那一个属性时，监听器里读另一个
 *      属性（如 data-scm-commit 的 handler 读 data-scm-repo）会拿到空串，表现为「点了没反应」。
 *   2. 布尔属性（`<button data-history-more>`）要当空串，否则「加载更多」这类按钮根本查不到。
 */
export class FakeContainer {
  scrollTop = 0;
  private html_ = '';
  private readonly cache = new Map<string, FakeElement>();

  get innerHTML(): string {
    return this.html_;
  }

  set innerHTML(value: string) {
    this.html_ = value;
    // 真实 DOM 里整块重建后旧节点与其监听都不在了，缓存必须一起清。
    this.cache.clear();
  }

  querySelectorAll(selector: string): FakeElement[] {
    const { tag, attr, value } = parseSelector(selector);
    if (!tag && !attr) return [];
    if (tag && !attr) {
      // 只要标签名（如 'button'：提交时统一禁用）：每次重建都是新元素，不进缓存。
      const tags = [...this.html_.matchAll(/<(button|textarea)\b/gi)].map((match) => match[1].toLowerCase());
      return tags.filter((name) => name === tag).map((name) => new FakeElement(name));
    }
    const found: FakeElement[] = [];
    for (const open of this.html_.matchAll(/<(button|textarea)\b([^>]*)>/gi)) {
      const elementTag = open[1].toLowerCase();
      if (tag && elementTag !== tag) continue;
      const attrs = new Map<string, string>();
      // 布尔属性也要收：`data-history-more` → ''。
      for (const item of open[2].matchAll(/(data-[a-z-]+)(?:="([^"]*)")?/g)) attrs.set(item[1], item[2] ?? '');
      const attrValue = attr ? attrs.get(attr) : undefined;
      if (attrValue === undefined) continue;
      if (value !== null && attrValue !== value) continue;
      const key = `${attr}|${attrValue}`;
      const cached = this.cache.get(key);
      if (cached) {
        found.push(cached);
        continue;
      }
      const dataset: Record<string, string> = {};
      for (const [name, val] of attrs) dataset[toDatasetKey(name)] = val;
      const created = new FakeElement(elementTag, dataset);
      this.cache.set(key, created);
      found.push(created);
    }
    return found;
  }

  /** 与 querySelectorAll 共用缓存：先渲染再取到的元素，就是监听器挂着的那个。 */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(_node: unknown): boolean {
    return false;
  }

  /** 点当前视图里的某个按钮：按 (选择器, 属性值) 定位；缓存未命中就先扫一遍。 */
  click(selector: string, value = ''): void {
    const { attr } = parseSelector(selector);
    if (!attr) throw new Error(`click 需要属性选择器：${selector}`);
    this.querySelectorAll(selector);
    const target = this.cache.get(`${attr}|${value}`);
    if (!target) throw new Error(`按钮不存在：${selector} ${value}`);
    target.click();
  }

  /** 等两轮宏任务：面板的点击处理是 `void` 出去的 async。 */
  async settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface GlobalStub {
  /** localStorage 的内容，断言「偏好是否持久化」用。 */
  storage: Map<string, string>;
  /** 已注册且未清理的定时器 —— 断言轮询是否泄漏用。 */
  timers: Set<unknown>;
  /** 被吞掉的 console.error 参数（paintSafely 会刻意打日志）。 */
  errors: unknown[][];
  restore: () => void;
}

/**
 * 装上渲染层需要的浏览器全局，并**接管定时器**。
 *
 * 为什么要接管 setInterval：`refreshSourceControl` 会起一个 5 秒轮询。测试忘了调
 * `closeSourceControl()` 时，进程会被这个 ref 定时器吊住不退出 —— 表现是
 * `node --test` 跑完不返回、被外层按超时杀掉。接管后定时器不真跑，restore 时一并清掉，
 * 测试与进程生命周期解耦。
 */
export function installGlobals(): GlobalStub {
  const g = globalThis as unknown as Record<string, unknown>;
  const before = {
    localStorage: g.localStorage,
    document: g.document,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
    CSS: g.CSS,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    console: g.console,
  };
  const storage = new Map<string, string>();
  const timers = new Set<unknown>();
  const errors: unknown[][] = [];
  g.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  g.HTMLTextAreaElement = class {};
  g.document = { activeElement: null, hidden: false };
  g.CSS = { escape: (value: string) => value };
  // 定时器只登记、不触发：面板测试关心「重绘后状态对不对」，不关心时钟。
  g.setInterval = (handler: () => void, ms: number) => {
    const id = { handler, ms };
    timers.add(id);
    return id;
  };
  g.clearInterval = (id: unknown) => {
    timers.delete(id);
  };
  // 渲染失败时 console.error 是故意的（见 paintSafely）：收起来别污染输出。
  g.console = { ...console, error: (...args: unknown[]) => errors.push(args) };

  return {
    storage,
    timers,
    errors,
    restore: () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete g[key];
        else g[key] = value;
      }
    },
  };
}
