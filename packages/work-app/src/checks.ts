/**
 * 「检查」面板的脚本发现逻辑（纯函数，不碰 fs / i18n）。
 *
 * 为什么要从 package.json 发现而不是硬编码四条命令：同一个工作空间可能是 npm / pnpm / yarn
 * 项目，脚本名也各不相同（`typecheck` vs `type-check` vs `tsc`）。写死一份清单必然会给出
 * 一条这个项目根本不存在的命令，用户点下去只得到 `Missing script`。
 *
 * 事实源只有磁盘上的 package.json：面板列出真实存在的脚本，点击后把 `pm run <name>`
 * 填进终端由用户回车执行（执行通道就是已有 PTY，不新开一条）。
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface CheckScript {
  name: string;
  command: string;
}

export interface CheckGroup {
  /** 展示名：根组用 package.json 的 name，子包用相对目录。 */
  label: string;
  /** 相对工作空间根的目录；根组为空串。 */
  dir: string;
  packageManager: PackageManager;
  scripts: CheckScript[];
}

/**
 * 校验类脚本的排序权重：**只影响顺序，不影响是否展示**。
 * 用户的日常顺序就是 typecheck → lint → build → test，面板按这个排，
 * 常用命令就不会被 `prepare` / `postinstall` 这类噪声压在下面。
 * 用前缀正则匹配：`test:unit`、`lint:fix`、`build:electron` 都是同类。
 */
const PRIORITY: ReadonlyArray<readonly [RegExp, number]> = [
  [/^typecheck$/, 0],
  [/^type-check$/, 1],
  [/^tsc$/, 2],
  [/^lint$/, 3],
  [/^lint:/, 4],
  [/^format:check$/, 5],
  [/^build$/, 6],
  [/^build:/, 7],
  [/^test$/, 8],
  [/^test:/, 9],
  [/^(check|verify)/, 10],
];

/** 命中优先级表返回权重，否则统一 100（字母序排在后面）。 */
export function scriptPriority(name: string): number {
  for (const [pattern, rank] of PRIORITY) if (pattern.test(name)) return rank;
  return 100;
}

/**
 * 这个脚本算不算「检查」。
 *
 * 面板只列这一类：`dev` / `start` / `prepare` / `postinstall` 对「我刚让 agent 改完代码，
 * 现在该验什么」这个问题没有回答，列出来只是噪声。反过来，只要命中优先级表的
 * 任一条就算 —— `build:electron`、`test:unit`、`lint:fix` 都必须留下。
 */
export function isCheckScript(name: string): boolean {
  return scriptPriority(name) < 100;
}

export function orderScripts(scripts: readonly CheckScript[]): CheckScript[] {
  return [...scripts].sort((left, right) => scriptPriority(left.name) - scriptPriority(right.name) || left.name.localeCompare(right.name));
}

/**
 * 填进终端的整行命令。
 * 四种包管理器都接受 `<pm> run <name>`（npm 的 `npm test` 简写是特例，但 `npm run test`
 * 等价），所以不按 pm 分叉 —— 少一条分支就少一种「切换包管理器后按钮失效」。
 *
 * 子包用 `cd <dir> && …` 而不是 `--prefix` / `--filter`：那两个 flag 各家实现不同
 * （npm 有 --prefix、pnpm 只有 --filter、yarn 两者都没有），而 `cd x && y` 在 cmd 与
 * bash 里都成立 —— 终端实际就是这两种 shell（见 terminal-host.ts 的 shellSpec）。
 */
export function checkCommand(packageManager: PackageManager, name: string, dir = ''): string {
  const command = `${packageManager} run ${name}`;
  return dir ? `cd ${dir} && ${command}` : command;
}

/**
 * 判断项目用哪个包管理器：`packageManager` 字段最权威，其次锁文件。
 * 都没有就按 npm —— 它是唯一不需要额外安装的兜底。
 */
export function packageManagerFor(input: { packageManager?: unknown; lockfiles: readonly string[] }): PackageManager {
  const declared = typeof input.packageManager === 'string' ? input.packageManager.split('@')[0]?.trim().toLowerCase() : '';
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared;
  const lockfiles = new Set(input.lockfiles);
  if (lockfiles.has('pnpm-lock.yaml')) return 'pnpm';
  // yarn 与 bun 都可能有 yarn.lock；bun 专属锁文件优先，否则会把 bun 项目判成 yarn。
  if (lockfiles.has('bun.lockb') || lockfiles.has('bun.lock')) return 'bun';
  if (lockfiles.has('yarn.lock')) return 'yarn';
  return 'npm';
}

