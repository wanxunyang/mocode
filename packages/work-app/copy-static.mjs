import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const file of ['index.html', 'style.css', 'tokens.css']) {
  cpSync(path.join(root, 'src', 'renderer', file), path.join(root, 'dist', 'renderer', file));
}
// 字体包（本地打包，离线可用）
cpSync(path.join(root, 'src', 'renderer', 'fonts'), path.join(root, 'dist', 'renderer', 'fonts'), { recursive: true });
cpSync(path.join(root, 'dist-preload-tmp', 'renderer', 'preload.js'), path.join(root, 'dist', 'renderer', 'preload.js'));
rmSync(path.join(root, 'dist-preload-tmp'), { recursive: true, force: true });
