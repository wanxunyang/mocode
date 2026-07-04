// 渲染进程:纯展示逻辑,不含业务判断。接收 preload 暴露的 petBridge.onState 回调,
// 按 PetState 切换外层容器的 CSS class,驱动 style.css 里定义的 @keyframes 动画。
// mascot.svg 本身的呼吸灯/眨眼动画(inline <animate>)始终运行,不受这里的 class 切换影响。

import type { PetState, PetStateMeta } from '../protocol.js';
import type { MoodKind } from '../mood.js';
import { applyMood, applySkinMotion, createBubbleController } from './dom-mood.js';

declare global {
  interface Window {
    petBridge: {
      onState: (cb: (state: PetState, meta?: PetStateMeta) => void) => void;
      onSkin: (cb: (payload: { assetPath: string; motionFile?: string }) => void) => void;
      getInitialSkin: () => Promise<{ assetPath: string; motionFile?: string }>;
      quipVisibleMs: number;
      idleSleepMs: number;
      onMood: (cb: (mood: MoodKind | null, quip?: string) => void) => void;
      setIgnoreMouseEvents: (ignore: boolean) => void;
      dragStart: () => void;
      dragMove: (totalDx: number, totalDy: number) => void;
      dragEnd: () => void;
    };
  }
}

/** 气泡文案展示时长,从 preload 经 MOCODE_PET_QUIP_VISIBLE_MS 环境变量注入,默认 6000(见 dom-mood.ts QUIP_VISIBLE_MS)。 */
const QUIP_VISIBLE_MS = window.petBridge.quipVisibleMs;

/** 闲置多久后桌宠进入"打盹"状态(ms),从 preload 经 MOCODE_PET_IDLE_SLEEP_MS 环境变量注入,默认 300000(5 分钟)。 */
const IDLE_SLEEP_MS = window.petBridge.idleSleepMs;

const ALL_STATE_CLASSES = [
  'pet-idle',
  'pet-thinking',
  'pet-speaking',
  'pet-tool',
  'pet-done',
  'pet-aborted',
  'pet-error',
  'pet-waiting-human',
] as const;

/** PetState → CSS class 映射表(design.md 动画映射表)。 */
const STATE_CLASS: Record<PetState, string> = {
  idle: 'pet-idle',
  thinking: 'pet-thinking',
  speaking: 'pet-speaking',
  tool_call: 'pet-tool',
  done: 'pet-done',
  aborted: 'pet-aborted',
  error: 'pet-error',
  waiting_human: 'pet-waiting-human',
};

function applyState(container: HTMLElement, state: PetState): void {
  container.classList.remove(...ALL_STATE_CLASSES);
  container.classList.add(STATE_CLASS[state] ?? 'pet-idle');
}

/** 从真实 `#pet-skin-motion` <link> 取值后交给抽取出的纯函数 applySkinMotion(见 dom-mood.ts)处理。 */
function setSkinMotion(motionFile?: string): void {
  const link = document.getElementById('pet-skin-motion') as HTMLLinkElement | null;
  if (!link) return;
  applySkinMotion(link, motionFile);
}

/** 把 assets/ 下的 SVG 文本 inline 插入指定容器(保留内部 id,供 CSS 选择器跨状态切换样式)。 */
async function inlineSvgInto(container: HTMLElement, assetPath: string): Promise<void> {
  try {
    // 构建后 assets/ 与 renderer/ 同级复制到 dist/(见 scripts/copy-static.mjs),故用 ../assets。
    const res = await fetch(assetPath);
    const svgText = await res.text();
    container.insertAdjacentHTML('afterbegin', svgText);
  } catch {
    // 素材加载失败:容器保持空白,不影响状态机/IPC 正常工作(降级为无形象但仍可运行)
  }
}

/** 切换皮肤:清空宠物容器后重新 inline 新素材(信号灯/状态 class 均不受影响,独立于宠物素材本身),
 *  同时设置/清空个性化动作覆盖 CSS(见 applySkinMotion)。 */
async function swapSkin(petContainer: HTMLElement, assetPath: string, motionFile?: string): Promise<void> {
  petContainer.innerHTML = '';
  await inlineSvgInto(petContainer, assetPath);
  setSkinMotion(motionFile);
}

