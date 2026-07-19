export type ContentHash = `sha256:${string}`;
export type FileOperation = 'create' | 'update' | 'delete';

export interface FileVersion {
  exists: boolean;
  hash: ContentHash | null;
  size: number;
}

export interface TextEdit {
  /** UTF-16 string offset, matching JavaScript slice semantics. */
  start: number;
  end: number;
  newText: string;
}

export interface FileChange {
  path: string;
  operation: FileOperation;
  /** null means the path must not exist. */
  expectedHash: ContentHash | null;
  edits?: TextEdit[];
  replacement?: string;
}

export interface ChangeSet {
  id: string;
  createdAt: number;
  changes: FileChange[];
}

export interface PreparedFileChange extends FileChange {
  absolutePath: string;
  before: Buffer | null;
  after: Buffer | null;
  beforeHash: ContentHash | null;
  afterHash: ContentHash | null;
}

export interface PreparedChangeSet extends ChangeSet {
  prepared: PreparedFileChange[];
}

export interface ChangeConflict {
  path: string;
  expectedHash: ContentHash | null;
  actualHash: ContentHash | null;
  reason: string;
}

export type ChangeSetResult =
  | { status: 'committed'; changeSet: PreparedChangeSet; changedFiles: string[] }
  | { status: 'conflict'; changeSet: ChangeSet; conflicts: ChangeConflict[]; changedFiles: [] }
  | { status: 'failed'; changeSet: ChangeSet; error: string; changedFiles: [] };

export interface ChangeSetSummary {
  id: string;
  changedFiles: string[];
  changes: Array<{
    path: string;
    operation: FileOperation;
    beforeHash: ContentHash | null;
    afterHash: ContentHash | null;
  }>;
}