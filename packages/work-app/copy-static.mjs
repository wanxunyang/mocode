import { cpSync, rmSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const file of ['index.html', 'style.css', 'tokens.css']) {
  cpSync(path.join(root, 'src', 'renderer', file), path.join(root, 'dist', 'renderer', file));
}
// xterm 是 UMD 包:渲染层没有打包器,index.html 用 <script> 直接加载它。
// 只拷 UMD 产物 + 样式表(不拷 .map / 源码),约 300KB。
{
  const vendorDir = path.join(root, 'dist', 'renderer', 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  const assets = [
    ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
    ['@xterm/xterm/css/xterm.css', 'xterm.css'],
    ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ];
  const require = createRequire(import.meta.url);
  for (const [from, to] of assets) {
    try {
      copyFileSync(require.resolve(from), path.join(vendorDir, to));
    } catch (error) {
      console.warn(`[copy-static] 拷贝 ${from} 失败(终端面板将不可用):`, error?.message ?? error);
    }
  }
}
// 字体包(本地打包,离线可用)
cpSync(path.join(root, 'src', 'renderer', 'fonts'), path.join(root, 'dist', 'renderer', 'fonts'), { recursive: true });
// MiSans CJK(npm 包 misans,Apache-2.0):按字重拷贝 min.css + 分段 woff2。
// Geist/Fraunces 只有 latin 子集,中文此前全部回退到微软雅黑 —— MiSans 补上 CJK 正文/中黑/半粗三档。
try {
  const require = createRequire(import.meta.url);
  const misansLib = path.join(path.dirname(require.resolve('misans/package.json')), 'lib', 'Normal');
  const weights = ['Regular', 'Medium', 'Demibold', 'Bold'];
  const target = path.join(root, 'dist', 'renderer', 'fonts', 'misans');
  mkdirSync(target, { recursive: true });
  const files = readdirSync(misansLib);
  for (const weight of weights) {
    for (const file of files) {
      if (file.startsWith(`MiSans-${weight}.`) && (file.endsWith('.woff2') || file === `MiSans-${weight}.min.css`)) {
        copyFileSync(path.join(misansLib, file), path.join(target, file));
      }
    }
  }
} catch (error) {
  console.warn('[copy-static] 拷贝 MiSans 字体失败（未安装 misans 依赖？）：', error?.message ?? error);
}
// 应用图标(白底圆角正方形 + 像素兔)。源在 assets/,复制到 dist/assets/ 让 main.ts 通过 __dirname 找到。
// 任务栏 / Dock 上那个图标实际是 electron.exe 的资源,需 electron-builder 打包时配 win.icon 才能换。
if (existsSync(path.join(root, 'assets'))) {
  cpSync(path.join(root, 'assets'), path.join(root, 'dist', 'assets'), { recursive: true });
}
cpSync(
  path.join(root, 'dist-preload-tmp', 'renderer', 'preload.js'),
  path.join(root, 'dist', 'renderer', 'preload.js'),
);
// 某些环境下 fs.rmSync 被「安全删除」拦截、走回收站会失败；
// 这个 tmp 目录是构建中间产物，删除失败不影响产物，忽略即可。
try {
  rmSync(path.join(root, 'dist-preload-tmp'), { recursive: true, force: true });
} catch (error) {
  console.warn('[copy-static] 清理临时目录失败（可忽略）：', error?.message ?? error);
}

for (const file of [
  'pet.html',
  'pet.css',
  'pet.js',
  'pet-model.js',
  'pet-animals.js',
  'pet-rig.js',
  'pet-shapes.js',
  'pet-studio.js',
  'pet-characters.js',
  'pet-preload.cjs',
]) {
  cpSync(path.join(root, 'src', 'renderer', file), path.join(root, 'dist', 'renderer', file));
}
{
  const require = createRequire(import.meta.url);
  const threeBuild = path.dirname(require.resolve('three'));
  for (const file of ['three.module.js', 'three.core.js']) {
    cpSync(path.join(threeBuild, file), path.join(root, 'dist', 'renderer', 'vendor', file));
  }
}
