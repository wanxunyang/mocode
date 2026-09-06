# Architecture Decision Records

ADR 记录“为什么这样设计”；操作步骤放在 [`docs/runbooks`](../runbooks/README.md)。`design-notes/` 是本地草案区且被 Git 忽略，不是正式决策事实源。

## 生命周期

状态只允许：`Proposed`、`Accepted`、`Superseded`、`Rejected`、`Archived`。

1. 从 [`template.md`](./template.md) 复制下一个四位编号。
2. Proposed ADR 必须有 Owner、日期、验证和退出条件。
3. 评审通过后改为 Accepted，并记录 status history。
4. 新决策取代旧决策时，新 ADR 链接旧 ADR，旧 ADR 标为 Superseded；不要重写历史。
5. 实验到期未通过时标为 Archived 或 Rejected，并记录恢复入口。

## 索引

| ADR                                                | 状态     | Owner         | 内容                                    |
| -------------------------------------------------- | -------- | ------------- | --------------------------------------- |
| [0001](./0001-multi-stack-status-and-rust-gate.md) | Accepted | `@wanxunyang` | 多栈状态与 Rust 决策闸门                |
| [0002](./0002-runtime-host-public-boundary.md)     | Accepted | `@wanxunyang` | Electron 与 Runtime/Host 公共边界       |
| [0003](./0003-protocol-first-runtime-layering.md)  | Accepted | `@wanxunyang` | 2.0 协议优先与 Runtime/Application 分层 |
