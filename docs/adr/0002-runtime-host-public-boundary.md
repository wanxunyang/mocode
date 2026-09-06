# ADR-0002：Electron 与 Runtime/Host 公共边界

- **Status**：Accepted
- **Date**：2026-09-05
- **Owner**：`@wanxunyang`
- **Decision deadline**：N/A

## Context

`packages/work-app` 曾按固定 monorepo 层级启动根 `dist/host/stdio.js`，并自行实现 spawn、NDJSON buffering 和 ready/exit 生命周期。源码没有直接 import 根 `src`，但目录约定同样会在独立安装或打包后失效。完整 Agent Runtime 还不适合为满足包名而整体搬迁。

## Decision

建立 private 第一阶段 `@mocode/runtime` workspace，只稳定以下应用边界：

- `HostCommand` / `HostEnvelope` 类型；
- `mocode-ai` 公开 `mocode-agent-host` bin 的 manifest 定位；
- 系统 Node/Electron fallback launch spec；
- 单 Host 子进程、NDJSON framing、ready/send/stop 与 observational events。

work-app 只从 `@mocode/runtime/host` 消费该边界，不导入根 `src/**`、内部 `dist/**`，也不按固定仓库层级拼路径。源码工作区只从 runtime 模块自身位置向上验证 `mocode-ai` 根与 `packages/runtime` manifest 后获取公开 bin，不扫描应用启动 cwd；安装态优先正常 package resolution；显式 `MOCODE_HOST_PATH` 仅作为部署覆盖。

该 package 目前 private、版本 `0.1.0`，不宣称完整 2.0 Agent Runtime 已公开发布。应用重启策略和产品状态仍由 work-app 持有。

## Alternatives considered

- **把 `src/runtime` 直接 re-export 到新包**：发布后父目录不存在，且泄漏内部类型，拒绝。
- **Electron 进程内直接运行 Agent Runtime**：改变流式网络栈、cwd、崩溃隔离和取消语义，拒绝。
- **继续允许 `../../../dist`**：无法独立安装，拒绝。
- **只用 tsconfig paths**：掩盖发布产物缺失且 Node 不改写 specifier，拒绝。

## Consequences

新增一个必须先构建的 workspace 和 package export；Host client 生命周期成为可复用代码。work-app 显式声明 runtime/dotenv 依赖，不再依赖 workspace hoist。完整 Runtime 拆包、work-app installer 和公开 semver 仍需后续 ADR。

## Validation

- `npm run check:electron-boundary`；
- `npm run build --workspace @mocode/runtime`；
- 两个 Electron 包 typecheck/build；
- `npm run smoke:runtime-host` 从 package export 定位公开 bin 并收到 `runtime_ready`；
- CI 中独立 Electron job 全绿。

## Rollback / Exit criteria

若 client 边界无法保持 Host wire 兼容，可让 work-app 暂时使用显式 `MOCODE_HOST_PATH`，但不得恢复根 `src/dist` 深依赖。完整 Runtime package 由新 ADR 扩展本决策。

## Status history

- 2026-09-05：Accepted — 采用最小 Host client package，而非伪物理拆分 Agent core。
