// 内容哈希的**唯一实现**。叶子模块:只依赖 node:crypto 与本地类型。
//
// 为什么单独拆出来:哈希口径必须全局一致(read_file 的 artifact hash、changeset 的
// expected_hash、记忆锚点 R2 的 stale 判定都靠它对齐),但 `changeset/index.ts` 会
// 引入 sandbox/rollback/tools.resource-lock——`memory/store.ts` 是叶模块,不能为了
// 拿一个 sha256 就把整条工具链依赖拖进来。所以哈希下沉到本文件,changeset/index.ts
// 改为 re-export,两边字面上是同一个函数对象,口径不可能漂移。
import { createHash } from 'node:crypto';
import type { ContentHash } from './types.js';

export type { ContentHash };

export function contentHash(content: Buffer | string): ContentHash {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export function normalizeContentHash(value: string): ContentHash | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.startsWith('sha256:') ? normalized.slice(7) : normalized;
  return /^[a-f0-9]{64}$/.test(hex) ? `sha256:${hex}` : null;
}
