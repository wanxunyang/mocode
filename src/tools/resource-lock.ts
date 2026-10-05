import { normalize } from 'node:path';
import { jailResolve } from '../sandbox/index.js';
import type { ToolCapabilities, ToolEffect } from './types.js';

export type ResourceLockMode = 'read' | 'write';

export interface ResourceLockRequest {
  key: string;
  scope: 'resource' | 'workspace';
  mode: ResourceLockMode;
}

type Release = () => void;

interface Claim {
  requests: ResourceLockRequest[];
}

interface Waiter extends Claim {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  const error = new Error('Resource lock acquisition aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * 两个锁请求是否冲突。
 *
 * 冲突矩阵(workspace 锁 vs 资源锁):
 *
 * |左\右| workspace-write | resource-read | resource-write |
 * |------|-----------------|--------------|----------------|
 * | ws-write |冲突(命令互斥) | **不冲突** | 冲突(防命令与 Agent 写同文件) |
 * | ws-read  | 不冲突 | 不冲突 | 冲突 |
 * | res-read | 不冲突 | 同 key 不冲突 | 冲突 |
 *
 * **唯一放行的是「workspace 写锁 vs 资源读锁」**(表中加粗那格)。这条正是
 * 「一条 run_command 期间所有 read_file 排队」的根因:run_command 声明
 * `resources: () => ['workspace']` + `effect: 'process'` → resolveResourceLockRequests
 * 恒返回 workspace 写锁(resource-lock.ts 的 workspaceWrite()),而 read_file 持
 * `file:<path>` 读锁,旧判据「任一 write 即冲突」把两者判成互斥 —— 一条 60s 的
 * `npm test` 会让同 step 的所有 read_file 全部阻塞排队,并行探查退化为串行。
 *
 * 放行的依据与 glob/grep 的 `resources: () => []` 豁免同源(见 builtins/index.ts 的
 * CAPABILITIES 注释「读枚举容忍命令执行期间的瞬时不一致」):run_command **不通过
 * ChangeSet 写文件**,它的工作区写入对 read_file 不构成事务性冲突 —— read_file 读的是
 * 单个已知文件,与命令的写入在绝大多数情况下无关。若命令恰好在改这个文件,读到不一致
 * 内容的后果由既有机制兜住:read_file 的输出带 content hash 记入 artifact,后续
 * refreshArtifactFreshness / invalidateArtifacts 会把它标 stale。
 *
 * **保持冲突的边界(不可放宽)**:
 * - workspace-write vs resource-write:run_command 与 write_file/edit_file 改同一文件
 *   必须互斥,否则 ChangeSet 的 read-modify-write 会读到命令的半成品。
 * - workspace-write vs workspace-write:命令之间互斥(文件句柄 / 端口 / 环境变量共享)。
 */
function requestConflicts(a: ResourceLockRequest, b: ResourceLockRequest): boolean {
  if (a.scope === 'workspace' || b.scope === 'workspace') {
    // 同为 workspace 锁(实践中只有 write):沿用「任一 write 即冲突」。
    if (a.scope === 'workspace' && b.scope === 'workspace') {
      return a.mode === 'write' || b.mode === 'write';
    }
    const workspaceReq = a.scope === 'workspace' ? a : b;
    const resourceReq = a.scope === 'workspace' ? b : a;
    // 放行格:workspace 写锁(命令)与资源读锁(读单个已知文件)不冲突。
    if (workspaceReq.mode === 'write' && resourceReq.mode === 'read') return false;
    return workspaceReq.mode === 'write' || resourceReq.mode === 'write';
  }
  return a.key === b.key && (a.mode === 'write' || b.mode === 'write');
}

function claimsConflict(a: Claim, b: Claim): boolean {
  return a.requests.some((left) => b.requests.some((right) => requestConflicts(left, right)));
}

/** Fair, abort-aware multi-resource read/write lock shared by all agent loops. */
export class ResourceLockManager {
  private readonly active = new Set<Claim>();
  private readonly waiting: Waiter[] = [];

  acquire(requests: ResourceLockRequest[], signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError());
    const normalized = dedupeRequests(requests);
    if (normalized.length === 0) return Promise.resolve(() => undefined);

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { requests: normalized, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort!);
          reject(abortError());
          this.dispatch();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
      this.dispatch();
    });
  }

  async withLocks<T>(
    requests: ResourceLockRequest[],
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(requests, signal);
    try {
      return await action();
    } finally {
      release();
    }
  }

  private dispatch(): void {
    const blocked: Waiter[] = [];
    for (let index = 0; index < this.waiting.length; ) {
      const waiter = this.waiting[index];
      const conflictsActive = [...this.active].some((claim) => claimsConflict(waiter, claim));
      const conflictsEarlier = blocked.some((claim) => claimsConflict(waiter, claim));
      if (conflictsActive || conflictsEarlier) {
        blocked.push(waiter);
        index++;
        continue;
      }

      this.waiting.splice(index, 1);
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
      const claim: Claim = { requests: waiter.requests };
      this.active.add(claim);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(claim);
        this.dispatch();
      });
    }
  }
}

function dedupeRequests(requests: ResourceLockRequest[]): ResourceLockRequest[] {
  const byKey = new Map<string, ResourceLockRequest>();
  for (const request of requests) {
    const identity = `${request.scope}:${request.key}`;
    const existing = byKey.get(identity);
    if (!existing || request.mode === 'write') byKey.set(identity, request);
  }
  return [...byKey.values()].sort((a, b) => `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`));
}

/** Stable lock identity: sandbox realpath plus Windows case/separator normalization. */
export function canonicalFileResourceKey(input: string): string {
  let canonical = normalize(jailResolve(input));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return `file:${canonical}`;
}

function modeFor(effect: ToolEffect): ResourceLockMode {
  return effect === 'read' ? 'read' : 'write';
}

const workspaceWrite = (): ResourceLockRequest[] => [
  {
    key: 'workspace',
    scope: 'workspace',
    mode: 'write',
  },
];

/** Resolve declared logical resources. Any ambiguity fails closed to a workspace write lock. */
export function resolveResourceLockRequests(
  capabilities: ToolCapabilities,
  args: Record<string, unknown>,
): ResourceLockRequest[] {
  if (capabilities.delegatesResourceLocks) return [];
  if (capabilities.effect === 'process' || capabilities.effect === 'unknown') {
    return workspaceWrite();
  }

  let keys: string[];
  try {
    keys = capabilities.resources?.(args) ?? [];
  } catch {
    return workspaceWrite();
  }
  if (keys.length === 0) {
    // 显式声明「无资源」(glob/grep 等读枚举、网络只读)即不锁:
    // 读枚举容忍命令执行期间的瞬时不一致,换取 workspace 写锁期间的读不被压制。
    if (capabilities.effect === 'network' || capabilities.effect === 'read') return [];
    return workspaceWrite();
  }

  const mode = modeFor(capabilities.effect);
  const requests: ResourceLockRequest[] = [];
  try {
    for (const key of keys) {
      if (typeof key !== 'string' || key.trim().length === 0) return workspaceWrite();
      if (key === 'workspace') {
        requests.push({ key, scope: 'workspace', mode });
      } else if (key.startsWith('file:') && key.length > 5) {
        requests.push({ key: canonicalFileResourceKey(key.slice(5)), scope: 'resource', mode });
      } else {
        // Non-file logical resources are still lockable, but never treated as filesystem paths.
        requests.push({ key, scope: 'resource', mode });
      }
    }
  } catch {
    return workspaceWrite();
  }
  return dedupeRequests(requests);
}

export const toolResourceLockManager = new ResourceLockManager();
