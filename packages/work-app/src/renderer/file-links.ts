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

/** 链接目标的两种语义：可读的文本/代码走右侧预览，产物走系统文件管理器定位。 */
export type FileLinkKind = 'file' | 'artifact';

/**
 * **产物类**扩展名：不看内容，点了就在文件管理器里定位。
 *
 * 为什么要单独一类：agent 跑完构建后会说「安装包：packages/work-app/release/MoCode Work-1.1.0-setup.exe」，
 * 而用户真正想做的是去那个目录拿文件，不是在面板里读一个 148MB 的二进制。
 * 这类文件只在「带出产物」时出现，所以宁可把列表列全，也别让用户再自己逐层点目录。
 */
const ARTIFACT_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'appx', 'dmg', 'pkg', 'appimage', 'deb', 'rpm', 'snap',
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'xz', 'bz2', 'zst', 'iso',
  'apk', 'ipa', 'aab', 'jar', 'war',
  'asar', 'blockmap', 'dll', 'so', 'dylib', 'node', 'wasm',
]);

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

/**
 * 产物路径的候选形态：末段**允许含空格**（`MoCode Work-1.1.0-setup.exe`、`Setup 1.1.0.exe`）。
 *
 * 普通路径不允许空格是有意的（「见 docs/a.md 或 b.txt」会把中间那句汉语吃进来），
 * 但安装包 / 产物名带版本号与空格是常态，所以放宽只发生在末段、且由扩展名白名单兜住
 * —— 匹配到 `src/a.ts` 这种普通文件也会被 kindOfPath 判成 file，走原来的预览通道。
 */
const ARTIFACT_CANDIDATE = /(?:\.{1,2}\/|~\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.\u4e00-\u9fff-]+)*\/[A-Za-z0-9_.\u4e00-\u9fff-]+(?: [A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8}/g;

/** 路径内部字符：用来判定匹配的左右边界没有被截断。 */
const WORD_CHAR = /[A-Za-z0-9_\-/\\]/;

/** 这些标签内部不链接化（代码块 / 行内代码 / 已经是链接）。 */
const SKIP_TAGS = new Set(['PRE', 'CODE', 'A', 'SCRIPT', 'STYLE']);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 扩展名 → 链接语义；不认识的扩展名返回 null（不链接化）。 */
export function kindOfPath(path: string): FileLinkKind | null {
  const ext = extensionOf(path);
  if (ARTIFACT_EXTENSIONS.has(ext)) return 'artifact';
  if (FILE_EXTENSIONS.has(ext)) return 'file';
  return null;
}

/** 这条路径是不是产物（工具行用它决定要不要标成「去文件夹拿」）。 */
export function isArtifactPath(path: string): boolean {
  return kindOfPath(path) === 'artifact';
}

/** 匹配是不是一个可信的路径（扩展名白名单 + 不是 URL + 边界完整）。 */
function isFileLikePath(text: string, offset: number, source: string): boolean {
  if (/^[a-z]+:\/\//i.test(text)) return false;
  if (text.includes('//')) return false;
  if (!kindOfPath(text)) return false;
  // 左边界：前面不能还是路径字符（否则说明匹配从中间截断，例如 `x/docs/a.md` 命中 `docs/a.md`）。
  if (offset > 0 && WORD_CHAR.test(source[offset - 1]!)) return false;
  // 右边界：同理。这里**不**把 `.` 与汉字算进来 —— 句号、中文标点紧贴路径是常态，
  // 那是句子的结束，不是路径的一部分。
  const after = source[offset + text.length];
  if (after && WORD_CHAR.test(after)) return false;
  return true;
}

function makeLink(doc: Document, path: string, kind: FileLinkKind): HTMLElement {
  const link = doc.createElement('a');
  link.className = kind === 'artifact' ? 'file-link file-link-artifact' : 'file-link';
  link.href = '#';
  link.dataset.filePath = path;
  // 点击分流由 renderer 的事件代理读这里：artifact 去文件管理器定位，file 进面板预览。
  link.dataset.fileKind = kind;
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

/** 一段文本里所有可信的文件路径（按出现顺序、互不重叠）。纯函数，便于在 node 里断言。 */
export interface FilePathHit {
  path: string;
  index: number;
  kind: FileLinkKind;
}

export function findFilePaths(text: string): FilePathHit[] {
  const raw: Array<{ path: string; index: number; kind: FileLinkKind }> = [];
  // 两条候选形态都要跑：带空格的分段只有产物才合法，但产物也可能不带空格。
  for (const pattern of [ARTIFACT_CANDIDATE, PATH_CANDIDATE]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const kind = kindOfPath(match[0]);
      if (!kind) continue;
      if (!isFileLikePath(match[0], match.index, text)) continue;
      raw.push({ path: match[0], index: match.index, kind });
    }
  }
  // 同一位置可能来自两条形态（无空格产物两条都命中）：留更长的那个，短的是截断匹配。
  raw.sort((left, right) => left.index - right.index || right.path.length - left.path.length);
  const hits: FilePathHit[] = [];
  let consumed = 0;
  for (const hit of raw) {
    if (hit.index < consumed) continue;
    hits.push(hit);
    consumed = hit.index + hit.path.length;
  }
  return hits;
}

function replaceInTextNode(node: Text, doc: Document): void {
  const source = node.data;
  const hits = findFilePaths(source);
  if (!hits.length) return;
  const parts: Node[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.index > cursor) parts.push(doc.createTextNode(source.slice(cursor, hit.index)));
    parts.push(makeLink(doc, hit.path, hit.kind));
    cursor = hit.index + hit.path.length;
  }
  if (cursor < source.length) parts.push(doc.createTextNode(source.slice(cursor)));
  node.replaceWith(...parts);
}