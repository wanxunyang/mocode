# work-app 打包 Runbook

适用于 `packages/work-app`（Electron 桌面端 `mocode-work`）。它与根包 `mocode-ai` 的 npm 发布是两条独立链路：根包发 registry，本包出**安装包**。

## 1. 为什么是安装包而不是 npm 包

`work-app` 是壳，启动时要拉起外部 agent host 子进程（`packages/runtime/src/host-client.ts` 的 `resolveHostPath`）。发 npm 包的话用户还得自己装 `mocode-ai`，否则开箱即报 `Cannot locate mocode-agent-host`；而它的受众是终端用户，要求先装 Node 再 `npm i -g` 是劝退级门槛。安装包把 host 一起 bundle，双击即用。

## 2. 目录分层（打包后的形状）

```
MoCode Work/
├─ MoCode Work.exe                      ← Electron 运行时，同时兼任 host 的 node（ELECTRON_RUN_AS_NODE=1）
└─ resources/
   ├─ app.asar                          ← work-app/dist（main + renderer + 字体，~10MB）
   └─ mocode-ai/                        ← extraResources，asar 之外，~24MB
      ├─ bin/mocode-agent-host.js
      ├─ dist/                          ← mocode host 产物
      ├─ package.json
      └─ node_modules/                  ← 生产依赖闭包（68 个包）
```

**host 必须在 asar 之外**：它是被 spawn 的子进程，asar 内文件在 Windows 上没有真实路径，spawn 必失败。所以走 `extraResources` 而不是 `files`。

## 3. 一键打包

```powershell
cd F:\mocode
npm run build:electron              # 根包 + protocol/runtime + 两个 Electron 子包
npm run pack:win --workspace mocode-work
```

`pack:win` = `build` → `stage:host` → `electron-builder --win`。产物在 `packages/work-app/release/`：

- `MoCode Work-1.0.0-setup.exe`（NSIS 安装向导，约 116MB）
- `MoCode Work-1.0.0-setup.exe.blockmap`（增量更新用）
- `win-unpacked/`（免安装形态，便于调试）

想先看目录结构不打包安装器：`npm run pack:dir --workspace mocode-work`。

## 4. stage:host 在做什么

`packages/work-app/scripts/stage-host.mjs` 在打包前把 host 摆成 `build/mocode-ai/`：

1. 拷 `bin/` + `dist/` + `package.json`（三者缺一 host 起不来）
2. 从 `mocode-ai` 的 dependencies 出发算**依赖闭包**（Node 解析规则逐级向上找 `node_modules`），输出 68 个包
3. 排除 `playwright`（换 `playwright-core`）、`misans`（43MB，字体已拷进 renderer）、构建期依赖
4. 缺任何一个依赖直接**抛错中断**——不能在用户机器上才暴露

产出 `STAGED-DEPENDENCIES.json` 记账，便于核对与排查缺包。

## 5. 浏览器能力的降级链（关键设计）

桌面版**不分发 Chromium**（省 ~150MB + 免 `playwright install`）。`src/runtime/browser-manager.ts` 按序尝试：

| 档 | driver | 可执行文件 |
|---|---|---|
| 1 | `playwright` / `playwright-core` | 自带 Chromium |
| 2 | 同上 | 系统 Edge（`channel: 'msedge'`） |
| 3 | 同上 | 系统 Chrome（`channel: 'chrome'`） |

driver 解析也是两档（全量 `playwright` → `playwright-core`），CLI 版有全量包时优先用它，桌面版只有 core。任一档成功即返回；全失败才抛错并给出「装 Chrome/Edge 或 `npx playwright install chromium`」指引。

Windows 自带 Edge，命中率接近 100%，用户无感。**验证方法**：把 `PLAYWRIGHT_BROWSERS_PATH` 指向空目录，若还能启动就证明走的是系统浏览器。

## 6. 图标

`assets/` 下三份，都已生成好，改品牌时从 `icon.png` 重新派生：

```powershell
D:\miniconda\envs\ft\python.exe -c "from PIL import Image; im=Image.open('packages/work-app/assets/icon.png').convert('RGBA'); im.save('packages/work-app/assets/icon.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
```

- `icon.ico` — Windows，**必须多尺寸**（单 256×256 会让任务栏/文件列表小图标糊）
- `icon.icns` — macOS
- `icons/*.png` — Linux 多尺寸目录

## 7. 联网下载项与镜像

electron-builder 需要四样：electron zip、`winCodeSign`、`nsis`、`7zip`。国内直连 GitHub 常超时，设镜像：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

缓存位置 `%LOCALAPPDATA%\electron-builder\Cache`、`%LOCALAPPDATA%\electron\Cache`。

**已知坑：winCodeSign 解压失败**（非管理员无法创建符号链接，报 `Cannot create symbolic link ... libcrypto.dylib`）。它只影响包内 macOS 的 dylib，Windows 换图标靠的是同包里的 `rcedit-x64.exe`，那份通常是解压成功的。补法：把 `winCodeSign/<随机数字>/` 复制成 `winCodeSign/winCodeSign-2.6.0/`，electron-builder 就会认这个缓存目录。

## 8. 跨平台限制

**electron-builder 不能在 Windows 上产出 macOS 包**。三平台配置都已写在 `package.json` 的 `build` 字段里，但实际产出要各平台本机执行：

```powershell
npm run pack:win   --workspace mocode-work    # Windows 本机
npm run pack:mac   --workspace mocode-work    # 需 macOS
npm run pack:linux --workspace mocode-work    # 需 Linux / WSL
```

mac 分发还需要签名与公证（Apple Developer 证书），否则用户首次打开会被 Gatekeeper 拦。这一块配置（`mac.hardenedRuntime`、`notarize`）需拿到证书后再补。

## 9. 打包后必查

```powershell
# 1. 目录分层对不对
dir packages\work-app\release\win-unpacked\resources
#    期望：app.asar + mocode-ai

# 2. host 入口齐不齐
dir packages\work-app\release\win-unpacked\resources\mocode-ai\bin
#    期望：mocode-agent-host.js + mocode.js

# 3. 用户不装 Node 也能跑：把 exe 当 node 用
$env:ELECTRON_RUN_AS_NODE = "1"
& "packages\work-app\release\win-unpacked\MoCode Work.exe" -v
#    期望：打印 node 版本号

# 4. host 能被拉起（复刻启动链）
& "packages\work-app\release\win-unpacked\MoCode Work.exe" `
  "packages\work-app\release\win-unpacked\resources\mocode-ai\bin\mocode-agent-host.js"
#    期望：stdout 出一行 {"type":"event","event":"runtime_ready",...}，stderr 为空
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

**验完记得清掉 `ELECTRON_RUN_AS_NODE`** —— 它泄漏进 shell 会让后续 electron 调用被当成 node 跑，报错信息还长得像「模块找不到」。

## 10. 环境相关的坑

- **打包产物删不掉**（`EBUSY` / `WinError 32` / 回收站失败）：本机有 safe-delete 钩子把删除路由到回收站且 fail-closed，加上 Windows 安全软件对新文件的短暂句柄，会让单次 `rmtree` 失败。带退避重试可解；必要时 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 关掉钩子。文件本身没被锁（`r+` 能打开）——别去杀进程。
- **release 目录残留会打断重跑**：第二次打包时 app-builder 清空 `win-unpacked` 会撞上残留锁。换 `-c.directories.output=<新目录>` 或先清干净。
- **`signAndEditExecutable: false`** 只在无法补齐 winCodeSign 缓存时作为临时退路；关掉后 exe 图标不会换（仍是默认 Electron 图标）。正常应保持开启。