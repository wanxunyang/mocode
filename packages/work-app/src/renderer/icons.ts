/**
 * 整套 UI 图标 —— 1.5px 描边、20x20 viewBox、currentColor、stroke-linecap=round。
 * 在 index.html / renderer.ts 里通过 data-icon="<name>" 占位,
 * renderer init 时调用 mountIcons() 把 SVG 字符串注入。
 * 加新图标只需在 ICONS 里加一项即可。
 */

const SVG_ATTRS = 'viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS: Record<string, string> = {
  // 导航 / sidebar
  'circle-plus': `<svg ${SVG_ATTRS}><circle cx="10" cy="10" r="6.5"/><path d="M10 7v6M7 10h6"/></svg>`,
  'git-pull-request': `<svg ${SVG_ATTRS}><circle cx="6" cy="4" r="2"/><circle cx="6" cy="16" r="2"/><circle cx="14" cy="16" r="2"/><path d="M6 6v8"/><path d="M11 6a3 3 0 0 1 3 3v4.5"/></svg>`,
  'folder': `<svg ${SVG_ATTRS}><path d="M2.5 6.8a1 1 0 0 1 1-1h4l1.5 1.5h7.5a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6.8z"/></svg>`,
  'folder-open': `<svg ${SVG_ATTRS}><path d="M2.5 6.8a1 1 0 0 1 1-1h4l1.5 1.5h7.5a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6.8z"/><path d="M2 8h16"/></svg>`,
  'plus': `<svg ${SVG_ATTRS}><path d="M10 4v12M4 10h12"/></svg>`,
  'close': `<svg ${SVG_ATTRS}><path d="M5 5l10 10M15 5L5 15"/></svg>`,

  // 顶栏
  'search': `<svg ${SVG_ATTRS}><circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/></svg>`,
  'moon': `<svg ${SVG_ATTRS}><path d="M16 11.5A6 6 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5z"/></svg>`,
  'sun': `<svg ${SVG_ATTRS}><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>`,
  // 收起 / 展开侧栏:圆角矩形 + 右侧一道竖线(代表侧栏)。
  'panel-right': `<svg ${SVG_ATTRS}><rect x="3" y="3" width="14" height="14" rx="2"/><line x1="13" y1="3" x2="13" y2="17"/></svg>`,

  // workspace actions
  'layout': `<svg ${SVG_ATTRS}><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 8h14M8 8v9"/></svg>`,
  'files': `<svg ${SVG_ATTRS}><path d="M5 3h7l3 3v11H5z"/><path d="M12 3v3h3"/></svg>`,

  // composer
  'paper-airplane': `<svg ${SVG_ATTRS}><path d="M3 17L17 4M17 4l-3.5 12.5L9 12 3 17"/></svg>`,
  'square': `<svg viewBox="0 0 20 20" fill="currentColor" stroke="none"><rect x="6" y="6" width="8" height="8" rx="1"/></svg>`,
  'mic': `<svg ${SVG_ATTRS}><rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 10a5.5 5.5 0 0 0 11 0"/><path d="M10 15.5V18"/></svg>`,
  'sparkles': `<svg ${SVG_ATTRS}><path d="M10 3l1.5 3.8L15 8.5l-3.5 1.7L10 14l-1.5-3.8L5 8.5l3.5-1.7z"/><path d="M15 13.5l.7 1.5L17 15.5l-1.3.6L15 17.5l-.7-1.4L13 15.5l1.3-.6z"/></svg>`,
  'layers-compress': `<svg ${SVG_ATTRS}><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2H3V6z" opacity=".35"/><path d="M3 9h14v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" opacity=".65"/><path d="M6 13.5h8v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1z"/><path d="M16 7l-3 3m0 0l3 3m-3-3H8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'chevron-down': `<svg ${SVG_ATTRS}><path d="M6 8l4 4 4-4"/></svg>`,
  'image': `<svg ${SVG_ATTRS}><rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="8" cy="9" r="1.5"/><path d="M3 14l4-4 4 4 3-3 3 3"/></svg>`,
  'x-circle': `<svg ${SVG_ATTRS}><circle cx="10" cy="10" r="6.5"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/></svg>`,

  // composer context
  'home': `<svg ${SVG_ATTRS}><path d="M3 9l7-5 7 5v8a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1V9z"/></svg>`,
  'branch': `<svg ${SVG_ATTRS}><circle cx="6" cy="4" r="1.5"/><circle cx="6" cy="16" r="1.5"/><circle cx="14" cy="9" r="1.5"/><path d="M6 5.5v9"/><path d="M14 10.5V8a3 3 0 0 0-3-3H7.5"/></svg>`,
  'globe': `<svg ${SVG_ATTRS}><circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5a9 9 0 0 1 0 13M10 3.5a9 9 0 0 0 0 13"/></svg>`,

  // 消息头像
  'user': `<svg ${SVG_ATTRS}><circle cx="10" cy="7" r="3"/><path d="M3.5 17a6.5 6.5 0 0 1 13 0"/></svg>`,
  'spark-bot': `<svg ${SVG_ATTRS}><rect x="4" y="7" width="12" height="9" rx="2"/><path d="M10 4v3M7.5 4h5\"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor"/><circle cx="12" cy="11.5" r="0.8" fill="currentColor"/><path d=\"M8.5 14.5h3\"/></svg>`,

  // 任务状态 / 通用
  'dot-running': `<svg viewBox="0 0 20 20" fill="currentColor" stroke="none"><circle cx="10" cy="10" r="3"/></svg>`,

  // 消息操作
  'copy': `<svg ${SVG_ATTRS}><rect x="7" y="3" width="10" height="10" rx="1.5"/><path d="M13 17H5a1.5 1.5 0 0 1-1.5-1.5V6"/></svg>`,
  'regen': `<svg ${SVG_ATTRS}><path d="M4 10a6 6 0 0 1 10-4.5L16 7"/><path d="M16 3v4h-4"/><path d="M16 10a6 6 0 0 1-10 4.5L4 13"/><path d="M4 17v-4h4"/></svg>`,
  'edit': `<svg ${SVG_ATTRS}><path d="M13 3l4 4-9 9H4v-4l9-9z"/><path d="M11 5l4 4"/></svg>`,
  'check': `<svg ${SVG_ATTRS}><path d="M4 10l4 4 8-8"/></svg>`,
  'warn': `<svg ${SVG_ATTRS}><path d="M10 3l8 14H2L10 3z"/><path d="M10 9v4M10 15.5v.5"/></svg>`,
  'info': `<svg ${SVG_ATTRS}><circle cx="10" cy="10" r="6.5"/><path d="M10 9v4M10 6.5v.5"/></svg>`,
  'fail': `<svg ${SVG_ATTRS}><circle cx="10" cy="10" r="6.5"/><path d="M7 7l6 6M13 7l-6 6"/></svg>`,

  // 空状态 idea-mark 备用装饰
  'arrow-up': `<svg ${SVG_ATTRS}><path d="M10 16V4M5 9l5-5 5 5"/></svg>`,
  'arrow-down': `<svg ${SVG_ATTRS}><path d="M10 4v12M5 11l5 5 5-5"/></svg>`,
  'panel-left': `<svg ${SVG_ATTRS}><rect x="2" y="2" width="16" height="16" rx="2"/><path d="M8 2v16"/></svg>`,
  'panel-left-close': `<svg ${SVG_ATTRS}><rect x="2" y="2" width="16" height="16" rx="2"/><path d="M8 2v16M14 8l-3 3 3 3"/></svg>`,
  'panel-left-open': `<svg ${SVG_ATTRS}><rect x="2" y="2" width="16" height="16" rx="2"/><path d="M8 2v16M12 8l3 3-3 3"/></svg>`,
  'panel-right-close': `<svg ${SVG_ATTRS}><rect x="2" y="2" width="16" height="16" rx="2"/><line x1="12" y1="2" x2="12" y2="18"/><path d="M8 7l-3 3 3 3"/></svg>`,
  'panel-right-open': `<svg ${SVG_ATTRS}><rect x="2" y="2" width="16" height="16" rx="2"/><line x1="12" y1="2" x2="12" y2="18"/><path d="M10 7l3 3-3 3"/></svg>`,
};

