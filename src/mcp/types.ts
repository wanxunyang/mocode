export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';

export interface McpCommonServerSpec {
  /** 唯一 server 名称，会成为工具名 mcp__<server>__<tool> 的一部分。 */
  name: string;
  transport: McpTransportKind;
  disabled?: boolean;
  /** 单次 initialize / tools/list / tools/call 的超时，默认 30 秒。 */
  requestTimeoutMs?: number;
}

export interface McpStdioServerSpec extends McpCommonServerSpec {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpRemoteServerSpec extends McpCommonServerSpec {
  transport: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpRemoteServerSpec;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpConfigResult {
  servers: McpServerSpec[];
  warnings: string[];
}
