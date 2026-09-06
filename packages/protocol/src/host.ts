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
