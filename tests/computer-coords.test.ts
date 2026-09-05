/**
 * norm1000 坐标换算 + PNG 缩放/裁剪 单元测试(screen-pipeline)。
 * 纯函数,不碰真实屏幕/文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normToPhysical,
  physicalToNorm,
  normRectToPhysical,
  isNormCoord,
  downscale,
  fitToLongEdge,
  crop,
  encodePng,
  decodePng,
} from '../src/runtime/screen-pipeline.js';

test('normToPhysical: 归一化 0-1000 → 物理像素,边界收敛到屏幕内', () => {
  // 1920×1080
  assert.deepEqual(normToPhysical(0, 0, 1920, 1080), [0, 0]);
  assert.deepEqual(normToPhysical(500, 500, 1920, 1080), [960, 540]);
  assert.deepEqual(normToPhysical(1000, 1000, 1920, 1080), [1919, 1079]);
});

test('normToPhysical: 越界输入被 clamp 到 0-1000,再换算', () => {
  assert.deepEqual(normToPhysical(-50, 1200, 1920, 1080), [0, 1079]);
});

test('physicalToNorm 与 normToPhysical 互逆(取整误差内)', () => {
  const [nx, ny] = physicalToNorm(960, 540, 1920, 1080);
  assert.equal(nx, 500);
  assert.equal(ny, 500);
  const [px, py] = normToPhysical(nx, ny, 1920, 1080);
  assert.deepEqual([px, py], [960, 540]);
});

test('normRectToPhysical: 归一化矩形 → 物理矩形,w/h 至少为 1', () => {
  const rect = normRectToPhysical([250, 250, 500, 500], 1920, 1080);
  assert.deepEqual(rect, { x: 480, y: 270, w: 960, h: 540 });
  // 退化矩形(0 宽)被抬到 1
  const tiny = normRectToPhysical([500, 500, 0, 0], 1920, 1080);
  assert.equal(tiny.w, 1);
  assert.equal(tiny.h, 1);
});

test('isNormCoord: 只接受 0-1000 的有限数', () => {
  assert.equal(isNormCoord(0), true);
  assert.equal(isNormCoord(500), true);
  assert.equal(isNormCoord(1000), true);
  assert.equal(isNormCoord(-1), false);
  assert.equal(isNormCoord(1001), false);
  assert.equal(isNormCoord(NaN), false);
  assert.equal(isNormCoord('500'), false);
  assert.equal(isNormCoord(undefined), false);
});

/** 构造一个纯 RGBA 图像(指定尺寸,像素值按位置变化,便于验证裁剪/缩放后取到对的位置)。 */
function makeImage(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x & 0xff; // R = x
      data[i + 1] = y & 0xff; // G = y
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('downscale: 长边 > maxEdge 时按比例缩,已 ≤ 时原样直通', () => {
  const big = makeImage(2000, 1000);
  const { img, scale } = downscale(big, 1280);
  assert.equal(img.width, 1280);
  assert.equal(img.height, 640);
  assert.ok(scale < 1 && scale > 0);

  const small = makeImage(800, 600);
  const r = downscale(small, 1280);
  assert.equal(r.img, small); // 直通,同一引用
  assert.equal(r.scale, 1);
});

test('fitToLongEdge: 精确放大/缩小到指定长边', () => {
  const up = fitToLongEdge(makeImage(100, 50), 200);
  assert.equal(up.width, 200);
  assert.equal(up.height, 100);
  const same = makeImage(300, 300);
  assert.equal(fitToLongEdge(same, 300), same);
});

test('crop: 裁出指定矩形,越界自动收敛到图像内', () => {
  const img = makeImage(100, 80);
  const c = crop(img, 10, 20, 30, 40);
  assert.equal(c.width, 30);
  assert.equal(c.height, 40);
  // 左上角像素应来自原图 (10,20):R=x=10, G=y=20
  assert.equal(c.data[0], 10);
  assert.equal(c.data[1], 20);
  // 越界:起点为负 + 尺寸超出 → 收敛
  const clamped = crop(img, -50, -50, 1000, 1000);
  assert.ok(clamped.width <= 100 && clamped.height <= 80);
  assert.ok(clamped.width >= 1 && clamped.height >= 1);
});

test('encodePng/decodePng 往返:尺寸与像素内容一致', () => {
  const src = makeImage(64, 48);
  const round = decodePng(encodePng(src));
  assert.equal(round.width, 64);
  assert.equal(round.height, 48);
  assert.ok(round.data.equals(src.data));
});
