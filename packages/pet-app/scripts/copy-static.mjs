// 构建后置步骤:tsc 只编译 .ts,不会把 renderer 目录下的静态文件(index.html/style.css)
// 和 assets/(mascot.svg)复制到 dist/。用 fs.cpSync(Node >=18 内置,无需额外依赖)做跨跨平台拷贝。
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const rendererFiles = ['index.html', 'style.css'];
for (const f of rendererFiles) {
  cpSync(path.join(root, 'src', 'renderer', f), path.join(root, 'dist', 'renderer', f));
}

cpSync(path.join(root, 'assets'), path.join(root, 'dist', 'assets'), { recursive: true });

// preload.js 单独以 CommonJS 编译到临时目录(见 tsconfig.preload.json 的注释:Electron 预加载脚本
// 按 CJS 解析,不受 package.json "type":"module" 影响;直接输出到 dist/ 会连带覆盖 protocol.js,
// 与 main.js 的 ESM import 冲突)。这里只取 preload.js 复制进 dist/renderer/,随后清理临时目录。
cpSync(
  path.join(root, 'dist-preload-tmp', 'renderer', 'preload.js'),
  path.join(root, 'dist', 'renderer', 'preload.js'),
);
rmSync(path.join(root, 'dist-preload-tmp'), { recursive: true, force: true });

// === 开发期同步:把 dist/ 同步复制到 ../../node_modules/mocode-pet-app/dist/ ===
// pet-app 子包在 npm 安装场景下,electron 进程是从 node_modules 下的 dist/main.js 启动的
// (bin/pet-app.js 用 __dirname 定位,即全局安装或 mocode/node_modules 下的副本)。
// 开发者直接编辑 packages/pet-app/src + `npm run build` 不会自动同步到 electron 实际加载的
// 位置,导致改了代码桌宠仍然跑旧版——这是开发者最大的踩坑点。自动同步(失败静默)到:
//   ../../node_modules/mocode-pet-app/dist
// 失败的原因通常是 electron 进程锁住了 main.js(需要先关桌宠)——脚本不报错、不阻断主流程。
const targetDir = path.join(root, '..', '..', 'node_modules', 'mocode-pet-app', 'dist');
if (existsSync(targetDir)) {
  try {
    // force:false — 默认行为,被锁文件会 throw;这里改用逐文件 try 复制保证尽力同步。
    // electron 进程可能锁住 main.js,这里把"锁住的文件"跳过,不影响其他文件同步。
    const files = [
      'config.js', 'mood.js', 'mood-tracker.js', 'protocol.js', 'quips.js', 'skins.js',
    ];
    let synced = 0;
    let locked = [];
    for (const f of files) {
      try {
        cpSync(path.join(root, 'dist', f), path.join(targetDir, f));
        synced++;
      } catch {
        locked.push(f);
      }
    }
    // assets 文件夹
    try {
      cpSync(path.join(root, 'dist', 'assets'), path.join(targetDir, 'assets'), { recursive: true });
      synced++;
    } catch (e) {
      locked.push('assets/');
    }
    // main.js 是 electron 主进程入口,运行时被锁——单独复制最佳努力
    try {
      cpSync(path.join(root, 'dist', 'main.js'), path.join(targetDir, 'main.js'));
      synced++;
    } catch {
      locked.push('main.js');
    }
    // renderer 整个目录(css/html/js)
    try {
      cpSync(path.join(root, 'dist', 'renderer'), path.join(targetDir, 'renderer'), { recursive: true });
      synced++;
    } catch {
      locked.push('renderer/');
    }
    console.log(`[copy-static] 同步 dist/ → node_modules/mocode-pet-app/dist/: 成功 ${synced} 项${locked.length ? `, 锁定 ${locked.length} 项 (${locked.join(', ')}) — 通常是 electron 锁了主进程文件,关桌宠后重 build` : ''}`);
  } catch (e) {
    console.warn('[copy-static] 同步到 node_modules 失败:', e instanceof Error ? e.message : String(e));
  }
}
