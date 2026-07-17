import type { Tool, ToolOutcome } from '../tools/types.js';
import { readMcpServers } from './config.js';
import { McpClient } from './client.js';

const clients = new Map<string, McpClient>();
let startupWarnings: string[] = [];

export interface McpInitializeReport {
  connected: string[];
  warnings: string[];
}

/** 连接所有已配置 server；单个连接失败不阻断 CLI，其余 server 仍可用。 */
export async function initializeAllMcp(): Promise<McpInitializeReport> {
  await closeAllMcp();
  const { servers, warnings } = readMcpServers();
  startupWarnings = [...warnings];
  const connected: string[] = [];
  for (const spec of servers) {
    const client = new McpClient(spec.name, spec);
    try {
      await client.initialize();
      clients.set(spec.name, client);
      connected.push(spec.name);
    } catch (error) {
      await client.close().catch(() => undefined);
      startupWarnings.push(`MCP ${spec.name} 连接失败: ${formatError(error)}`);
    }
  }
  return { connected, warnings: [...startupWarnings] };
}

/** 把已发现的远程工具包装为内部 Tool；所有 MCP 工具默认 dangerous，逐次经权限面板确认。 */
export function getMcpTools(): Tool[] {
  const usedNames = new Set<string>();
  const tools: Tool[] = [];
  for (const client of clients.values()) {
    const serverPart = sanitizeName(client.name);
    for (const remote of client.cachedTools) {
      const localName = `mcp__${serverPart}__${sanitizeName(remote.name)}`;
      if (usedNames.has(localName)) {
        startupWarnings.push(`MCP ${client.name} 的工具 ${remote.name} 名称冲突，已忽略`);
        continue;
      }
      usedNames.add(localName);
      tools.push({
        name: localName,
        description: `[MCP: ${client.name}] ${remote.description || `调用 ${remote.name}`}`,
        parameters: remote.inputSchema && typeof remote.inputSchema === 'object'
          ? remote.inputSchema
          : { type: 'object', properties: {} },
        // MCP 协议没有可靠副作用声明：未知能力、workspace 串行、每次确认。
        risk: 'dangerous',
        capabilities: {
          effect: 'unknown',
          concurrency: 'serial',
          retry: 'never',
          resources: () => ['workspace'],
          supportsAbort: true,
        },
        execute: async (args, ctx): Promise<ToolOutcome> => {
          const result = await client.callTool(remote.name, args, ctx?.signal);
          const output = formatToolResult(result);
          return result.isError
            ? { status: 'error', code: 'MCP_ERROR', retryable: false, output }
            : { status: 'success', code: 'OK', retryable: false, output };
        },
      });
    }
  }
  return tools;
}

export async function closeAllMcp(): Promise<void> {
  const active = Array.from(clients.values());
  clients.clear();
  await Promise.allSettled(active.map((client) => client.close()));
}

export function getMcpWarnings(): string[] { return [...startupWarnings]; }

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

function formatToolResult(result: { content: unknown[]; structuredContent?: unknown; isError?: boolean }): string {
  const parts: string[] = [];
  for (const item of result.content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      parts.push(safeJson(item));
      continue;
    }
    const content = item as Record<string, unknown>;
    if (content.type === 'text' && typeof content.text === 'string') {
      parts.push(content.text);
    } else if (content.type === 'image') {
      parts.push(`[MCP image: ${typeof content.mimeType === 'string' ? content.mimeType : 'unknown'}，已省略二进制数据]`);
    } else if (content.type === 'resource_link') {
      parts.push(`[MCP resource: ${String(content.name ?? content.uri ?? 'unknown')}]`);
    } else if (content.type === 'resource' && content.resource && typeof content.resource === 'object') {
      const resource = content.resource as Record<string, unknown>;
      parts.push(typeof resource.text === 'string' ? resource.text : `[MCP resource: ${String(resource.uri ?? 'unknown')}]`);
    } else {
      parts.push(safeJson(content));
    }
  }
  if (result.structuredContent !== undefined) parts.push(`\nstructuredContent:\n${safeJson(result.structuredContent)}`);
  const body = parts.join('\n').trim() || '(MCP 工具未返回内容)';
  return result.isError ? `MCP 工具报告错误:\n${body}` : body;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 仅供 MCP smoke test 注入已握手的假 client；生产路径必须走 initializeAllMcp。 */
export function __testInjectClient(client: McpClient): void {
  clients.set(client.name, client);
}
