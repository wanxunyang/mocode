// 通用文案池:各 mood 对应的中文吐槽短句,以及随机选取逻辑。
// 皮肤可提供自定义文案(skinQuips)覆盖某个 mood 的候选池;未覆盖或为空时回退到通用文案池。

import type { MoodKind } from './mood.js';

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
