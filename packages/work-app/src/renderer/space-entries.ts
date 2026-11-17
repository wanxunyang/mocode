/**
 * 侧栏「空间」下展示哪些行（纯函数，无 DOM）。
 *
 * 为什么需要它：一个空间里有两套完全不同的东西 ——
 *   · work-app 任务（本应用里建的，有状态、可重命名/删除）；
 *   · 终端 mocode 在该目录留下的历史会话（只读，点一下「接管」才变成任务）。
 * 它们共同构成「这个空间里我聊过什么」，所以按时间混排在一起才符合直觉 ——
 * 内联区如此，「更多」展开区也如此：一个入口、一份列表，不再把
 * 「还有 N 个任务」与「历史会话」拆成两个折叠块。
 *
 * 这里只做一件事：给定任务与会话，算出「内联哪几条、多出来的按什么顺序铺开」。
 */

/** 一个空间默认内联展示几行（任务 + 会话合计）。 */
export const SPACE_INLINE_LIMIT = 6;

export interface SpaceTaskInput {
  id: string;
  /** ISO 时间串；侧栏的排序键（最近用户消息，不是运行状态）。 */
  updatedAt: string;
  /** 任务状态：running / waiting 的排在所有其它条目之前（见 compareEntries）。 */
  status?: string;
  /** 已绑定终端会话 id 的任务 —— 那条会话已经在列表里以任务身份出现。 */
  sessionId?: string;
}

/** 正在跑或正在等人的任务：只有它们才有资格压过时间顺序站到最前面。 */
export function isActiveTaskStatus(status?: string): boolean {
  return status === 'running' || status === 'waiting';
}

export interface SpaceSessionInput {
  id: string;
  /** 会话创建时间（什么时候开始聊）。 */
  createdAt: string;
  /** 最后一次被写过的时间（`session.json` 的 mtime）；排序与展示都优先用它。 */
  lastActiveAt?: string;
}

export type SpaceEntry =
  | { kind: 'task'; id: string; at: string; active: boolean }
  | { kind: 'session'; id: string; at: string; active: boolean };

export interface SpaceSplit {
  /** 内联展示的条目，活动任务最前、其余时间倒序，最多 limit 条。 */
  inline: SpaceEntry[];
  /**
   * 没进内联的条目，顺序与内联区同源。
   *
   * 注意 overflow 里的会话只来自调用方传进来的那份快照（侧栏缓存的每空间最近 20 条）——
   * 展开「更多」时渲染层会现取全量磁盘列表并用 `mergeSpaceEntries` 重算一次顺序，
   * 所以这里的 overflow 只用于「还有 N 个」那个数字与首屏兜底。
   */
  overflow: SpaceEntry[];
}

/**
 * 会话的排序/展示时刻：优先用最后活动时间。
 *
 * 只看 createdAt 会让一条三个月前建的、昨天还聊过的会话在混排里排到最后 —— 那是错的。
 */
export function entryTimeOf(entry: { createdAt?: string; lastActiveAt?: string }): string {
  return entry.lastActiveAt || entry.createdAt || '';
}

/**
 * 运行中（running / waiting）的条目排最前，其余按时间倒序；
 * 同一时刻任务优先（任务更"用户刚动过"），再按 id 保证稳定。
 *
 * 「置顶」只留给真在跑的：用户点开一条历史会话只想看一眼，那不该把它顶到
 * 正在跑的任务上面（接管时也不刷新排序键，见 main.ts 的 adopt-session）。
 */
function compareEntries(left: SpaceEntry, right: SpaceEntry): number {
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  if (left.kind !== right.kind) return left.kind === 'task' ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 把任务与会话混成一份有序列表。
 *
 * 调用方负责先剔除「该以任务身份出现」的会话（已接管），这里不做过滤 ——
 * 内联区与展开区的过滤口径不同，混在一起会漂移。
 */
export function mergeSpaceEntries(
  tasks: ReadonlyArray<SpaceTaskInput>,
  sessions: ReadonlyArray<SpaceSessionInput>,
): SpaceEntry[] {
  return [
    ...tasks.map((task): SpaceEntry => ({
      kind: 'task', id: task.id, at: task.updatedAt, active: isActiveTaskStatus(task.status),
    })),
    ...sessions.map((session): SpaceEntry => ({
      kind: 'session', id: session.id, at: entryTimeOf(session), active: false,
    })),
  ].sort(compareEntries);
}

export function splitSpaceEntries(
  tasks: ReadonlyArray<SpaceTaskInput>,
  sessions: ReadonlyArray<SpaceSessionInput>,
  limit = SPACE_INLINE_LIMIT,
): SpaceSplit {
  // 已接管的会话以任务身份出现，不能再作为会话重复列一遍。
  const adopted = new Set<string>();
  for (const task of tasks) {
    if (task.sessionId) adopted.add(task.sessionId);
  }

  const candidates = mergeSpaceEntries(tasks, sessions.filter((session) => !adopted.has(session.id)));
  const inline = limit > 0 ? candidates.slice(0, limit) : [];
  return { inline, overflow: limit > 0 ? candidates.slice(limit) : candidates };
}