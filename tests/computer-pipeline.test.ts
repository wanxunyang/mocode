/**
 * Computer Use 管线的纯函数单测:PNG 尺寸快读、帧间差分、图片 token 估算。
 * 这几个是 P0 优化的地基 —— 全是纯函数,不碰真实屏幕/文件,CI 可直接跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPngSize,
  decodePng,
  encodePng,
  diffRatio,
  normToPhysical,
  physicalToNorm,
  type PngImage,
} from '../src/runtime/screen-pipeline.js';
import { imageSizeFromDataUrl } from '../src/attachments/image.js';

function solid(w: number, h: number, gray: number): PngImage {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = gray;
    data[i * 4 + 1] = gray;
    data[i * 4 + 2] = gray;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('readPngSize: 只读 IHDR 就能拿到宽高,不必 inflate 像素', () => {
  const buf = encodePng(solid(640, 480, 12));
  assert.deepEqual(readPngSize(buf), { width: 640, height: 480 });
});

test('readPngSize: 与 decodePng 结果一致(避免两套解析漂移)', () => {
  for (const [w, h] of [
    [1, 1],
    [37, 91],
    [1280, 720],
  ] as Array<[number, number]>) {
    const buf = encodePng(solid(w, h, 200));
    const size = readPngSize(buf);
    assert.deepEqual(size, { width: w, height: h });
    const full = decodePng(buf);
    assert.equal(full.width, size?.width);
    assert.equal(full.height, size?.height);
  }
});

test('readPngSize: 非 PNG / 截断输入返回 null,不抛', () => {
  assert.equal(readPngSize(Buffer.alloc(0)), null);
  assert.equal(readPngSize(Buffer.from('not a png at all, really not')), null);
  assert.equal(readPngSize(encodePng(solid(8, 8, 0)).subarray(0, 20)), null);
});

test('diffRatio: 完全相同的两帧差异为 0', () => {
  const a = solid(256, 256, 128);
  const b = solid(256, 256, 128);
  assert.equal(diffRatio(a, b), 0);
});

test('diffRatio: 尺寸不同直接抛错(说明显示器配置变了,不该静默比)', () => {
  assert.throws(() => diffRatio(solid(64, 64, 0), solid(128, 64, 0)), /size mismatch/);
});

test('diffRatio: 局部区域重绘远高于阈值,整屏变化更高', () => {
  const a = solid(256, 256, 128);
  // 右下角 1/4 区域变白:约 25% 的网格块变化,平均差应在 0.2 附近
  const b = solid(256, 256, 128);
  for (let y = 128; y < 256; y++) {
    for (let x = 128; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      b.data[i] = 255;
      b.data[i + 1] = 255;
      b.data[i + 2] = 255;
    }
  }
  const local = diffRatio(a, b);
  assert.ok(local > 0.1 && local < 0.5, `expected local redraw in (0.1, 0.5), got ${local}`);

  const full = diffRatio(solid(256, 256, 0), solid(256, 256, 255));
  assert.ok(full > 0.9, `expected full change near 1, got ${full}`);
});

test('diffRatio: 单个像素级抖动远低于 0.005 阈值(不该被误判为「屏幕变了」)', () => {
  const a = solid(512, 512, 128);
  const b = solid(512, 512, 128);
  // 撒 200 个像素级噪点,占全屏 0.08%
  for (let k = 0; k < 200; k++) {
    const i = ((k * 7919) % (512 * 512)) * 4;
    b.data[i] = 255;
  }
  const r = diffRatio(a, b);
  assert.ok(r < 0.005, `expected sub-threshold diff, got ${r}`);
});

test('imageSizeFromDataUrl: 解析 PNG / GIF 头', () => {
  const png = encodePng(solid(1568, 878, 30)).toString('base64');
  assert.deepEqual(imageSizeFromDataUrl(`data:image/png;base64,${png}`), { width: 1568, height: 878 });

  const gif = Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt16LE(800, 0);
      b.writeUInt16LE(600, 2);
      return b;
    })(),
    Buffer.alloc(8),
  ]);
  assert.deepEqual(imageSizeFromDataUrl(`data:image/gif;base64,${gif.toString('base64')}`), {
    width: 800,
    height: 600,
  });
});

test('imageSizeFromDataUrl: 解析不出尺寸时返回 null(由调用方兜底)', () => {
  assert.equal(imageSizeFromDataUrl('data:image/png;base64,AAAA'), null);
  assert.equal(imageSizeFromDataUrl('https://example.com/a.png'), null);
  assert.equal(imageSizeFromDataUrl(''), null);
});

test('norm1000 ↔ 物理换算在 DPI 虚拟化下仍自洽(150% 屏物理 2560×1440)', () => {
  // 关键回归:物理尺寸必须来自 EnumDisplaySettings(2560×1440),
  // 而不是 DPI-unaware 的 Bounds(1707×960) —— 用错就是所有点击落在 2/3 处。
  const [cx, cy] = normToPhysical(500, 500, 2560, 1440);
  assert.deepEqual([cx, cy], [1280, 720]);
  assert.deepEqual(physicalToNorm(1280, 720, 2560, 1440), [500, 500]);
});
