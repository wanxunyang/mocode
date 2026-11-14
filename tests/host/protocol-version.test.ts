/**
 * 宿主协议版本的跨包一致性。
 *
 * 版本号有两份声明，且**必须**保持两份：
 *   · `packages/protocol/src/host.ts` —— 协议包的事实源（work-app / runtime 消费方读它）；
 *   · `src/host/protocol.ts` —— 根包内的副本，因为根包发到 npm 时 `@mocode/protocol`
 *     不在它的 dependencies 里（该 workspace 包 private、不发布）。
 *
 * 为什么根包必须自己声明：`bin/mocode-agent-host.js` 是用户真正执行的入口。若根包用值导入
 * 拿这个常量，编译产物会留下裸 `import ... from '@mocode/protocol/host'`，tarball 安装后
 * 宿主一启动就 `ERR_MODULE_NOT_FOUND`（1.10.0 的隔离安装 smoke 实测踩到；以前只有
 * `import type`，编译期被擦除，所以一直没暴露）。
 *
 * 代价是「两处可能漂移」，所以这里用源码扫描把它们钉在一起：只改一边就红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_PROTOCOL_VERSION } from '../../src/host/protocol.js';

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"name": "mocode-ai"')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（package.json 里 name=mocode-ai）');
}

const repoRoot = findRepoRoot();
const protocolSource = readFileSync(path.join(repoRoot, 'packages/protocol/src/host.ts'), 'utf8');

function declaredVersion(source: string, file: string): number {
  const match = /export const HOST_PROTOCOL_VERSION = (\d+);/.exec(source);
  assert.ok(match, `${file} 里找不到 \`export const HOST_PROTOCOL_VERSION = <数字>;\``);
  return Number(match[1]);
}

test('根包与协议包的 HOST_PROTOCOL_VERSION 相等（改一处忘另一处会红）', () => {
  assert.equal(
    HOST_PROTOCOL_VERSION,
    declaredVersion(protocolSource, 'packages/protocol/src/host.ts'),
    'src/host/protocol.ts 与 packages/protocol/src/host.ts 的协议版本不一致：' +
      'host 会按错的版本号回报 runtime_ready，客户端据此提示不匹配。',
  );
});

test('根包的宿主入口不得值导入 @mocode/protocol（否则 tarball 安装后启动即崩）', () => {
  // 根包发布时 @mocode/protocol 不在 dependencies 里（private、不发布），
  // 值导入会在 dist 留下裸 import → ERR_MODULE_NOT_FOUND。
  // import type 是允许的：编译期擦除，运行时零依赖。
  const hostSource = readFileSync(path.join(repoRoot, 'src/host/protocol.ts'), 'utf8');
  const valueImports = [...hostSource.matchAll(/^import\s+(?!type\b)[^;]*from\s+'@mocode\/protocol[^']*';/gms)];
  assert.deepEqual(
    valueImports.map((match) => match[0].split('\n')[0]),
    [],
    'src/host/protocol.ts 出现了对 @mocode/protocol 的值导入：根包发到 npm 后宿主会 ' +
      'ERR_MODULE_NOT_FOUND。常量请在本文件内定义，类型用 `import type`。',
  );
});
