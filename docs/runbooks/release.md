# 发版 Runbook

适用于根包 `mocode-ai`。`@mocode/protocol`、`@mocode/runtime` 和 `mocode-work` 当前 private，不发布；`mocode-pet-app` 是独立版本和独立发布单元，不随根包自动升级。

## 1. 前置与风险

- 在干净分支执行，确认 npm 账号、registry、2FA/OTP 和发布权限；不要把 token/OTP 写入 shell history、文档或 issue。
- 根包版本来自 `package.json`，`package-lock.json` 顶层也必须同步。
- 发布不可通过 Git revert 撤回。错误版本优先 deprecate、修复 patch 或调整 dist-tag，不承诺 npm unpublish。
- `npm publish`、Git tag 和 GitHub Release 都是高影响操作；dry-run 全绿后仍需人工确认。

```powershell
node --version
npm --version
npm whoami
npm config get registry
git status --short
```

Node 最低支持 18；维护/CI 推荐 22.12。必须确认工作区没有无关改动。

## 2. 可复制的发布门槛

从仓库根执行：

```powershell
npm ci
npm run build
npm run typecheck
npm run lint:check
npm test
npm run eval:smoke
npm run check:electron-boundary
npm run format:check
npm pack --dry-run
```

`eval:smoke` 不调用模型；不要在普通发布 dry-run 中运行付费 `eval:coding --task all`。`format:check` 失败必须修复或在发布 PR 中明确记录经批准的例外，不能静默忽略。

涉及 Electron/Rust 时额外执行 CI 中对应矩阵命令；见 [stack status](../architecture/stack-status.md)。

## 3. 版本更新

仓库没有封装的 `npm run release`。使用 npm 标准命令，但先不创建 tag：

```powershell
npm version X.Y.Z --no-git-tag-version
git diff -- package.json package-lock.json
```

不要联动修改 private protocol/runtime/work-app 或独立 pet-app 的版本，除非本次明确包含该发布单元。版本修改后重跑第 2 节全部门槛。

## 4. Tarball 检查与临时安装

先查看文件清单。`npm pack` 会通过 `prepack` 在完整源码仓库中构建；registry/tarball 安装阶段只消费已打包的 `dist`，不得再次运行 monorepo build：

```powershell
npm pack --dry-run
npm pack --json
```

根 tarball 应包含必要 package 元数据以及 `dist/`、`bin/`、`README.md`，不应包含 `.env`、`.mocode/`、session、trace、eval results 或日志。

在临时目录安装刚生成的 `.tgz`，不要覆盖全局开发安装：

```powershell
$smoke = Join-Path $env:TEMP "mocode-release-smoke"
New-Item -ItemType Directory -Force $smoke | Out-Null
npm install --prefix $smoke "F:\path\to\mocode-ai-X.Y.Z.tgz"
node "$smoke\node_modules\mocode-ai\bin\mocode.js" --resume
$hostBin = Join-Path $smoke "node_modules\mocode-ai\bin\mocode-agent-host.js"
'' | node $hostBin
```

POSIX 可用 `mktemp -d` 和对应路径。裸 `--resume` 无需模型配置，会列 session 或提示为空后退出。Host stdin 关闭 smoke 应正常退出。

还要用隔离 prefix 覆盖全局安装语义，防止 npm 的 global 配置被生命周期脚本误当成 workspace 构建上下文：

```powershell
$globalSmoke = Join-Path $env:TEMP "mocode-global-install-smoke"
npm install --global --prefix $globalSmoke "F:\path\to\mocode-ai-X.Y.Z.tgz"
& "$globalSmoke\mocode.cmd" --resume
```

此安装不得出现 `Workspaces not supported for global packages`，也不应执行 `npm run build`。

删除本地 `.tgz` 和临时目录前先保留 dry-run 输出到发布 PR；不要提交 tarball。

## 5. 正式发布

再次确认版本和 tarball hash后，由有权限的 maintainer 执行：

```powershell
npm publish --access public
npm view mocode-ai@X.Y.Z version dist-tags --registry=https://registry.npmjs.org/
```

随后在另一个空临时目录安装精确版本 `mocode-ai@X.Y.Z`，重复 `--resume` 与 Host EOF smoke。npm 验证成功后再创建 `vX.Y.Z` tag 和 GitHub Release，避免 Git 与 registry 状态分裂。禁止 force-push tag。

## 6. pet-app 独立发布

只有 release 明确包含桌宠时才执行：

```powershell
npm run typecheck --workspace mocode-pet-app
npm run build --workspace mocode-pet-app
npm pack --dry-run --workspace mocode-pet-app
```

`mocode-pet-app` 与根包不锁步；单独审查它的版本、依赖、tarball 与 Electron 启动 smoke。work-app 当前 private，不发布。

## 7. 错误版本与回退

```powershell
npm deprecate mocode-ai@X.Y.Z "说明影响和建议版本"
npm dist-tag add mocode-ai@GOOD_VERSION latest
```

若代码缺陷可修，发布新的 patch；在 Release notes 记录影响范围、检测方式和回退版本。不要删除用户 session/config。Windows 全局升级遇到 `EPERM`/`EBUSY` 时先退出所有相关 mocode 进程再重试；用户主动升级日志位于 `%USERPROFILE%\.mocode\upgrade.log`。

## 8. Dry-run 记录

发布 PR 必须附：Node/npm 版本、全部命令结果、tarball 文件清单、临时安装 smoke、版本 diff、风险与回退。未实际执行的步骤写明“未执行”，不得打勾伪装完成。
