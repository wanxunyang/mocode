export interface WorkAttachment {
  name: string;
  dataUrl?: string;
  text?: string;
  truncated?: boolean;
}

export type AttachmentErrorCode = 'unsupported' | 'too_large' | 'invalid_utf8' | 'empty_text' | 'read_failed';
export type AttachmentResult = { attachment: WorkAttachment } | { error: AttachmentErrorCode; name: string };
