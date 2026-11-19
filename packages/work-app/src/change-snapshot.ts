export interface ChangeSnapshotFile {
  path: string;
  added: number;
  removed: number;
  untracked: boolean;
}

export interface ChangeSnapshot {
  kind: 'changes';
  snapshotId?: string;
  files: ChangeSnapshotFile[];
}

export function changeFilesFrom(raw: unknown): ChangeSnapshotFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path) return [];
    return [{
      path: item.path,
      added: typeof item.added === 'number' && Number.isFinite(item.added) ? item.added : 0,
      removed: typeof item.removed === 'number' && Number.isFinite(item.removed) ? item.removed : 0,
      untracked: item.untracked === true,
    }];
  });
}

/** 轮末先记录文件归属，异步行数统计只更新这一个快照。 */
export function completedChangeSnapshot(payload: Record<string, unknown>): ChangeSnapshot | undefined {
  const { changeSnapshotId, changedFiles } = payload;
  if (typeof changeSnapshotId !== 'string' || !changeSnapshotId || !Array.isArray(changedFiles)) return;
  const paths = new Set(changedFiles.flatMap((file) => typeof file === 'string' && file
    ? [file.replaceAll('\\', '/')] : []));
  const files = [...paths].map((path) => ({ path, added: 0, removed: 0, untracked: false }));
  if (files.length) return { kind: 'changes', snapshotId: changeSnapshotId, files };
}

export function updateChangeSnapshot(
  items: ReadonlyArray<{ kind: string } | ChangeSnapshot>,
  id: string,
  files: ChangeSnapshotFile[],
): ChangeSnapshot | undefined {
  const snapshot = items.find((item): item is ChangeSnapshot =>
    item.kind === 'changes' && 'snapshotId' in item && item.snapshotId === id);
  if (!snapshot || !files.length) return;
  const stats = new Map(files.map((file) => [file.path.replaceAll('\\', '/'), file]));
  snapshot.files = snapshot.files.map((file) => {
    const current = stats.get(file.path);
    return current ? { ...current, path: file.path } : file;
  });
  return snapshot;
}