/**
 * 把 SVG 字符串解析成一个独立的 svg 元素。
 * 用 Range.createContextualFragment 而不是 innerHTML,
 * 因为 svg 元素设置 innerHTML 时,内嵌的 `<svg>` 标签会被当 SVG 子元素忽略(viewBox 丢失,导致残缺)。
 * 而 createContextualFragment 会正确把外层 `<svg>` 解析为新元素。
 */
function parseSvg(svgString: string): Element | null {
  const range = document.createRange();
  range.selectNodeContents(document.body);
  const frag = range.createContextualFragment(svgString);
  return frag.firstElementChild;
}

/** 把 target 替换为 name 对应的全新 svg 元素。会保留 target 自身的 class。 */
export function setIcon(target: HTMLElement, name: string): void {
  const svgString = ICONS[name];
  if (!svgString) return;
  const svg = parseSvg(svgString);
  if (!svg) return;
  // 只继承 class(其它属性 id/title 在 svg 元素上没意义,新 svg 字符串里没有 class)
  const cls = target.getAttribute('class');
  if (cls) svg.setAttribute('class', cls);
  // 一律整体替换 —— click 用事件代理,button 被销毁不影响
  target.replaceWith(svg);
}

/**
 * 把 root 里所有 [data-icon] 占位元素替换为对应 SVG。
 * 占位写法: <span data-icon="search"></span> 或 <button data-icon="plus">click</button> 或 <svg data-icon="x"></svg>
 */
export function mountIcons(root: ParentNode = document.body): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    if (el.dataset.iconMounted) return;
    const name = el.dataset.icon;
    if (!name) return;
    setIcon(el, name);
    el.dataset.iconMounted = '1';
  });
}

export function icon(name: string): string {
  return ICONS[name] ?? '';
}
