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

window.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('pet-container');
  if (!container) return;
  applyState(container, 'idle');

  // inline mascot.svg(而非 <img>/<object>)以保留其内部 id,供 style.css 的
  // #pet-antenna / #pet-body-group / #pet-mouth / #pet-arm-left / #pet-arm-right 选择器生效
  // (外部引用的 SVG 内容不可被外部 CSS 选中,必须 inline 进同一文档)。
  try {
    // 构建后 assets/ 与 renderer/ 同级复制到 dist/(见 scripts/copy-static.mjs),故用 ../assets。
    const res = await fetch('../assets/mascot.svg');
    const svgText = await res.text();
    container.insertAdjacentHTML('afterbegin', svgText);
  } catch {
    // 素材加载失败:容器保持空白,不影响状态机/IPC 正常工作(降级为无形象但仍可运行)
  }

  window.petBridge.onState((state) => applyState(container, state));
});
