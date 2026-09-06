# 技术栈状态与责任边界

本页是仓库中各技术栈状态、责任人与退出条件的事实源。状态变化必须通过 ADR 更新，不能只改 README 文案。

最后更新：2026-09-05
治理 Owner：[@wanxunyang](https://github.com/wanxunyang)

| 栈                             | 状态         | 关键路径 | 发布单元         | Owner         | CI check                           | 下一闸门                      |
| ------------------------------ | ------------ | -------- | ---------------- | ------------- | ---------------------------------- | ----------------------------- |
| TypeScript CLI / Agent Runtime | Production   | 是       | `mocode-ai`      | `@wanxunyang` | `Build / typescript`（Node 22.12） | 持续维护；公开 API 变更需 ADR |
| `packages/work-app`            | Incubating   | 否       | 当前 private     | `@wanxunyang` | `Build / electron`（Node 22.12）   | 2026-10-31 前确定独立打包方案 |
| `packages/pet-app`             | Optional     | 否       | `mocode-pet-app` | `@wanxunyang` | `Build / electron`（Node 22.12）   | 协议契约与 tarball smoke      |
| `rust/` Rust TUI               | Experimental | 否       | 当前不发布       | `@wanxunyang` | `Build / rust`（Rust 1.98）        | 2026-10-31 晋升或归档         |

> 当前四项仍由同一 primary owner 负责，这是已知 bus-factor 风险，不是理想终态。贡献流程和运行手册用于降低知识依赖；2026-10-31 治理复审时还应记录至少一名 backup reviewer，未找到 backup 不得被描述为“风险已消除”。

## 状态含义

- **Production**：承担发布、兼容性和故障响应承诺。
- **Optional**：独立可选交付物；失败不能破坏核心 CLI。
- **Incubating**：有明确 milestone，但尚无稳定性承诺。
- **Experimental**：只验证预先声明的假设，必须有决策截止日期。
- **Archived**：不在主分继续开发，只保留结论和恢复入口。

## 依赖方向

```text
@mocode/protocol  <- @mocode/runtime (Host client boundary)
@mocode/runtime   <- packages/work-app
mocode-ai public bin manifest <- @mocode/runtime host resolver
mocode-ai         <- packages/pet-app (optional executable only)
rust/mocode-tui   -> mocode-ai public agent-host protocol
```

`@mocode/runtime` 当前是 private workspace，只承载 Host launch、NDJSON framing 和进程生命周期；它不表示完整 2.0 Agent Runtime 已经物理拆包或公开发布。Electron 源码不得导入根 `src/**`、`dist/**`，也不得通过固定仓库层级拼 Host 路径。

## Rust 决策闸门

Rust TUI 明确不在生产关键路径，默认结果是：**2026-10-31 前未满足全部晋升条件即归档**。完整条件、允许改动范围和归档步骤见 [ADR-0001](../adr/0001-multi-stack-status-and-rust-gate.md)。

在截止日前允许：修复现有功能/安全语义、补 CI/测试/协议、收集性能数据、完成闸门直接要求的最小差距。没有 owner、milestone 和量化指标的新产品功能不得合并。

## 维护规则

1. 新增技术栈或发布单元前，先补状态、Owner、CI 和退出条件。
2. Experimental job 不使用 `continue-on-error`；主分若不值得保持可构建，应归档而不是容忍长期红灯。
3. Owner 或 milestone 变化必须同步本页和对应 ADR。
4. 应用只依赖 package exports、协议和公开 bin manifest，不依赖另一个 package 的源码或内部构建布局。
