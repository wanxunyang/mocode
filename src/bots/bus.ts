// D1 持久 Bot 消息总线：bot 之间（以及 main 用户与 bot 之间）跨时间的异步消息。
// 与同步 sub-agent 的区别：收发双方不必同时在线——消息落盘，worker bot 之后由
// scheduler / bg 唤起时拉 inbox 处理并回结果。
//
// 存储（<sandboxRoot>/.mocode/bus/）：
//   <msgId>.json            一条消息（只创建、永不改写 → 并发安全，无丢消息）
//   <receiver>.read.json    该接收者已读消息 id 数组（低频 RMW，原子写）
//
// 身份用 AsyncLocalStorage 注入（runAsIdentity）：headless --bot X 时整段运行为 X，
// 其内派生的 sub-agent 自动继承；缺省身份为 'main'（用户主会话）。

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { getSandboxRoot } from '../sandbox/index.js';

export const DEFAULT_IDENTITY = 'main';

const identityStorage = new AsyncLocalStorage<string>();

/** 在指定 bot 身份下执行 fn；子 agent / 工具内 getIdentity() 都返回该身份。 */
export function runAsIdentity<T>(identity: string, fn: () => Promise<T>): Promise<T> {
  return identityStorage.run(identity, fn);
}

export function getIdentity(): string {
  return identityStorage.getStore() ?? DEFAULT_IDENTITY;
}

export interface BusMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  inReplyTo?: string;
}

function busRoot(): string {
  return path.join(getSandboxRoot() ?? process.cwd(), '.mocode', 'bus');
}

function messagePath(id: string): string {
  return path.join(busRoot(), `${id}.json`);
}
function readMarkerPath(receiver: string): string {
  // receiver 只允许安全文件名段，杜绝路径穿越。
  const safe = receiver.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(busRoot(), `${safe}.read.json`);
}

export function sendMessage(input: { from?: string; to: string; body: string; inReplyTo?: string }): BusMessage {
  const to = input.to.trim();
  const body = input.body;
  if (!to) throw new Error('message recipient (to) is required');
  if (!body) throw new Error('message body is required');
  const msg: BusMessage = {
    id: `msg-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    from: (input.from ?? getIdentity()).trim() || DEFAULT_IDENTITY,
    to,
    body,
    createdAt: new Date().toISOString(),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
  };
  fs.mkdirSync(busRoot(), { recursive: true });
  const target = messagePath(msg.id);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(msg, null, 2)}\n`, 'utf8');
  fs.renameSync(`${target}.tmp`, target);
  return msg;
}

function getReadSet(receiver: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(readMarkerPath(receiver), 'utf8')) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveReadSet(receiver: string, set: Set<string>): void {
  const target = readMarkerPath(receiver);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify([...set], null, 2)}\n`, 'utf8');
  fs.renameSync(`${target}.tmp`, target);
}

function allMessages(): BusMessage[] {
  let files: string[];
  try {
    files = fs.readdirSync(busRoot());
  } catch {
    return [];
  }
  const out: BusMessage[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.read.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(busRoot(), f), 'utf8')) as BusMessage);
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** 某身份的未读收件箱。 */
export function inbox(identity = getIdentity()): BusMessage[] {
  const read = getReadSet(identity);
  return allMessages().filter((m) => m.to === identity && !read.has(m.id));
}

/** 标记消息已读（ack）。只能 ack 发给自己的消息。 */
export function markRead(ids: string[], identity = getIdentity()): string[] {
  const read = getReadSet(identity);
  const mine = new Set(
    allMessages()
      .filter((m) => m.to === identity)
      .map((m) => m.id),
  );
  const marked: string[] = [];
  for (const id of ids) {
    if (mine.has(id) && !read.has(id)) {
      read.add(id);
      marked.push(id);
    }
  }
  if (marked.length) saveReadSet(identity, read);
  return marked;
}

/** 与某身份相关的全部消息（发出或收到），按时间排序。 */
export function messageHistory(identity = getIdentity()): BusMessage[] {
  return allMessages().filter((m) => m.from === identity || m.to === identity);
}
