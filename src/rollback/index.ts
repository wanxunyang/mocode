import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config/index.js';
import type { ChatMessage } from '../llm/index.js';
import { RollbackStore } from './store.js';
import type {
  CurrentTurnMutationState,
  PathMutationCapture,
  RollbackPlan,
  Turn,
  WorkspaceMutationCapture,
} from './store.js';

export { RollbackStore } from './store.js';
export type {
  CurrentTurnMutationState,
  FileChange,
  PathMutationCapture,
  RollbackPlan,
  RollbackRootProvider,
  RollbackRootSource,
  Snapshot,
  SnapshotKind,
  StoredState,
  Turn,
  WorkspaceMutationCapture,
} from './store.js';

/** 默认兼容实例继续动态读取 process.cwd() 与 config.sessionDir。 */
export const defaultRollbackStore = new RollbackStore(
  () => process.cwd(),
  () => config.sessionDir,
);

const activeRollbackStores = new AsyncLocalStorage<RollbackStore>();

/** 当前异步 runtime 树使用的 rollback store；无 scope 时回退默认兼容实例。 */
export function getActiveRollbackStore(): RollbackStore {
  return activeRollbackStores.getStore() ?? defaultRollbackStore;
}

/** 将旧 rollback 函数 API 绑定到指定实例，使未显式注入的内部调用也保持 runtime-local。 */
export function withRollbackStore<T>(store: RollbackStore, run: () => Promise<T>): Promise<T> {
  return activeRollbackStores.run(store, run);
}

export function beginTurn(firstLine: string): number {
  return getActiveRollbackStore().beginTurn(firstLine);
}

export function getCurrentTurnId(): number {
  return getActiveRollbackStore().getCurrentTurnId();
}

export function beginPathMutation(path: string): PathMutationCapture {
  return getActiveRollbackStore().beginPathMutation(path);
}

export function endPathMutation(capture: PathMutationCapture, op: string): void {
  getActiveRollbackStore().endPathMutation(capture, op);
}

export async function beginWorkspaceMutation(): Promise<WorkspaceMutationCapture> {
  return getActiveRollbackStore().beginWorkspaceMutation();
}

export async function endWorkspaceMutation(capture: WorkspaceMutationCapture, op: string): Promise<void> {
  await getActiveRollbackStore().endWorkspaceMutation(capture, op);
}

export function getCurrentTurnMutationState(): CurrentTurnMutationState {
  return getActiveRollbackStore().getCurrentTurnMutationState();
}

export function listTurns(): Turn[] {
  return getActiveRollbackStore().listTurns();
}

export function planRollback(n: number, history: ChatMessage[]): RollbackPlan {
  return getActiveRollbackStore().planRollback(n, history);
}

export function applyRollback(
  plan: RollbackPlan,
  history: ChatMessage[],
  revertPaths: Set<string>,
): { deletedMsgs: number; revertedFiles: string[]; conflictedFiles: string[] } {
  return getActiveRollbackStore().applyRollback(plan, history, revertPaths);
}

export function pruneAfterCompaction(history: ChatMessage[]): void {
  getActiveRollbackStore().pruneAfterCompaction(history);
}

export function resetState(): void {
  getActiveRollbackStore().resetState();
}

export function rebuildFromHistory(history: ChatMessage[]): void {
  getActiveRollbackStore().rebuildFromHistory(history);
}

export function persistSnapshots(id: string): void {
  getActiveRollbackStore().persistSnapshots(id);
}

export function loadSnapshots(id: string): boolean {
  return getActiveRollbackStore().loadSnapshots(id);
}
