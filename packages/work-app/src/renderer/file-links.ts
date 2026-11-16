/**
 * 把正文里的文件路径变成可点击的入口（渲染层）。
 *
 * 要解决的问题很具体：agent 干完活会在回复里写「设计文档已写完：docs/xxx.md（390 行）」，
 * 那句话里的路径在 markdown 里是**纯文本**（没有 `[]()`），用户只能自己复制路径再去编辑器里打开。
 * 这里把这类文本包成 `<a class="file-link" data-file-path="...">`，由 renderer 的事件代理
 * 统一转成右侧面板的预览（见 renderer.ts 的 openFilePreview）。
 *
 * 三条设计约束：
 *  1. **只认「看起来像路径」的形态**：必须含至少一个 `/` 且以已知扩展名结尾，
 *     避免把正文里的普通单词、版本号、`main.ts` 这种裸文件名都变成链接。
 *  2. **不碰已有语义的节点**：`pre` / `code` / `a` 里的文本一律跳过 —— 代码块里点路径
 *     会打乱阅读，而链接本身已经是链接。
 *  3. **不改 markdown 渲染器**：markdown.ts 的输出是字符串，在这里做 DOM 级后处理，
 *     两边职责清晰；渲染器仍然是「纯文本 → HTML」的纯函数。
 */

/** 允许被链接化的扩展名（小写，不含点）。宁可少认，也不要认错。 */
const FILE_EXTENSIONS = new Set([
  // 文档
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc',
  // 数据 / 配置
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg', 'conf', 'properties',
  // 代码
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'm', 'mm', 'lua', 'dart', 'scala',
  // 脚本
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  // 前端
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'xml', 'svg',
  // 其它常见产物
  'sql', 'csv', 'tsv', 'log', 'patch', 'diff', 'gradle', 'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
]);

/**
 * 候选路径：可选 `./` `../` `~/` 前缀 + 至少两段（必须含 `/`）+ 已知扩展名结尾。
 *
 * 首段只允许 ASCII：中文常紧贴路径出现（「见docs/x.md」），首段放宽会把相邻的汉字吃进来；
 * 后续段允许汉字，因为真实路径里中文目录/文件名很常见（`docs/2026-11-16-资源中心方案.md`）。
 */
const PATH_CANDIDATE = /(?:\.{1,2}\/|~\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.\u4e00-\u9fff-]+)+\.[A-Za-z0-9]{1,8}/g;

/** 路径内部字符：用来判定匹配的左右边界没有被截断。 */
const WORD_CHAR = /[A-Za-z0-9_\-/\\]/;

/** 这些标签内部不链接化（代码块 / 行内代码 / 已经是链接）。 */
const SKIP_TAGS = new Set(['PRE', 'CODE', 'A', 'SCRIPT', 'STYLE']);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 匹配是不是一个可信的路径（扩展名白名单 + 不是 URL + 边界完整）。 */
function isFileLikePath(text: string, offset: number, source: string): boolean {
  if (/^[a-z]+:\/\//i.test(text)) return false;
  if (text.includes('//')) return false;
  if (!FILE_EXTENSIONS.has(extensionOf(text))) return false;
  // 左边界：前面不能还是路径字符（否则说明匹配从中间截断，例如 `x/docs/a.md` 命中 `docs/a.md`）。
  if (offset > 0 && WORD_CHAR.test(source[offset - 1]!)) return false;
  // 右边界：同理。这里**不**把 `.` 与汉字算进来 —— 句号、中文标点紧贴路径是常态，
  // 那是句子的结束，不是路径的一部分。
  const after = source[offset + text.length];
  if (after && WORD_CHAR.test(after)) return false;
  return true;
}

function makeLink(doc: Document, path: string): HTMLElement {
  const link = doc.createElement('a');
  link.className = 'file-link';
  link.href = '#';
  link.dataset.filePath = path;
  link.textContent = path;
  return link;
}

function shouldSkip(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    // 已经处理过的容器（同一次渲染里重建时不会重复，但防御性保留）。
    if (el.classList.contains('md-code')) return true;
  }
  return false;
}

/**
 * 就地把根节点下所有「像文件路径」的文本包成可点击的 `<a>`。
 * 幂等：已链接化的文本在 `<a>` 里，`shouldSkip` 会跳过。
 */
export function linkifyFilePaths(root: HTMLElement): void {
  const doc = root.ownerDocument;
  // TreeWalker 简单可靠：文本节点粒度天然能跳过标签内部，且不用手写递归。
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.includes('/')) continue;
    if (shouldSkip(text)) continue;
    targets.push(text);
  }
  for (const text of targets) replaceInTextNode(text, doc);
}

function replaceInTextNode(node: Text, doc: Document): void {
  const source = node.data;
  PATH_CANDIDATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let cursor = 0;
  const parts: Node[] = [];
  let matched = false;
  while ((match = PATH_CANDIDATE.exec(source))) {
    const path = match[0];
    if (!isFileLikePath(path, match.index, source)) continue;
    matched = true;
    if (match.index > cursor) parts.push(doc.createTextNode(source.slice(cursor, match.index)));
    parts.push(makeLink(doc, path));
    cursor = match.index + path.length;
  }
  if (!matched) return;
  if (cursor < source.length) parts.push(doc.createTextNode(source.slice(cursor)));
  node.replaceWith(...parts);
}