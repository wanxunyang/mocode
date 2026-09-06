import type { HostAttachment, HostCommand } from '@mocode/protocol/host';

export type { HostAttachment, HostCommand, HostEnvelope } from '@mocode/protocol/host';

function parseAttachments(value: unknown): HostAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== 'string' || typeof entry.dataUrl !== 'string' || !entry.dataUrl.startsWith('data:image/'))
      return [];
    return [{ name: entry.name.slice(0, 240), dataUrl: entry.dataUrl }];
  });
}

export function parseCommand(value: unknown): HostCommand | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || typeof input.type !== 'string') return null;
  if (input.type === 'run' && typeof input.prompt === 'string') {
    return {
      id: input.id,
      type: 'run',
      prompt: input.prompt,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
      attachments: parseAttachments(input.attachments),
    };
  }
  if (input.type === 'cancel') return { id: input.id, type: 'cancel' };
  if (input.type === 'compact')
    return { id: input.id, type: 'compact', focus: typeof input.focus === 'string' ? input.focus : undefined };
  if (input.type === 'approval' && typeof input.approvalId === 'string') {
    return {
      id: input.id,
      type: 'approval',
      approvalId: input.approvalId,
      action: input.action === 'selected' ? 'selected' : 'cancelled',
      value: typeof input.value === 'string' ? input.value : undefined,
    };
  }
  return null;
}
