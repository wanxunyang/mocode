# Mocode 运行手册

Runbook 回答“现在该怎么操作”；架构原因和退出条件见 [ADR](../adr/README.md)。命令默认从仓库根目录执行，除非文中另有说明。

| 场景                                         | 手册                                                       | 适用人群             |
| -------------------------------------------- | ---------------------------------------------------------- | -------------------- |
| npm 发版、dry-run、错误版本处理              | [release.md](./release.md)                                 | maintainer           |
| TUI 假死、raw mode/备用屏残留、进程不退出    | [tui-freeze.md](./tui-freeze.md)                           | 用户、贡献者、维护者 |
| coding eval 成本分层、失败分类、baseline     | [coding-eval.md](./coding-eval.md)                         | 贡献者、评测维护者   |
| 2.0 为什么采用 protocol-first / Runtime 分层 | [ADR-0003](../adr/0003-protocol-first-runtime-layering.md) | 架构贡献者           |
| 多栈状态、Owner、Rust 闸门                   | [stack-status.md](../architecture/stack-status.md)         | 所有人               |

其它事实源：

- 产品操作：[`docs/usage.md`](../usage.md)
- coding fixtures 与参数：[`evals/README.md`](../../evals/README.md)
- 贡献流程：[`CONTRIBUTING.md`](../../CONTRIBUTING.md)

## 使用原则

1. 先复制记录环境和命令输出，再做有破坏性的处理。
2. 不上传 `.env`、`~/.mocode/config`、真实 session、私有源码、API key 或 Authorization header。
3. 不用 `killall node`、`taskkill /IM node.exe /F` 等无差别命令。
4. 文档命令与实现冲突时，以 package scripts/源码为准并提交文档修复。
5. 付费 eval、npm publish、tag/branch 删除等动作必须由明确授权的 maintainer 执行。
