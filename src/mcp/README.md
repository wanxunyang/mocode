# MCP

Mocode 内置 MCP client，可将 server 发现的工具注册进普通 agent 工具表，名称格式：

```text
mcp__<server>__<tool>
```

## 支持的连接方式

- `stdio`：启动本地命令，通过 Content-Length JSON-RPC 通讯。
- `streamable-http`：现代远程 MCP，支持 HTTP JSON 响应与 SSE 响应、`Mcp-Session-Id` 会话头。
- `sse`：旧版 HTTP+SSE，读取 `endpoint` event 后通过 POST 发 JSON-RPC。

配置放进 `MCP_SERVERS`（JSON）或 `MCP_CONFIG_PATH` 指向的 JSON 文件。二者可同时使用，环境变量中同名 server 覆盖文件：

```json
{
  "mcpServers": {
    "files": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

`transport` 缺省时有 `command` 的配置按 `stdio` 处理，否则按 `streamable-http` 处理。支持 `disabled`、`requestTimeoutMs`、stdio 的 `cwd`/`env`，和远程的 `headers`。字符串中的 `${NAME}` 会从环境变量展开。

启动时，无法连接的单个 server 只会显示告警，不会妨碍其余 server 或 REPL。退出时所有客户端和本地子进程均会关闭。

> 安全：MCP 没有可靠的副作用标注。本地命令和所有远程 MCP 工具统一标为 `dangerous`，每次调用均经现有权限面板确认；plan 模式不暴露 MCP 工具。令牌请使用环境变量引用，避免写入仓库。
