import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInitialRun, makeEvent, reduceEvent } from './state.js';
import type { NewOrchestrationEvent, OrchestrationDefinition, OrchestrationEvent, OrchestrationRun } from './types.js';

const SNAPSHOT = 'snapshot.json';
const EVENTS = 'events.jsonl';
const CANCEL = 'cancel.requested';

export function createOrchestrationId(now = new Date()): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomBytes(2).toString('hex')}`
  );
}

export function orchestrationRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.mocode', 'orchestrations');
}

function parseEvents(file: string): { events: OrchestrationEvent[]; repairAt?: number } {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [] };
    throw error;
  }

  const events: OrchestrationEvent[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const nextOffset = offset + Buffer.byteLength(line, 'utf8') + 1;
    if (line.trim()) {
      try {
        events.push(JSON.parse(line) as OrchestrationEvent);
      } catch (error) {
        const isIncompleteTail = nextOffset > Buffer.byteLength(content, 'utf8') && !content.endsWith('\n');
        if (isIncompleteTail) return { events, repairAt: offset };
        throw error;
      }
    }
    offset = nextOffset;
  }
  return { events };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ControllerLease {
  release(): void;
}

export class OrchestrationStore {
  readonly directory: string;
  private state: OrchestrationRun;

  private constructor(directory: string, state: OrchestrationRun) {
    this.directory = directory;
    this.state = state;
  }

  static create(
    workspaceRoot: string,
    definition: OrchestrationDefinition,
    id = createOrchestrationId(),
  ): OrchestrationStore {
    const directory = path.join(orchestrationRoot(workspaceRoot), id);
    if (fs.existsSync(directory)) throw new Error(`Orchestration ${id} already exists.`);
    fs.mkdirSync(directory, { recursive: true });
    const initial = createInitialRun(id, path.resolve(workspaceRoot), definition);
    const created: OrchestrationEvent = {
      schemaVersion: initial.schemaVersion,
      sequence: 1,
      timestamp: initial.createdAt,
      type: 'run.created',
      data: { run: initial },
    };
    const state = reduceEvent(undefined, created);
    fs.writeFileSync(path.join(directory, EVENTS), `${JSON.stringify(created)}\n`, 'utf8');
    const store = new OrchestrationStore(directory, state);
    store.writeSnapshot();
    return store;
  }

  static load(workspaceRoot: string, id: string): OrchestrationStore {
    const directory = path.join(orchestrationRoot(workspaceRoot), path.basename(id));
    const eventsPath = path.join(directory, EVENTS);
    const parsed = parseEvents(eventsPath);
    const events = parsed.events;
    if (events.length === 0) throw new Error(`Orchestration ${id} was not found or has no event history.`);
    if (parsed.repairAt !== undefined) fs.truncateSync(eventsPath, parsed.repairAt);
    // JSONL 是唯一事实源；snapshot 仅是派生缓存，合法 JSON 也不能绕过事件归约。
    // load 保持只读：损坏的 snapshot 会在下一次 append 时自然被重写。
    let state: OrchestrationRun | undefined;
    for (const event of events) state = reduceEvent(state, event);
    if (!state) throw new Error(`Orchestration ${id} could not be rebuilt.`);
    if (state.id !== id) throw new Error(`Orchestration id mismatch: expected ${id}, found ${state.id}.`);
    return new OrchestrationStore(directory, state);
  }

  get current(): OrchestrationRun {
    return structuredClone(this.state);
  }

  append(input: NewOrchestrationEvent): OrchestrationEvent {
    const eventsPath = path.join(this.directory, EVENTS);
    const content = fs.readFileSync(eventsPath, 'utf8');
    const parsed = parseEvents(eventsPath);
    if (parsed.repairAt !== undefined) throw new Error('Cannot append while the event log has an incomplete tail.');
    const diskSequence = parsed.events.at(-1)?.sequence;
    if (diskSequence !== this.state.sequence) {
      throw new Error(`Orchestration state is stale: memory=${this.state.sequence}, disk=${diskSequence ?? 'empty'}.`);
    }
    const event = makeEvent(this.state, input);
    const next = reduceEvent(this.state, event);
    const fd = fs.openSync(eventsPath, 'a');
    try {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      fs.writeSync(fd, `${separator}${JSON.stringify(event)}\n`, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.state = next;
    this.writeSnapshot();
    return event;
  }

  acquireControllerLease(): ControllerLease {
    const target = path.join(this.directory, 'controller.lock');
    const token = randomBytes(16).toString('hex');
    const acquire = (): void => {
      const fd = fs.openSync(target, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    };
    try {
      acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: unknown } = {};
      try {
        owner = JSON.parse(fs.readFileSync(target, 'utf8')) as { pid?: unknown };
      } catch {
        // A malformed lock is not safe to steal automatically.
      }
      if (typeof owner.pid !== 'number' || processIsAlive(owner.pid)) {
        throw new Error(`Orchestration ${this.state.id} already has an active controller.`);
      }
      fs.unlinkSync(target);
      acquire();
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(target, 'utf8')) as { token?: unknown };
          if (current.token === token) fs.unlinkSync(target);
        } catch {
          // Never remove a lock that cannot be proven to belong to this controller.
        }
      },
    };
  }

  requestCancellation(): void {
    const target = path.join(this.directory, CANCEL);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${new Date().toISOString()}\n`, 'utf8');
    fs.renameSync(tmp, target);
  }

  cancellationMarkerExists(): boolean {
    return fs.existsSync(path.join(this.directory, CANCEL));
  }

  artifactPath(...parts: string[]): string {
    const root = path.resolve(this.directory, 'artifacts');
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error('Artifact path escapes the orchestration directory.');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }

  private writeSnapshot(): void {
    const target = path.join(this.directory, SNAPSHOT);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  }
}

export function listOrchestrations(workspaceRoot: string): OrchestrationRun[] {
  const root = orchestrationRoot(workspaceRoot);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const runs: OrchestrationRun[] = [];
  for (const name of names) {
    try {
      runs.push(OrchestrationStore.load(workspaceRoot, name).current);
    } catch {
      // A damaged run remains on disk for manual recovery but does not break the list command.
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
