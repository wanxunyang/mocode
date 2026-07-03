// 渲染进程:纯展示逻辑,不含业务判断。接收 preload 暴露的 petBridge.onState 回调,
// 按 PetState 切换外层容器的 CSS class,驱动 style.css 里定义的 @keyframes 动画。
// mascot.svg 本身的呼吸灯/眨眼动画(inline <animate>)始终运行,不受这里的 class 切换影响。

import type { PetState, PetStateMeta } from '../protocol.js';

declare global {
  interface Window {
    petBridge: {
      onState: (cb: (state: PetState, meta?: PetStateMeta) => void) => void;
    };
  }
}

const ALL_STATE_CLASSES = [
  'pet-idle',
  'pet-thinking',
  'pet-speaking',
  'pet-tool',
  'pet-done',
  'pet-aborted',
  'pet-error',
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
};

function applyState(container: HTMLElement, state: PetState): void {
  container.classList.remove(...ALL_STATE_CLASSES);
  container.classList.add(STATE_CLASS[state] ?? 'pet-idle');
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

window.addEventListener('DOMContentLoaded', async () => {
  // 状态 class 加在 #pet-stage 上(mascot 与信号灯共同的祖先容器),两者的动画/灯光规则
  // 均以 `.pet-xxx #element-id` 描述,不要求元素是直接子节点。
  const stage = document.getElementById('pet-stage');
  const petContainer = document.getElementById('pet-container');
  const lampContainer = document.getElementById('signal-light-container');
  if (!stage || !petContainer || !lampContainer) return;
  applyState(stage, 'idle');

  await Promise.all([
    inlineSvgInto(petContainer, '../assets/mascot.svg'),
    inlineSvgInto(lampContainer, '../assets/signal-light.svg'),
  ]);

  window.petBridge.onState((state) => applyState(stage, state));
});
