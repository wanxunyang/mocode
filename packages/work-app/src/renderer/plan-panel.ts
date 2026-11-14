/**
 * 计划进度面板的**纯字符串渲染**（无 DOM、无 i18n 运行时依赖）。
 *
 * 为什么单独成模块：这份 markup 决定「用户一眼看到什么」，是本次改动的核心产物。
 * 埋在 renderer.ts 里就没法在 node 里断言（`npm test` 环境没有 DOM），
 * 抽出来之后可以用真实生成的 HTML 做断言 + 用浏览器加载真实 CSS 截图核对。
 *
 * 文案由调用方注入（同 tool-view.ts / diff-view.ts 的做法），本模块只管结构。
 */
import { icon } from './icons.js';
import type { PlanSnapshot } from '../plan.js';

export interface PlanPanelLabels {
  /** 展开步骤的 aria/title */
  expand: string;
  /** 收起步骤的 aria/title */
  collapse: string;
  /** 关闭面板 */
  dismiss: string;
  /** 「2/5」 */
  progress: string;
  /** 收起态一行的副标题：当前步（进行中）或完成提示（全部完成） */
  subtitle: string;
}

const MAX_TITLE_CHARS = 60;
const MAX_LABEL_CHARS = 120;
const MAX_DETAIL_CHARS = 160;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 面板内层 HTML。调用方负责把它塞进 #plan-panel 并挂事件。 */
export function planPanelHtml(plan: PlanSnapshot, expanded: boolean, labels: PlanPanelLabels): string {
  const percent = plan.total > 0 ? Math.round((plan.done / plan.total) * 100) : 0;
  const steps = plan.steps
    .map((step, index) => {
      const tone = step.status === 'completed' ? ' is-done' : step.status === 'in_progress' ? ' is-current' : '';
      // 进行中的步骤优先显示进行时文案（activeForm），这也是用户在等的那句话。
      const label = step.status === 'in_progress' ? step.activeForm || step.title : step.title;
      const detailText = step.content && step.content !== label && step.content !== step.title ? step.content : '';
      const detail = detailText
        ? `<span class="plan-step-detail">${escapeHtml(clip(detailText, MAX_DETAIL_CHARS))}</span>`
        : '';
      return (
        `<li class="plan-step${tone}">` +
        `<span class="plan-step-idx">${index + 1}</span>` +
        `<span class="plan-step-body">` +
        `<span class="plan-step-label">${escapeHtml(clip(label, MAX_LABEL_CHARS))}</span>${detail}` +
        `</span></li>`
      );
    })
    .join('');
  const cardClass = ['plan-card', plan.allDone ? 'is-done' : '', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ');
  const subtitle = clip(labels.subtitle, 80);
  const toggleTitle = expanded ? labels.collapse : labels.expand;
  return `<div class="${cardClass}">
  <div class="plan-head">
    <button class="plan-head-main" type="button" aria-expanded="${expanded}" title="${escapeHtml(toggleTitle)}">
      <span class="plan-mark">${plan.allDone ? icon('check') : ''}</span>
      <span class="plan-title">${escapeHtml(clip(plan.title, MAX_TITLE_CHARS))}</span>
      <span class="plan-current" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span>
      <span class="plan-count">${escapeHtml(labels.progress)}</span>
      <span class="plan-caret">${icon('chevron-down')}</span>
    </button>
    <button class="plan-dismiss" type="button" title="${escapeHtml(labels.dismiss)}" aria-label="${escapeHtml(labels.dismiss)}">${icon('close')}</button>
  </div>
  <ul class="plan-steps${expanded ? '' : ' hidden'}">${steps}</ul>
  <div class="plan-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span class="plan-fill" style="width:${percent}%"></span></div>
</div>`;
}