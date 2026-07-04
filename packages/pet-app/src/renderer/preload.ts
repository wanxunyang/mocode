// Electron preload:通过 contextBridge 把主进程 IPC 推送的状态安全暴露给渲染进程(contextIsolation=true,
// 不给渲染进程任何 Node/Electron API 访问权限,只转发一个只读回调注册接口)。

import { contextBridge, ipcRenderer } from 'electron';
import type { PetState, PetStateMeta } from '../protocol.js';
import type { MoodKind } from '../mood.js';

/** 与 mood.ts 同样的环境变量读法:取合法正数,非法/缺失回退默认值。 */
function envNumber(name: string, defaultValue: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** 气泡文案展示时长(ms),环境变量 MOCODE_PET_QUIP_VISIBLE_MS 覆盖,默认 6000(2x 老值 3000)。
 *  渲染进程 renderer.ts 在模块顶层读取该值,后续 showQuip 调用都使用它——启动后变更需重启 pet-app 生效。 */
const QUIP_VISIBLE_MS = envNumber('MOCODE_PET_QUIP_VISIBLE_MS', 6000);

/** 闲置多久后桌宠进入"打盹"状态(ms),环境变量 MOCODE_PET_IDLE_SLEEP_MS 覆盖,默认 300000(5 分钟)。
 *  任意状态变化(state IPC)/ 鼠标交互(hover/click/drag)都会重置这个计时器,计时归零后给 #pet-stage 加 .pet-asleep
 *  (由 style.css 驱动慢呼吸 + 半闭眼动画,见 renderer.ts markActive / triggerAsleep)。 */
const IDLE_SLEEP_MS = envNumber('MOCODE_PET_IDLE_SLEEP_MS', 300_000);

contextBridge.exposeInMainWorld('petBridge', {
  onState: (callback: (state: PetState, meta?: PetStateMeta) => void) => {
    ipcRenderer.on('pet:state', (_event, payload: { state: PetState; meta?: PetStateMeta }) => {
      callback(payload.state, payload.meta);
    });
  },
  /** 主进程推来的皮肤切换通知(运行期切换:托盘菜单选择 或 CLI set_skin 消息触发)。
   *  motionFile 有值时指向该皮肤的个性化动作覆盖 CSS(见 renderer.ts applySkinMotion),缺失表示回退通用样式。 */
  onSkin: (callback: (payload: { assetPath: string; motionFile?: string }) => void) => {
    ipcRenderer.on('pet:skin', (_event, payload: { assetPath: string; motionFile?: string }) => {
      callback(payload);
    });
  },
  /** 启动时主动拉取当前皮肤(避免 did-finish-load 推送与监听器注册之间的时序竞争)。 */
  getInitialSkin: (): Promise<{ assetPath: string; motionFile?: string }> => ipcRenderer.invoke('pet:get-skin'),
  /** 气泡文案展示时长(ms),renderer.ts 在模块顶层读取一次后用于所有 showQuip 调用。 */
  quipVisibleMs: QUIP_VISIBLE_MS,
  /** 闲置进入打盹的时长(ms),renderer.ts 在模块顶层读取一次后用于 markActive 重置逻辑。 */
  idleSleepMs: IDLE_SLEEP_MS,
  /** 主进程推来的 mood 求值结果(见 main.ts pushMoodEvaluation),mood 为 null 表示当前无需展示情绪演出。 */
  onMood: (callback: (mood: MoodKind | null, quip?: string) => void) => {
    ipcRenderer.on('pet:mood', (_event, payload: { mood: MoodKind | null; quip?: string }) => {
      callback(payload.mood, payload.quip);
    });
  },
  /** 转发鼠标穿透状态请求(拖拽放置功能:悬停/拖拽时取消穿透,离开后恢复穿透)。 */
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send('pet:set-ignore-mouse-events', ignore);
  },
  /** 手动拖拽(替代不可靠的 -webkit-app-region:drag,见 style.css 顶部注释):
   *  dragStart 在 mousedown 时调用一次,让主进程记住窗口起始 bounds;
   *  dragMove 在 mousemove 时传"相对起点的累计位移"(不是相对上一帧的增量)——
   *  这样主进程永远从固定的起始尺寸算新位置,不会因反复读取可能已被 Windows DPI 舍入误差
   *  放大的当前尺寸而越拖越大(见 main.ts dragStartBounds 注释);
   *  dragEnd 在 mouseup 时调用,清空起始记录。 */
  dragStart: () => {
    ipcRenderer.send('pet:drag-start');
  },
  dragMove: (totalDx: number, totalDy: number) => {
    ipcRenderer.send('pet:drag-move', totalDx, totalDy);
  },
  dragEnd: () => {
    ipcRenderer.send('pet:drag-end');
  },
});