window.addEventListener('DOMContentLoaded', async () => {
  // 状态 class 加在 #pet-stage 上(mascot 与信号灯共同的祖先容器),两者的动画/灯光规则
  // 均以 `.pet-xxx #element-id` 描述,不要求元素是直接子节点。
  const stage = document.getElementById('pet-stage');
  const petContainer = document.getElementById('pet-container');
  const lampContainer = document.getElementById('signal-light-container');
  const bubbleEl = document.getElementById('pet-bubble');
  if (!stage || !petContainer || !lampContainer || !bubbleEl) return;
  // 把 stage 取一个非空本地别名,后续 markActive / triggerPetted 闭包引用它——
  // TS 控制流收窄不会穿透到嵌套函数体,直接用 stage! 不优雅,这里取一个 const 别名一劳永逸。
  const stageEl: HTMLElement = stage;
  applyState(stageEl, 'idle');

  // 启动时的初始皮肤:主动向主进程 invoke 拉取(而非等主进程 send 推送)——
  // 消除 did-finish-load 推送与本文件异步注册监听器之间的时序竞争(见 main.ts pushSkinToRenderer 注释)。
  const initialSkin = await window.petBridge
    .getInitialSkin()
    .catch(() => ({ assetPath: '../assets/mascot.svg', motionFile: undefined }));

  await Promise.all([
    inlineSvgInto(petContainer, initialSkin.assetPath),
    inlineSvgInto(lampContainer, '../assets/signal-light.svg'),
  ]);
  setSkinMotion(initialSkin.motionFile);

  const bubbleController = createBubbleController();

  // === 闲置交互(hover/click/打盹) ============================================
  // 这 3 个 class 跟 .pet-thinking / .pet-tool 等 state class 平行,但驱动源不同:
  // state class 由 agent 状态机驱动(可预测、可节流),interaction class 由用户输入驱动(瞬时)。
  // .pet-asleep 是持续态(进入后维持,直到 markActive 把它清掉),
  // .pet-hover / .pet-petted 是瞬时态(进入后用 animation 跑完 1 帧后由 JS 主动清 class,
  // 让通用规则或下一轮 hover/click 重新触发)。
  // 通用规则见 style.css 末尾"闲置交互"小节,各宠物在 motion CSS 里追加角色化覆写。 ──

  /** 闲置打盹计时器句柄;非 null 表示正在倒计时,归零时给 #pet-stage 加 .pet-asleep。 */
  let asleepTimer: number | null = null;
  /** 拖拽期间累计位移是否超过 5px 阈值(超过 → 视为"拖动",mouseup 时不再触发 pet-petted)。 */
  let dragMoved = false;
  /** 单次 .pet-petted 动画持续时长,需与 style.css @keyframes pet-petted-bounce 的 0.7s 对齐。 */
  const PETTED_ANIM_MS = 700;

  /** 标记"用户/agent 有活动":清掉 .pet-asleep 并重置闲置计时器。
   *  任何状态变化(state IPC)、hover、click 都会调用一次,空闲 IDLE_SLEEP_MS 后再次进入打盹。 */
  function markActive(): void {
    if (stageEl.classList.contains('pet-asleep')) {
      stageEl.classList.remove('pet-asleep');
    }
    if (asleepTimer !== null) {
      clearTimeout(asleepTimer);
    }
    asleepTimer = window.setTimeout(() => {
      stageEl.classList.add('pet-asleep');
    }, IDLE_SLEEP_MS);
  }

  /** 被点一下:移除旧的 .pet-petted class → 强制 reflow → 重新加 class,触发 CSS 动画重跑;
   *  动画结束后由 setTimeout 清掉 class,避免 animation:1 的关键帧在 class 存在期间再次触发动画(虽然 1 次也无所谓,
   *  主要是为了语义清晰:"petted" 是瞬时态而非持续态)。 */
  function triggerPetted(): void {
    stageEl.classList.remove('pet-petted');
    // 强制 reflow 让浏览器重新计算 animation,确保短时间内多次点击每次都从头播放
    void stageEl.offsetWidth;
    stageEl.classList.add('pet-petted');
    window.setTimeout(() => stageEl.classList.remove('pet-petted'), PETTED_ANIM_MS);
    markActive();
  }

  window.petBridge.onState((state) => {
    applyState(stageEl, state);
    markActive();
  });
  window.petBridge.onSkin(({ assetPath, motionFile }) => swapSkin(petContainer, assetPath, motionFile));
  window.petBridge.onMood((mood, quip) => {
    applyMood(stageEl, mood);
    // 状态文案(由 main.ts broadcastToRenderer 选 stateQuips 推送过来)和 mood 文案共用同一条 IPC;
    // 状态文案的 mood 字段为 null,只要 quip 存在就展示;mood 文案按之前的语义(mood 命中)也展示。
    if (quip) bubbleController.showQuip(bubbleEl, quip, QUIP_VISIBLE_MS);
  });

  // 拖拽放置:窗口默认鼠标穿透(见 main.ts setIgnoreMouseEvents(true,{forward:true})),
  // 鼠标悬停到宠物身上时取消穿透(可交互),离开后恢复穿透(不遮挡桌面下层点击)。这是 Electron
  // 官方推荐的 hover 点击穿透模式
  // (https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#forward-mouse-events-macos-windows)。
  //
  // 拖动本身不使用 -webkit-app-region:drag——该 CSS 属性在 Windows 上会导致其覆盖区域吞掉所有指针事件
  // (见 https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions 的说明:
  // "draggable areas ignore all pointer events"),使 mouseenter/mouseleave 永远不会触发。
  //
  // 位移量必须是"相对拖拽起点的累计值",不能是"相对上一帧的增量"——原因见 main.ts dragStartBounds
  // 注释:Windows 下 setBounds 存在 DPI 舍入误差,若主进程每次都读当前窗口尺寸再原样传回,
  // 误差会不断累加导致窗口越拖越大。用累计位移 + 固定起始 bounds 可以彻底避免这个问题
  // (每次都是"起点+累计位移",不依赖任何中间状态)。
  let dragging = false;
  let startX = 0;
  let startY = 0;

  stage.addEventListener('mouseenter', () => {
    window.petBridge.setIgnoreMouseEvents(false);
    stageEl.classList.add('pet-hover');
    markActive();
  });
  stage.addEventListener('mouseleave', () => {
    if (!dragging) window.petBridge.setIgnoreMouseEvents(true);
    stageEl.classList.remove('pet-hover');
  });

  stage.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true;
    dragMoved = false;
    startX = e.screenX;
    startY = e.screenY;
    window.petBridge.dragStart();
    markActive();
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    // 5px 阈值:用户手抖不可避免,但凡有"想拖动"的意图(>5px)就不算 click,避免误触 pet-petted
    if (!dragMoved && (Math.abs(e.screenX - startX) > 5 || Math.abs(e.screenY - startY) > 5)) {
      dragMoved = true;
    }
    window.petBridge.dragMove(e.screenX - startX, e.screenY - startY);
  });

  window.addEventListener('mouseup', () => {
    // 只清 dragging 标志,不在这里恢复鼠标穿透——鼠标此时通常仍悬停在宠物上方(没有离开过 #pet-stage),
    // 若这里强行 setIgnoreMouseEvents(true),会导致窗口提前变回穿透态,而 mouseenter 只在"进入"
    // 时触发一次、不会因为穿透状态变化而重新触发,于是后续再也收不到 mousedown——表现为"只能拖动一次"。
    // 穿透状态改由 mouseleave 统一负责:真正移出宠物范围时才恢复穿透。
    if (!dragging) return;
    const wasClick = !dragMoved;
    dragging = false;
    window.petBridge.dragEnd();
    // mousedown 到 mouseup 之间位移 < 5px → 视为点击(不是拖动),触发 pet-petted 弹一下
    if (wasClick) triggerPetted();
  });

  // 启动闲置计时器:launch 起来后 IDLE_SLEEP_MS 内没任何活动就进入打盹。
  // 注意必须在 onState 监听器注册后调用,否则第一个 state 变化会早于 markActive 跑,逻辑仍然 OK
  // (markActive 是幂等的),但顺序上让"先注册监听器,再启动计时"更清晰。
  markActive();
});
