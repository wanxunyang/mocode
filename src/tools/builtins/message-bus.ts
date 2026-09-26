import type { Tool, ToolOutcome } from '../types.js';
import { sendMessage, inbox, markRead, messageHistory, getIdentity, type BusMessage } from '../../bots/bus.js';

// ---------- message_bus ----------
// D1：通过持久消息总线与其他具名 bot 异步通信。消息落盘，对方不必同时在线——
// worker bot 之后被 scheduler / bg 唤起时拉 inbox、处理、回结果（再 send 一条 to=原发送者）。
//
// action:
//   send     {to, body, inReplyTo?}  给某 bot 发消息
//   inbox    拉取当前身份的未读消息（默认拉取后自动 ack）
//   ack      {ids:[...]}             手动标记已读
//   history  与当前身份相关的全部消息
export const messageBusTool: Tool = {
  name: 'message_bus',
  description: [
    'Asynchronous persistent messaging between named bots (and the main user). Messages are stored; the recipient need not be running and reads its inbox later.',
    'Actions: send {to, body, inReplyTo?}, inbox (unread, auto-ack by default), ack {ids}, history. Use for durable hand-offs rather than synchronous sub-agent calls.',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send', 'inbox', 'ack', 'history'],
        description: 'Bus operation.',
      },
      to: { type: 'string', description: 'Recipient bot name (send).' },
      body: { type: 'string', description: 'Message body (send).' },
      inReplyTo: { type: 'string', description: 'Id of the message being replied to.' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Message ids to acknowledge (ack).',
      },
      autoAck: {
        type: 'boolean',
        description: 'With inbox: mark pulled messages read (default true).',
      },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action ?? '');
    const identity = getIdentity();

    const formatMsg = (m: BusMessage): string => `[${m.id}] ${m.from} -> ${m.to} @ ${m.createdAt}\n${m.body}`;

    let output: string;
    try {
      if (action === 'send') {
        const to = String(args.to ?? '');
        const body = String(args.body ?? '');
        if (!to || !body) return 'message_bus send requires to and body';
        const msg = sendMessage({
          to,
          body,
          ...(typeof args.inReplyTo === 'string' ? { inReplyTo: args.inReplyTo } : {}),
        });
        output = `sent ${msg.id} to ${msg.to}`;
      } else if (action === 'inbox') {
        const msgs = inbox(identity);
        if (msgs.length === 0) {
          output = `(no unread messages for ${identity})`;
        } else {
          output = [`inbox for ${identity}: ${msgs.length} unread`, '', ...msgs.map(formatMsg)].join('\n');
          if (args.autoAck !== false) {
            const marked = markRead(
              msgs.map((m) => m.id),
              identity,
            );
            output += `\n\n(acked ${marked.length})`;
          }
        }
      } else if (action === 'ack') {
        const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === 'string') : [];
        const marked = markRead(ids, identity);
        output = `acked ${marked.length} message(s)`;
      } else if (action === 'history') {
        const msgs = messageHistory(identity);
        output = msgs.length
          ? [`history for ${identity}: ${msgs.length}`, '', ...msgs.map(formatMsg)].join('\n')
          : `(no messages for ${identity})`;
      } else {
        return `unknown message_bus action: ${action}`;
      }
    } catch (e) {
      const outcome: ToolOutcome = {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        output: e instanceof Error ? e.message : String(e),
      };
      return outcome;
    }

    const outcome: ToolOutcome = { status: 'success', code: 'OK', retryable: false, output };
    return outcome;
  },
};
