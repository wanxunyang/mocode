import path from 'node:path';
import type { TaskContract } from './types.js';

function normalizePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.endsWith('/') ? `${normalized}**` : normalized;
}

function globRegex(pattern: string): RegExp {
  const source = normalizePattern(pattern);
  let regex = '^';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') {
          index += 1;
          regex += '(?:.*/)?';
        } else regex += '.*';
      } else regex += '[^/]*';
    } else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
  }
  return new RegExp(`${regex}$`);
}

function normalizeChangedPath(file: string): string | null {
  const normalized = path.posix.normalize(file.replaceAll('\\', '/').replace(/^\.\//, ''));
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** 通配符之前的静态前缀；`src/a/**` → `src/a`，`**\/*` → ``。 */
function staticPrefix(pattern: string): string {
  const normalized = normalizePattern(pattern);
  const wildcard = normalized.search(/[*?]/);
  const head = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
  return head.replace(/\/+$/, '');
}

function prefixOverlaps(a: string, b: string): boolean {
  if (a === b || a === '' || b === '') return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 两个写任务的改动范围是否可能相交。用于并发调度：相交就串行，避免同一批文件被两路同时改。
 *
 * 这是**保守近似**：只看 allow 模式的静态前缀，宁可误判相交（多串行一个任务），
 * 也不要在并发写里丢改动。
 */
export function scopeOverlaps(a: TaskContract, b: TaskContract): boolean {
  for (const left of a.scope.allow) {
    for (const right of b.scope.allow) {
      if (prefixOverlaps(staticPrefix(left), staticPrefix(right))) return true;
    }
  }
  return false;
}

export function validateChangedFiles(contract: TaskContract, changedFiles: readonly string[]): string[] {
  const allow = contract.scope.allow.map(globRegex);
  const deny = contract.scope.deny.map(globRegex);
  const errors: string[] = [];
  for (const raw of changedFiles) {
    const file = normalizeChangedPath(raw);
    if (!file) {
      errors.push(`Invalid changed-file path: ${raw}`);
      continue;
    }
    if (deny.some((pattern) => pattern.test(file))) {
      errors.push(`Changed file is denied by task scope: ${file}`);
    } else if (!allow.some((pattern) => pattern.test(file))) {
      errors.push(`Changed file is outside the allowed task scope: ${file}`);
    }
  }
  return errors;
}
