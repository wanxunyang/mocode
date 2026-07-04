// 通用文案池:各 mood 对应的中文吐槽短句,以及随机选取逻辑。
// 皮肤可提供自定义文案(skinQuips)覆盖某个 mood 的候选池;未覆盖或为空时回退到通用文案池。
// 另提供 pickStateQuip:PetState 维度的文案(独立于 mood,见 protocol.ts)——
// 让皮肤对"任务完成 / 用户中断 / 报错"等瞬时状态也能挂个性化吐槽。

import type { MoodKind } from './mood.js';
import type { PetState } from './protocol.js';

/** 每种 mood 的通用吐槽短句候选池,语气轻松幽默(赛博终端风机器人设定)。 */
export const UNIVERSAL_QUIPS: Record<MoodKind, string[]> = {
  frustrated: [
    '又报错了…要不要歇一下?',
    '这个 bug 有点顽固啊',
    '报错第二次了,压力有点大',
    '怎么又翻车了,深呼吸一下',
  ],
  flustered: [
    '感觉在同时干好多件事…',
    '工具切换得好快!',
    '有点跟不上节奏了',
    '脑子有点转不过来了',
  ],
  urging: [
    '还在等你哦~',
    '我等得有点无聊了',
    '需要你看一下呢',
    '别忘了我还在等呢',
  ],
  tired: [
    '这个任务有点久,好累…',
    '还在跑,坐等一下',
    '累了累了,继续肝',
    '电量有点低了,撑住',
  ],
  bored: [
    '闲着没事,打个哈欠',
    '东张西望中…',
    '有什么新任务吗',
    '好安静啊,有点无聊',
  ],
};

/**
 * 根据 mood 选一条吐槽文案。
 * 若 skinQuips 里该 mood 有非空候选列表,优先从中随机选;否则回退到 pool(默认通用文案池)。
 * 纯函数,唯一的非确定性来源是 Math.random()。
 */
export function pickQuip(
  mood: MoodKind,
  skinQuips?: Partial<Record<MoodKind, string[]>>,
  pool: Record<MoodKind, string[]> = UNIVERSAL_QUIPS,
): string {
  const skinList = skinQuips?.[mood];
  const list = skinList && skinList.length > 0 ? skinList : pool[mood];
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 根据 PetState 选一条吐槽文案(独立于 mood 系统,见 quips.ts 顶部注释)。
 * 命中条件:stateQuips 里该 state 有非空候选列表 → 随机选一条;否则返回 null。
 * 返回 null 表示"该 state 在该皮肤下没有专属文案",调用方据此跳过推送(不影响主流程)。
 * 纯函数,唯一的非确定性来源是 Math.random()。
 */
export function pickStateQuip(
  state: PetState,
  stateQuips?: Partial<Record<PetState, string[]>>,
): string | null {
  const list = stateQuips?.[state];
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}
