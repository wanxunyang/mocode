# 工具权限系统

权限检查位于沙箱检查之后、工具执行和回滚快照之前。`safe` 工具直接执行，`confirm` 与
`dangerous` 工具必须命中已有授权或由用户明确批准。

## 授权模型

`PermissionGrant` 由以下字段组成：

- `tool`：工具名；
- `fingerprint`：`run_command` 使用精确命令哈希，文件工具使用资源路径哈希，其他工具使用稳定参数哈希；
- `scope`：`once`、`session` 或 `project`；
- `projectRoot`：项目级授权所属的规范化项目根目录。

授权匹配必须同时满足工具名、指纹和作用域边界。批准 `npm test` 不会放行 `npm publish`，
批准一个文件资源也不会按整个工具放行。确认面板提供单次、当前会话、当前项目永久授权，以及
“以后不再询问此工具”。最后一项是用户主动选择的全局工具级授权：它会在所有项目中放行该工具
的所有后续参数，包括标记为高风险的操作，因此选择前仍会显示高风险警告。

永久授权以版本 3 格式写入 `~/.mocode/permissions.json`：`grants` 保存项目资源授权，
`alwaysAllowTools` 保存全局工具级授权。版本 2 的资源授权会继续加载；旧格式
`allowForever: ["run_command"]` 不会迁移，防止升级后在未重新确认的情况下恢复整工具授权。

## 非交互环境

管道和 CI 中默认拒绝所有需要确认的操作，不会选择菜单第一个“允许”项。确实需要无人值守执行时，
由操作者显式设置 `MOCODE_PERMISSION_NON_INTERACTIVE_ALLOW=true`。总开关
`MOCODE_PERMISSION=false` 仍可关闭权限系统，但等同于明确选择完全放行。

## 撤销与查询

`listPermanentGrants()` 返回项目级授权；`revokePermanentAllow(tool, fingerprint?)` 可按工具或
具体指纹撤销。兼容 API `listPermanentAllow()` 仅返回拥有项目授权的工具名。
