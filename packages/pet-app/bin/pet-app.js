#!/usr/bin/env node
// mocode-pet-app 可执行入口:用 electron 运行 dist/main.js。
// mocode 主包的 src/pet/bridge.ts 通过 require.resolve('mocode-pet-app/bin/pet-app.js')
// 定位本文件路径,再以 electron 可执行文件 spawn 它(而不是直接 node 运行——
// electron 的 main 进程需要 electron 自带的运行时,不能用纯 node 跑)。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainScript = path.join(__dirname, '..', 'dist', 'main.js');

const child = spawn(String(electronPath), [mainScript], {
  stdio: 'ignore',
  detached: true,
  windowsHide: true,
});
child.unref();
