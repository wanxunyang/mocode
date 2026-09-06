# Contributing to Mocode

感谢贡献。目标是让新贡献者只依靠仓库文档完成“安装 → 免费 eval → 小修复 → Draft PR”，不依赖维护者口头信息。

## 1. 先确认你在改哪一栈

- TypeScript CLI/Agent：Production，核心路径。
- `packages/work-app`：Incubating Electron 应用。
- `packages/pet-app`：Optional Electron 包。
- `rust/`：Experimental、非关键路径，受 2026-10-31 晋升/归档闸门约束。

状态、Owner 和退出条件见 [`docs/architecture/stack-status.md`](docs/architecture/stack-status.md)。`design-notes/` 是被忽略的本地草案，不是正式规范；架构原因见 [`docs/adr`](docs/adr/README.md)。

## 2. 环境与启动

根 CLI 支持 Node >=18；涉及 Electron 时使用 Node 22.12 或更新版本。需要 Git 和 npm；只有修改 `rust/` 时才需要 Rust 1.98、rustfmt、clippy 和平台 linker。

```powershell
git clone https://github.com/wanxunyang/mocode.git
Set-Location mocode
npm install
npm start
```

CI/干净复现使用 `npm ci`。`npm start` 通过 tsx 启动，无热更新，修改后重启。不要提交 `.env` 或真实 `.mocode/` 数据。

## 3. 免费接手演练

```powershell
npm run eval:smoke
npm run eval:coding:list
```

两者都不调用模型。然后选择一个小 issue，完成最小修改和 targeted validation，按 PR 模板创建 Draft PR。目标 90 分钟内完成；卡点请提交文档 issue，而不是让下一位再次口头询问。

## 4. TypeScript 约定

- 纯 ESM；TypeScript import 必须带 `.js` 扩展名。
- 新内置工具实现 `Tool`，在 `src/tools/builtins/index.ts` 注册并声明 capabilities。
- 面向用户文案必须同步 `zh-CN`/`en`。
- registry 工具数组使用原地 `splice` 重建；不要替换共享引用。
- `MEMORY_ENABLED` 决定启动时工具快照，运行中切换需要重启。
- 测试写在 `tests/*.test.ts`，由 test tsconfig 编译后运行，不用 tsx 直跑。
- 不把 lint/format 接入 `test` 或 `prepack`；它们是独立护栏。

常用验证：

```powershell
npm run typecheck
npm run lint:check
npm test
npm run build
npm run eval:smoke
```

先跑受影响的最小命令，再按风险扩大。涉及格式时运行 `npm run format:check`；不要为一个小改动无意格式化全仓。

## 5. Electron 边界

应用只能消费 package exports、自身资源和 `mocode-ai` 公开 bin manifest；禁止 import 根 `src/**`、`dist/**` 或固定层级拼 Host 路径。

```powershell
npm run build
npm run check:electron-boundary
npm run typecheck --workspace mocode-work
npm run build --workspace mocode-work
npm run typecheck --workspace mocode-pet-app
npm run build --workspace mocode-pet-app
npm run smoke:runtime-host
```

不在无头 CI 启动 Electron GUI。新增依赖必须写入对应 package，不能依赖根 workspace hoist。

## 6. Rust 实验区

先构建 TypeScript Host，再执行：

```powershell
npm run build
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked
cargo run --manifest-path rust/Cargo.toml --locked --example smoke
```

默认 smoke 不调用模型；`--full` 会调用真实模型，不是普通 PR 要求。Rust 新功能必须关联 ADR-0001 的 Owner、milestone 和指标。

## 7. Coding eval 成本规则

先读 [`coding-eval runbook`](docs/runbooks/coding-eval.md)。list/smoke 免费；单题、group、all 都可能产生模型成本。普通贡献者不运行全量、不使用 `--update-baseline`；需要付费验证时先在 PR 中说明范围与理由。

## 8. 分支与 PR

- 保持改动小而聚焦，不混入无关格式化或依赖升级。
- PR 写清 What、Why、Scope/non-goals、Risk、Rollback、实际运行的验证命令。
- 改 protocol/config/session/公开 API 或多栈状态时同步 ADR、stack-status 和消费者。
- 不提交 secret、token、私有 URL、真实 session/trace、日志、eval results、用户源码。
- 安全问题不要公开粘贴利用细节或凭证；使用 GitHub Security Advisory 私下报告。
- 不 force-push 主分支，不跳过 hooks；提交与发布由维护者明确授权。

## 9. 获取帮助

产品用法见 [`docs/usage.md`](docs/usage.md)，排障与发版见 [`docs/runbooks`](docs/runbooks/README.md)。提 issue 时使用模板并先脱敏；如果文档本身阻塞你，请把“无法独立完成的步骤”作为可复现 bug 报告。
