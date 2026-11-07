export interface HostAttachment {
  name: string;
  dataUrl: string;
}

export type HostCommand =
  | { id: string; type: 'run'; prompt: string; sessionId?: string; attachments?: HostAttachment[] }
  | { id: string; type: 'cancel' }
  | { id: string; type: 'compact'; focus?: string }
  /**
   * 回答一次人工介入。`submitted` 是自由文本回答（ask_human 的 input 形态），
   * 与 `selected`（从给定选项里挑一个）区分开：两者回给模型的措辞不同。
   * 旧客户端只会发 selected / cancelled，新增的取值不影响它们。
   */
  | {
      id: string;
      type: 'approval';
      approvalId: string;
      action: 'selected' | 'submitted' | 'cancelled';
      value?: string;
    };

export interface HostEnvelope {
  type: 'event' | 'error';
  requestId?: string;
  event?: string;
  payload?: Record<string, unknown>;
  error?: string;
}
