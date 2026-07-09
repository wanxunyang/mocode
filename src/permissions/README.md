# 工具权限系统 (src/permissions/)

基于 `Tool.risk` 字段在执行前拦截确认的安全屏障。

## 风险等级

| 等级 | 含义 | 行为 | 典型工具 |
|------|------|------|----------|
| `safe` | 只读 / 无副作用 | 直接放行 | `read_file`, `glob`, `grep`, `codegraph`, `web_search`, `web_fetch`, `use_skill`, `ask_human`, `switch_mode`, `drop_context`, `memory_search`, `memory_list`, `todolist` |
| `confirm` | 有副作用 | 首次弹确认面板,同工具同会话缓存(后续不再弹) | `edit_file`, `write_file`, `memory_save`, `memory_update`, `memory_forget` |
| `dangerous` | 高风险 | 每次执行都弹确认面板(不缓存) | `run_command`, `task` |

## 流程

```
executeTool(name, args)
  → enforceSandbox()    // 沙箱:路径越界拒绝
  → checkPermission()   // 权限:按 risk 弹确认面板
  → recordMutation()    // 回滚:写前快照
  → tool.execute()      // 实际执行
```

权限检查在 sandbox 之后(非法路径不弹确认框)、recordMutation 之前(拒绝时不记快照,避免回滚链空洞)。

## 确认面板

复用 `promptIntervention`(与 `ask_human` 同 UI):

- **confirm 级**:
  - 标题: `确认执行: ${tool.name}`
  - 选项: `["允许", "本次会话始终允许此工具", "以后不再询问此工具", "拒绝"]`
  - 选"本次会话始终允许" → 加入会话缓存,后续同工具不再弹
  - 选"以后不再询问" → 写入 `~/.mocode/permissions.json`,跨会话生效

- **dangerous 级**:
  - 标题: `⚠ 高风险操作: ${tool.name}`
  - 选项: `["确认执行", "以后不再询问此工具", "拒绝"]`
  - 不缓存(每次命令内容不同,风险不可预测),但提供"以后不再询问"让用户明确授权

非 TTY 环境(管道 / CI):`promptIntervention` 自动选第一项(允许)并打 stderr 日志,不阻塞。

## 三层允许机制

优先级从高到低:

1. **永久允许**(`permanentAllow`):跨会话持久化到 `~/.mocode/permissions.json`,用户选"以后不再询问此工具"时写入,下次启动自动加载
2. **会话允许**(`approvedTools`):本次进程内缓存,confirm 级工具选"本次会话始终允许此工具"时加入,进程退出即失效
3. **面板询问**:以上两层都没命中时,弹面板让用户决策

用户可随时选"以后不再询问",即使是 dangerous 级(如 `run_command`),尊重用户明确授权。

## 配置

总开关 `config.permissionEnabled`(默认 `true`)。

关闭:
- 环境变量: `MOCODE_PERMISSION=false`
- 或 `config.permissionEnabled = false`

关闭时所有工具直接放行,零交互,向后兼容旧行为。

**持久化文件**: `~/.mocode/permissions.json`,存储永久允许的工具列表:
```json
{
  "allowForever": ["edit_file", "write_file", "run_command"]
}
```

## 撤销授权

调用 `revokePermanentAllow(toolName)` 撤销某个工具的永久授权(从磁盘移除),下次执行时重新弹面板。`listPermanentAllow()` 列出当前所有永久授权的工具名。供未来 `/permissions` 管理命令使用。

## 检查时机

权限检查在 `agent/core.ts` 的工具执行循环中,**渲染 ● 头之前**进行:

1. 解析工具参数
2. **弹确认面板**(confirm/dangerous 级)
3. 用户拒绝 → 只渲染拒绝结果,不渲染 ● 头
4. 用户放行 → 渲染 ● 头 → 启动 spinner → `executeTool()` → 渲染结果

这样用户体验是**先问再执行**,而非执行完再问。

`registry.ts` 的 `executeTool()` 不再做权限检查(已移到 core.ts 提前做),只负责沙箱检查、回滚快照、调用 `tool.execute()`。

## 子 agent 继承

子 agent(`task` 工具派生)调 `executeTool()` 同样走权限检查。因同进程共享模块级变量,子 agent 继承父级已批准的 confirm 缓存(避免子 agent 重复弹面板)。

## 与 plan 模式的关系

plan 模式已通过 `PLAN_DISABLED_TOOLS` 在 schema 层剔除写工具(模型看不到)。权限系统是第二道防线:即使 backstop 失效(后端幻觉调了禁用工具),权限检查也会拦截。两者互补不冲突。
