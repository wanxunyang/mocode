import fs from 'node:fs';
import path from 'node:path';
import type { McpConfigResult, McpServerSpec, McpTransportKind } from './types.js';

/**
 * 加载 MCP server 定义。支持 MCP_CONFIG_PATH 指向的 JSON 文件，以及 MCP_SERVERS JSON 环境变量；
 * 后者按 server name 覆盖前者，便于把 token 仅放在本机环境变量中。
 *
 * JSON 格式兼容常见的 { "mcpServers": { name: { command/url/... } } }，也允许直接 server map。
 */
export function readMcpServers(): McpConfigResult {
  // 总开关必须早于任何配置读取，以便即使用户级 MCP 配置存在也能快速启动。
  if (process.env.MOCODE_MCP_ENABLED === 'false') return { servers: [], warnings: [] };

  const warnings: string[] = [];
  const servers = new Map<string, McpServerSpec>();
  const fromFile = process.env.MCP_CONFIG_PATH;
  if (fromFile) {
    try {
      const target = path.resolve(process.cwd(), expandEnv(fromFile));
      mergeServerMap(JSON.parse(fs.readFileSync(target, 'utf8')), servers, warnings, target);
    } catch (error) {
      warnings.push(`无法读取 MCP_CONFIG_PATH: ${formatError(error)}`);
    }
  }
  if (process.env.MCP_SERVERS) {
    try {
      mergeServerMap(JSON.parse(process.env.MCP_SERVERS), servers, warnings, 'MCP_SERVERS');
    } catch (error) {
      warnings.push(`MCP_SERVERS 不是合法 JSON: ${formatError(error)}`);
    }
  }
  return { servers: Array.from(servers.values()).filter((server) => !server.disabled), warnings };
}

function mergeServerMap(
  raw: unknown,
  target: Map<string, McpServerSpec>,
  warnings: string[],
  source: string,
): void {
  const root = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : raw;
  if (Array.isArray(root)) {
    for (const entry of root) {
      if (!isRecord(entry) || typeof entry.name !== 'string') {
        warnings.push(`${source} 中的 MCP 数组项必须含 name`);
        continue;
      }
      const parsed = parseServer(entry.name, entry, source, warnings);
      if (parsed) target.set(parsed.name, parsed);
    }
    return;
  }
  if (!isRecord(root)) {
    warnings.push(`${source} 必须是 MCP server 对象或 { mcpServers: ... }`);
    return;
  }
  for (const [name, entry] of Object.entries(root)) {
    const parsed = parseServer(name, entry, source, warnings);
    if (parsed) target.set(parsed.name, parsed);
  }
}

function parseServer(name: string, raw: unknown, source: string, warnings: string[]): McpServerSpec | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || !isRecord(raw)) {
    warnings.push(`${source} 中的 MCP server 名称或配置无效: ${name}`);
    return null;
  }
  const transport = normalizeTransport(raw.transport ?? raw.type, raw);
  const requestTimeoutMs = positiveNumber(raw.requestTimeoutMs ?? raw.timeoutMs);
  const includeTools = stringArray(raw.includeTools);
  const excludeTools = stringArray(raw.excludeTools);
  const common = {
    name,
    transport,
    disabled: raw.disabled === true,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    ...(includeTools ? { includeTools } : {}),
    ...(excludeTools ? { excludeTools } : {}),
  };
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      warnings.push(`${source}.${name} (stdio) 缺少 command`);
      return null;
    }
    return {
      ...common,
      transport,
      command: expandEnv(raw.command),
      args: stringArray(raw.args),
      env: stringRecord(raw.env),
      cwd: typeof raw.cwd === 'string' ? path.resolve(process.cwd(), expandEnv(raw.cwd)) : undefined,
    };
  }
  if (typeof raw.url !== 'string') {
    warnings.push(`${source}.${name} (${transport}) 缺少 url`);
    return null;
  }
  try {
    const url = new URL(expandEnv(raw.url));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只允许 http 或 https URL');
    return { ...common, transport, url: url.toString(), headers: stringRecord(raw.headers) };
  } catch (error) {
    warnings.push(`${source}.${name} 的远程 URL 无效: ${formatError(error)}`);
    return null;
  }
}

function normalizeTransport(value: unknown, raw: Record<string, unknown>): McpTransportKind {
  if (value === 'sse') return 'sse';
  if (value === 'streamable-http' || value === 'http' || value === 'streamableHttp') return 'streamable-http';
  return typeof raw.command === 'string' ? 'stdio' : 'streamable-http';
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.map(expandEnv)
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = expandEnv(item);
  }
  return result;
}

/** 展开 ${NAME}；缺失变量保留为空，避免把宿主环境变量字面量送往远端。 */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => process.env[key] ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
