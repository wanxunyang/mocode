/**
 * 侧栏「空间」下内联展示哪些行（纯函数，无 DOM）。
 *
 * 为什么需要它：一个空间里有两套完全不同的东西 ——
 *   · work-app 任务（本应用里建的，有状态、可重命名/删除）；
 *   · 终端 mocode 在该目录留下的历史会话（只读，点一下「接管」才变成任务）。
 * 它们共同构成「这个空间里我聊过什么」，所以按时间排在一起才符合直觉；但任务另有
 * 「超过 N 条折叠」的老规则，会话另有「全部收在历史会话里」的老规则。两条规则各写一遍
 * 必然出现同一会话在侧栏和历史里各出现一次。
 *
 * 这里只做一件事：给定任务与会话，算出「内联哪几条、剩下的分别归谁」。
 * 渲染层按结果画，历史会话列表按 hiddenSessionIds 画 —— 两处口径同源。
 */

/** 一个空间默认内联展示几行（任务 + 会话合计）。 */
export const SPACE_INLINE_LIMIT = 6;

export interface SpaceTaskInput {
  id: string;
  /** ISO 时间串；侧栏的排序键（最近用户消息，不是运行状态）。 */
  updatedAt: string;
  /** 已绑定终端会话 id 的任务 —— 那条会话已经在列表里以任务身份出现。 */
  sessionId?: string;
}

export interface SpaceSessionInput {
  id: string;
  /** ISO 时间串；终端会话只有创建时间。 */
  createdAt: string;
}

export type SpaceEntry =
  | { kind: 'task'; id: string; at: string }
  | { kind: 'session'; id: string; at: string };

export interface SpaceSplit {
  /** 内联展示的条目，时间倒序，最多 limit 条。 */
  inline: SpaceEntry[];
  /** 没进内联的任务 id（保持传入顺序，供「还有 N 个任务」展开区使用）。 */
  hiddenTaskIds: string[];
  /**
   * 没进内联、也没被接管成任务的会话 id（时间倒序）。
   * 历史会话列表按这个口径渲染，避免与内联区重复。
   */
  hiddenSessionIds: string[];
}

/** 时间倒序；同一时刻任务优先（任务更"用户刚动过"），再按 id 保证稳定。 */
function compareEntries(left: SpaceEntry, right: SpaceEntry): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  if (left.kind !== right.kind) return left.kind === 'task' ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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

  const candidates: SpaceEntry[] = [
    ...tasks.map((task): SpaceEntry => ({ kind: 'task', id: task.id, at: task.updatedAt })),
    ...sessions
      .filter((session) => !adopted.has(session.id))
      .map((session): SpaceEntry => ({ kind: 'session', id: session.id, at: session.createdAt })),
  ].sort(compareEntries);

  const inline = limit > 0 ? candidates.slice(0, limit) : [];
  const inlineTaskIds = new Set(inline.filter((entry) => entry.kind === 'task').map((entry) => entry.id));
  const inlineSessionIds = new Set(inline.filter((entry) => entry.kind === 'session').map((entry) => entry.id));

  return {
    inline,
    // 「还有 N 个任务」展开区沿用任务自己的先后顺序，不按合并后的时间序重排。
    hiddenTaskIds: tasks.filter((task) => !inlineTaskIds.has(task.id)).map((task) => task.id),
    hiddenSessionIds: candidates
      .filter((entry) => entry.kind === 'session' && !inlineSessionIds.has(entry.id))
      .map((entry) => entry.id),
  };
}