export interface ParsedPackage {
  name: string;
  scripts: CheckScript[];
  /** package.json 里声明的 workspace 目录模式（未展开）。 */
  workspaces: string[];
  /** `packageManager` 字段原文（如 `pnpm@9.1.0`），用于判定包管理器；缺省为空串。 */
  packageManager: string;
}

/**
 * 解析一份 package.json 文本。
 * 坏 JSON / 不是对象 / 没有 scripts 都返回 null —— 调用方据此把该包整组跳过，
 * 而不是渲染一组空行。
 */
export function parsePackage(text: string | null): ParsedPackage | null {
  if (!text) return null;
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scripts: CheckScript[] = [];
  const rawScripts = record.scripts;
  if (rawScripts && typeof rawScripts === 'object' && !Array.isArray(rawScripts)) {
    for (const [name, command] of Object.entries(rawScripts as Record<string, unknown>)) {
      // 两道过滤：空命令对用户没有意义（`"foo": ""` 是常见占位），
      // 非校验类脚本（dev/start/prepare）不属于这个面板要回答的问题。
      if (typeof command === 'string' && command.trim() && isCheckScript(name)) scripts.push({ name, command: command.trim() });
    }
  }
  const rawWorkspaces = record.workspaces;
  const workspaces = Array.isArray(rawWorkspaces)
    ? rawWorkspaces.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return {
    name: typeof record.name === 'string' ? record.name : '',
    scripts: orderScripts(scripts),
    workspaces,
    packageManager: typeof record.packageManager === 'string' ? record.packageManager : '',
  };
}

/**
 * 把 workspace 模式展开成候选目录名。
 * 只支持两种形态：字面目录（`apps/web`）和单层通配（`packages/*`）。
 * 不实现完整 glob —— 面板只是列脚本，静默漏掉两层的通配比引入一个 glob 依赖划算。
 */
export function workspaceDirs(patterns: readonly string[]): { literal: string[]; globs: string[] } {
  const literal: string[] = [];
  const globs: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!pattern) continue;
    if (!pattern.includes('*')) { literal.push(pattern); continue; }
    // 只接受 `prefix/*` 这种「最后一段是 *」的形态。
    const segments = pattern.split('/');
    if (segments[segments.length - 1] !== '*') continue;
    const prefix = segments.slice(0, -1).join('/');
    if (prefix && !prefix.includes('*')) globs.push(prefix);
  }
  return { literal, globs };
}

/**
 * 由「已读到的 package.json 文本」组装分组。**纯函数**：文件读取在 main.ts，
 * 这样分组规则（跳过无校验脚本的包、根组命名、包管理器继承）能直接测。
 *
 * `entries` 的顺序就是展示顺序：调用方先放根、再按子包名排好。
 * 根组的 `packageManager` 是权威值，子包继承 —— 一个 monorepo 里不会混用两种 pm。
 */
export function buildCheckGroups(
  entries: ReadonlyArray<{ dir: string; text: string | null; lockfiles?: readonly string[] }>,
): { packageManager: PackageManager; groups: CheckGroup[] } {
  const parsed = entries.map((entry) => ({ dir: entry.dir, pkg: parsePackage(entry.text), lockfiles: entry.lockfiles ?? [] }));
  const rootEntry = parsed.find((entry) => entry.dir === '');
  const packageManager = packageManagerFor({
    packageManager: rootEntry?.pkg?.packageManager ?? '',
    lockfiles: rootEntry?.lockfiles ?? [],
  });
  const groups: CheckGroup[] = [];
  for (const entry of parsed) {
    if (!entry.pkg || entry.pkg.scripts.length === 0) continue;
    // 根组用 package.json 的 name；没有 name 的根（少见，但 monorepo 根常省略）用「.」占位。
    const label = entry.dir === '' ? entry.pkg.name || '' : entry.dir;
    groups.push({ label, dir: entry.dir, packageManager, scripts: entry.pkg.scripts });
  }
  return { packageManager, groups };
}