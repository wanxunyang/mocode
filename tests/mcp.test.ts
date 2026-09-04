import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMcpServers } from '../src/mcp/config.js';
import { isMcpEnabled, updateMcpConfig } from '../src/config/index.js';
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
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        filtered: {
          command: 'mock-mcp',
          includeTools: ['read', 'write'],
          excludeTools: ['write'],
        },
        unfiltered: { command: 'mock-mcp' },
      },
    }),
  );
  process.env.MCP_CONFIG_PATH = configPath;

  // 共享进程 + 宿主机可能预设 MOCODE_MCP_ENABLED=false(此时 readMcpServers 早退返回空),
  // 保存并临时删除该变量,确保本测试在"启用"语义下解析白名单,跑完恢复。
  const prevEnabled = process.env.MOCODE_MCP_ENABLED;
  delete process.env.MOCODE_MCP_ENABLED;
  try {
    const { servers, warnings } = readMcpServers();
    assert.deepEqual(warnings, []);
    assert.deepEqual(servers.find((server) => server.name === 'filtered')?.includeTools, ['read', 'write']);
    assert.deepEqual(servers.find((server) => server.name === 'filtered')?.excludeTools, ['write']);
    assert.equal(servers.find((server) => server.name === 'unfiltered')?.includeTools, undefined);
  } finally {
    if (prevEnabled === undefined) delete process.env.MOCODE_MCP_ENABLED;
    else process.env.MOCODE_MCP_ENABLED = prevEnabled;
  }
});

test('readMcpServers: MOCODE_MCP_ENABLED=false 时不读取任何 MCP 配置', () => {
  const originalEnabled = process.env.MOCODE_MCP_ENABLED;
  const originalPath = process.env.MCP_CONFIG_PATH;
  try {
    process.env.MOCODE_MCP_ENABLED = 'false';
    process.env.MCP_CONFIG_PATH = join(tempDir, 'does-not-exist.json');

    assert.deepEqual(readMcpServers(), { servers: [], warnings: [] });
  } finally {
    if (originalEnabled === undefined) delete process.env.MOCODE_MCP_ENABLED;
    else process.env.MOCODE_MCP_ENABLED = originalEnabled;
    if (originalPath === undefined) delete process.env.MCP_CONFIG_PATH;
    else process.env.MCP_CONFIG_PATH = originalPath;
  }
});

test('updateMcpConfig: 同步内存状态与环境变量', () => {
  const wasEnabled = isMcpEnabled();
  const originalEnv = process.env.MOCODE_MCP_ENABLED;
  try {
    updateMcpConfig(false);
    assert.equal(isMcpEnabled(), false);
    assert.equal(process.env.MOCODE_MCP_ENABLED, 'false');

    updateMcpConfig(true);
    assert.equal(isMcpEnabled(), true);
    assert.equal(process.env.MOCODE_MCP_ENABLED, 'true');
  } finally {
    updateMcpConfig(wasEnabled);
    if (originalEnv === undefined) delete process.env.MOCODE_MCP_ENABLED;
    else process.env.MOCODE_MCP_ENABLED = originalEnv;
  }
});

test('getMcpTools: 白名单过滤工具，黑名单优先于白名单，未配置时保留全部', async () => {
  await closeAllMcp();
  const filtered = new McpClient('filtered', {
    name: 'filtered',
    transport: 'stdio',
    command: 'mock-mcp',
    includeTools: ['keep', 'blocked'],
    excludeTools: ['blocked'],
  });
  filtered.cachedTools = [
    { name: 'keep', inputSchema: { type: 'object' } },
    { name: 'blocked', inputSchema: { type: 'object' } },
    { name: 'other', inputSchema: { type: 'object' } },
  ];
  const unfiltered = new McpClient('unfiltered', {
    name: 'unfiltered',
    transport: 'stdio',
    command: 'mock-mcp',
  });
  unfiltered.cachedTools = [{ name: 'all', inputSchema: { type: 'object' } }];
  __testInjectClient(filtered);
  __testInjectClient(unfiltered);

  assert.deepEqual(
    getMcpTools().map((tool) => tool.name),
    ['mcp__filtered__keep', 'mcp__unfiltered__all'],
  );
});
