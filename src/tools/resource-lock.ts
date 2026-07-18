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

function requestConflicts(a: ResourceLockRequest, b: ResourceLockRequest): boolean {
  if (a.scope === 'workspace' || b.scope === 'workspace') {
    if (a.mode === 'write' || b.mode === 'write') return true;
    return false;
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
    for (let index = 0; index < this.waiting.length;) {
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
  return [...byKey.values()].sort((a, b) =>
    `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`)
  );
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

const workspaceWrite = (): ResourceLockRequest[] => [{
  key: 'workspace',
  scope: 'workspace',
  mode: 'write',
}];

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
    return capabilities.effect === 'network' ? [] : workspaceWrite();
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
