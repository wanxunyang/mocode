export interface HostAttachment {
  name: string;
  dataUrl: string;
}

export type HostCommand =
  | { id: string; type: 'run'; prompt: string; sessionId?: string; attachments?: HostAttachment[] }
  | { id: string; type: 'cancel' }
  | { id: string; type: 'compact'; focus?: string }
  | { id: string; type: 'approval'; approvalId: string; action: 'selected' | 'cancelled'; value?: string };

export interface HostEnvelope {
  type: 'event' | 'error';
  requestId?: string;
  event?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

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
