# mcp/

Model Context Protocol 客户端:挂载外部 MCP server 暴露的工具 / 资源。

**状态**:未实现(空骨架)。

**接入点**:启动时按配置连接 server,把其工具并入 `src/tools/registry.ts` 的 `tools` 数组,使 agent 能像调内置工具一样调外部工具。

**计划**:
- 读 MCP server 配置(stdio / SSE 传输)。
- 拉取 server 暴露的 tool schema,转成内部 `Tool` 接口。
- 工具调用经 MCP 协议转发到 server,结果回灌。
- 与 `permissions/` 协作:外部工具同样过权限校验。
