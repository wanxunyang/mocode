/**
 * 「空草稿任务」的判定（纯函数，无 fs / 无 electron）。
 *
 * 背景：侧栏每个空间下的「+」会立刻建一条任务记录（`work:create-task`），并为一个
 * host 子进程预热。用户点开看了一眼、又切去别的会话时，这条记录没有任何对话内容，
 * 却会一直挂在空间下面显示成「新任务」—— 看着像自己聊过什么，实际点开是空的。
 *
 * 判据三条，缺一不可：
 *   · `status === 'queued'` —— 一次 run 都没跑过；
 *   · 空的 `sessionId` —— host 从没为此任务写过会话（`run_started` 才会带上）；
 *   · `updatedAt <= createdAt` —— 没有任何事件碰过它。
 *
 * 第三条是安全闸，不是冗余：渲染层点发送时**先**发 `user_message`（只把 updatedAt 推成
 * now，状态仍是 queued），**后**发 `run`（才改成 running）。两条 IPC 之间若有别的动作
 * 正好触发清理，只靠前两条会把一条「指令已提交、还没开跑」的任务当草稿删掉 —— 那条
 * 指令就丢了。加了第三条，消息一提交就不再是草稿。
 *
 * 不用 title 判定：真实对话的第一条消息发出时会先自动命名（rename）再发 run，
 * 中间那个窗口里 title 已非空但还没开跑 —— 那种任务同样该被当作空草稿收走。
 */

export interface DraftCandidate {
  id: string;
  status: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 这条任务是不是「点了 + 但一句话都没发」的空壳。 */
export function isEmptyDraft(task: DraftCandidate): boolean {
  if (task.status !== 'queued' || task.sessionId) return false;
  const created = Date.parse(task.createdAt);
  const updated = Date.parse(task.updatedAt);
  // 时间戳读不出来（老数据 / 测试夹具缺字段）时不敢删：没有证据就不动数据。
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
  return updated <= created;
}

/**
 * 该丢弃哪些空草稿：除 `keepId`（马上要被选中的那条）之外的全部。
 *
 * 为什么要留一条：选中的空草稿就是用户眼前的「新任务」，输入框刚聚焦 —— 此刻把它删掉，
 * 界面会在用户第一次敲字前闪一下空状态。它会在用户真正切走时被下一次调用收走。
 */
export function discardableDraftIds(
  tasks: ReadonlyArray<DraftCandidate>,
  keepId?: string,
): string[] {
  return tasks.filter((task) => task.id !== keepId && isEmptyDraft(task)).map((task) => task.id);
}