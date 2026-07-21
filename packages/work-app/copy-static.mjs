import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const file of ['index.html', 'style.css']) {
  cpSync(path.join(root, 'src', 'renderer', file), path.join(root, 'dist', 'renderer', file));
}
cpSync(path.join(root, 'dist-preload-tmp', 'renderer', 'preload.js'), path.join(root, 'dist', 'renderer', 'preload.js'));
rmSync(path.join(root, 'dist-preload-tmp'), { recursive: true, force: true });
