/**
 * 排队消息面板（输入卡正上方）——纯 DOM 构建，无全局状态、无 IPC。
 *
 * 产品规则：agent 正在跑时按发送**不打断**当前轮，而是把消息压进 per-task FIFO
 * （见 send-queue.ts）。用户必须能看见「我排了什么」——否则会以为消息丢了。
 *   · 收起态（默认）：**一行**，只露出下一条要发的消息，其余折叠，输入区不被顶高；
 *   · 展开态：完整队列，按 FIFO 顺序编号，首条高亮（它就是下一条）。
 *
 * 只在队列本身变化时重建（入队 / 出队 / 清空），不参与流式高频刷新 ——
 * 这样点击展开的那一下不会被状态推送抢掉（与侧栏那次 click 丢失同源的教训）。
 */

import { icon } from './icons.js';

export type QueuePanelItem = {
  /** 队列内唯一键（SendQueue 的 seq），用于签名比对与 React 式的稳定重建判断。 */
  key: number;
  /** 已解析好占位文案的正文（纯附件消息由调用方给 fallback）。 */
  text: string;
  attachmentCount: number;
};

export interface QueuePanelLabels {
  /** 收起态前缀，说明下方那行是下一条要发的。 */
  next: string;
  /** 展开 / 收起按钮的 title 与 aria-label。 */
  expand: string;
  collapse: string;
  /** 附件条数，如「{n} 个附件」。 */
  attachments: (n: number) => string;
}

export interface QueuePanelOptions {
  expanded: boolean;
  labels: QueuePanelLabels;
  /** 点击摘要行（仅当队列 > 1 条时面板可点）。 */
  onToggle: () => void;
}

/** 空状态签名：容器被清空后必须能重新渲染（WeakMap 不会阻止容器回收）。 */
const signatures = new WeakMap<HTMLElement, string>();

export function renderQueuePanel(root: HTMLElement, items: QueuePanelItem[], options: QueuePanelOptions): void {
  const { labels } = options;
  // 多条才值得展开；只有一条时那一行已经是它的全部内容。
  const expandable = items.length > 1;
  const expanded = options.expanded && expandable;
  const signature = JSON.stringify([
    expanded,
    expandable,
    items.map((item) => [item.key, item.text, item.attachmentCount]),
    [labels.next, labels.expand, labels.collapse],
  ]);
  if (signatures.get(root) === signature) return;
  signatures.set(root, signature);

  root.replaceChildren();
  root.classList.toggle('hidden', items.length === 0);
  root.classList.toggle('is-expanded', expanded);
  if (!items.length) return;

  const next = items[0]!;
  const summary = document.createElement(expandable ? 'button' : 'div');
  summary.className = 'queue-summary';
  if (expandable) {
    const button = summary as HTMLButtonElement;
    button.type = 'button';
    button.dataset.queueToggle = '1';
    button.setAttribute('aria-expanded', String(expanded));
    button.title = expanded ? labels.collapse : labels.expand;
    button.setAttribute('aria-label', expanded ? labels.collapse : labels.expand);
    button.addEventListener('click', () => options.onToggle());
  }

  const count = document.createElement('span');
  count.className = 'queue-count';
  count.textContent = String(items.length);
  count.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'queue-label';
  label.textContent = labels.next;

  const text = document.createElement('span');
  text.className = 'queue-next';
  text.textContent = next.text;
  // 单行省略后原文仍可读：悬停看全文，不展开也不憋着。
  text.title = next.text;

  summary.append(count, label, text);

  if (next.attachmentCount > 0) {
    const meta = document.createElement('span');
    meta.className = 'queue-item-meta';
    meta.textContent = labels.attachments(next.attachmentCount);
    summary.append(meta);
  }
  if (expandable) {
    const caret = document.createElement('span');
    caret.className = 'queue-caret';
    caret.innerHTML = icon('chevron-down');
    summary.append(caret);
  }
  root.append(summary);

  const list = document.createElement('ul');
  list.className = 'queue-list';
  list.classList.toggle('hidden', !expanded);
  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = `queue-item${index === 0 ? ' is-next' : ''}`;
    const order = document.createElement('span');
    order.className = 'queue-item-index';
    order.textContent = String(index + 1);
    const body = document.createElement('span');
    body.className = 'queue-item-text';
    body.textContent = item.text;
    row.append(order, body);
    if (item.attachmentCount > 0) {
      const meta = document.createElement('span');
      meta.className = 'queue-item-meta';
      meta.textContent = labels.attachments(item.attachmentCount);
      row.append(meta);
    }
    list.append(row);
  });
  root.append(list);
}