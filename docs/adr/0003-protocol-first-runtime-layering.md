# ADR-0003：2.0 协议优先与 Runtime/Application 分层

- **Status**：Accepted
- **Date**：2026-09-05
- **Owner**：`@wanxunyang`
- **Decision deadline**：N/A

## Context

历史上 TUI、stdio、eval 直接装配 agent loop，session/rollback 依赖进程单例，模型消息绑定 OpenAI shape。一次性搬目录或先发布大量 package 只会把耦合换位置。Rust/Electron 的出现进一步要求稳定协议和生命周期边界。

## Decision

2.0 演进遵循：

1. protocol-first：跨进程/包 DTO 不携带 UI、OpenAI client 或文件实现；
2. Runtime owns lifecycle：run、cancel、compact、session、rollback、close 由 Runtime facade 管理；
3. state/DI 显式实例化：同进程 Runtime 不共享可变 session/rollback/tool/model 状态；
4. Application 只消费 events、commands 和公共 API，TUI/Electron/Rust 不直接装配 core 内部；
5. side effects 继续经过 capability、permission、sandbox、resource lock、trace 和 rollback；
6. 先逻辑边界和兼容 adapter，再按依赖方向物理拆包。

当前已落地 protocol persistence contracts、实例 stores、core 职责拆分和统一 Runtime facade；`@mocode/runtime` 第一阶段只增加 Host client。durable suspension、公开 Agent Runtime package、graph/planner 和完整 provider-neutral message contract仍是后续工作。

## Alternatives considered

- 一次性重写或整体搬包：回归面不可控，拒绝。
- 继续由各应用直接调用 `runAgentCore`：生命周期和隔离无法统一，拒绝。
- 继续以 OpenAI Chat shape 作为所有协议：阻碍 provider 和 durable state，拒绝。
- 因 Rust TUI 存在而迁移 Agent Runtime：缺乏收益证据且安全语义未闭环，拒绝。

## Consequences

会保留一段时间的 compatibility wrappers，并增加 contract/adapter 数量；换来可逐步验证的依赖方向。物理拆包前仍需收窄泄漏的内部类型。事件总线只用于观察，不替代同步 AgentHooks。

## Validation

- runtime isolation 与 agent-core 字节级回归测试；
- CLI、stdio、eval、Electron Host smoke；
- protocol package 无业务层依赖；
- coding eval smoke 和三栈 CI。

## Rollback / Exit criteria

若某物理拆包无法维持行为，可回退到兼容 facade，但不得恢复模块级共享状态或应用对 core 的直接装配。新协议必须保留版本迁移或兼容 adapter。

## Status history

- 2026-09-05：Accepted — 把已验证的渐进路线提升为正式架构决策。
