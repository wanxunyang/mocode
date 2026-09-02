import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMcpServers } from '../src/mcp/config.js';
import { McpClient } from '../src/mcp/client.js';
import { __testInjectClient, closeAllMcp, getMcpTools } from '../src/mcp/index.js';

const originalConfigPath = process.env.MCP_CONFIG_PATH;
const tempDir = mkdtempSync(join(tmpdir(), 'mocode-mcp-test-'));

after(async () => {
  await closeAllMcp();
  if (originalConfigPath === undefined) delete process.env.MCP_CONFIG_PATH;
  else process.env.MCP_CONFIG_PATH = originalConfigPath;
  rmSync(tempDir, { recursive: true, force: true });
});

test('readMcpServers: 解析每个服务的工具白名单和黑名单', () => {
  const configPath = join(tempDir, 'servers.json');
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      filtered: {
        command: 'mock-mcp',
        includeTools: ['read', 'write'],
        excludeTools: ['write'],
      },
      unfiltered: { command: 'mock-mcp' },
    },
  }));
  process.env.MCP_CONFIG_PATH = configPath;

  const { servers, warnings } = readMcpServers();
  assert.deepEqual(warnings, []);
  assert.deepEqual(servers.find((server) => server.name === 'filtered')?.includeTools, ['read', 'write']);
  assert.deepEqual(servers.find((server) => server.name === 'filtered')?.excludeTools, ['write']);
  assert.equal(servers.find((server) => server.name === 'unfiltered')?.includeTools, undefined);
});

test('getMcpTools: 白名单过滤工具，黑名单优先于白名单，未配置时保留全部', async () => {
  await closeAllMcp();
  const filtered = new McpClient('filtered', {
    name: 'filtered', transport: 'stdio', command: 'mock-mcp',
    includeTools: ['keep', 'blocked'], excludeTools: ['blocked'],
  });
  filtered.cachedTools = [
    { name: 'keep', inputSchema: { type: 'object' } },
    { name: 'blocked', inputSchema: { type: 'object' } },
    { name: 'other', inputSchema: { type: 'object' } },
  ];
  const unfiltered = new McpClient('unfiltered', {
    name: 'unfiltered', transport: 'stdio', command: 'mock-mcp',
  });
  unfiltered.cachedTools = [{ name: 'all', inputSchema: { type: 'object' } }];
  __testInjectClient(filtered);
  __testInjectClient(unfiltered);

  assert.deepEqual(getMcpTools().map((tool) => tool.name), [
    'mcp__filtered__keep',
    'mcp__unfiltered__all',
  ]);
});
