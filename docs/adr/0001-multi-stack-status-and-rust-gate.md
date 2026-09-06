# ADR-0001：多栈状态与 Rust 决策闸门

- **Status**：Accepted
- **Date**：2026-09-05
- **Owner**：`@wanxunyang`
- **Decision deadline**：2026-10-31

## Context

仓库同时维护生产 TypeScript CLI、两个 Electron 子包和约 7.8k 行 Rust TUI。Rust 已是受 Git 跟踪的完整 crate，但不进入 `mocode-ai` 默认构建、运行或发布链，也没有持续 Owner、收益指标和 CI。继续无期限扩张会摊薄单维护者精力。

## Decision

各栈状态以 [`stack-status.md`](../architecture/stack-status.md) 为事实源：TypeScript 为 Production，work-app 为 Incubating，pet-app 为 Optional，Rust 为 Experimental。

Rust 在 2026-10-31 必须二选一：

1. **晋升为独立 performance track**：全部满足下列条件；或
2. **归档**：未全部满足时执行归档，不以“继续观察”代替结论。

决策日前 Rust 只允许修复现有功能/安全语义、补 CI/测试/协议、收集指标及完成闸门直接要求。新增产品功能必须关联 Owner、milestone 和量化指标。

### 晋升条件（必须全部满足）

- 有持续 Owner、backup reviewer 和下一 milestone；
- Linux CI 的 fmt、clippy `-D warnings`、test、release build、无模型 Host smoke 全绿；
- Windows/macOS 至少各有一次可复现构建记录；
- Host 协议有 version/capabilities 与 TS/Rust 共享 fixture 或契约测试；
- 任意项目 cwd 的 sandbox 和 Host 定位正确，Host 缺失时检查明确失败；
- `/clear`、Plan/Auto 等安全控制面真实作用于 TS Runtime，而不是只改 Rust UI；
- 至少一项预注册指标达标：冷启动 P95 降低 30%、空闲内存降低 40%，或大输出渲染延迟降低 40%；
- 有发布、兼容和回退方案。

### 默认归档动作

创建带日期 tag 和 archive branch；从主分移除 Rust 代码及 CI；保留指标、失败原因、恢复命令和 ADR 结论。归档必须是独立人工评审 PR，不由 CI 自动删除。

## Alternatives considered

- **因为已有代码而直接晋升**：沉没成本不是产品收益证据，拒绝。
- **保留在主分但 CI 允许失败**：制造永久维护债，拒绝。
- **立即归档**：当前已有可验证的 TUI/Host 假设，给予一次固定期限收集证据。
- **把 Agent Runtime 迁到 Rust**：超出实验目标，且权限、session、tool 与 provider 语义尚在 TS，拒绝。

## Consequences

Rust 仍不承担生产承诺，但主分中的 Rust 必须持续可构建；CI 失败不能用 Experimental 身份豁免。到期前会限制与闸门无关的新功能。当前 primary owner 仍单一，必须通过 runbook、ADR 和招募 backup reviewer降低知识风险。

## Validation

- PR 页面显示独立 `Build / rust` check；
- `cargo fmt`、clippy、test、release build 和默认 `cargo run --example smoke` 全绿；
- 根 README 和 `rust/README.md` 明确 Experimental、非关键路径和截止日；
- 2026-10-31 有晋升或归档 ADR/状态更新。

## Rollback / Exit criteria

若 Rust CI 维护成本在截止日前已超过实验价值，可提前提交归档 PR。若有新证据需要延期，必须新 ADR 指定 Owner、证据和唯一一次不超过两周的截止日期。

## Status history

- 2026-09-05：Accepted — 建立多栈责任边界和 2026-10-31 强制决策闸门。
