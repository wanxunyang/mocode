import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToWorkArea } from '../../packages/work-app/src/window-fit.js';

// 主屏 1707x960（工作区），副屏在它左边，坐标是负数 —— 真实双屏布局就是这种坐标。
const PRIMARY = { x: 0, y: 0, width: 1707, height: 960 };
const SECONDARY = { x: -1707, y: 0, width: 1707, height: 1067 };

test('窗口本来就合规：返回 null，调用方不该发 setBounds', () => {
  assert.equal(clampToWorkArea({ x: 100, y: 80, width: 1280, height: 820 }, PRIMARY), null);
  // 正好铺满工作区也算合规
  assert.equal(clampToWorkArea({ ...PRIMARY }, PRIMARY), null);
});

test('比屏还高的窗口（跨屏拖动的典型症状）被收缩到工作区高度', () => {
  // 这正是不修就会「看不到输入框」的输入：窗口比主屏工作区高 107px
  assert.deepEqual(clampToWorkArea({ x: 0, y: 0, width: 1707, height: 1067 }, PRIMARY), {
    x: 0,
    y: 0,
    width: 1707,
    height: 960,
  });
});

test('窗口越出工作区右/下沿时整体平移回来', () => {
  assert.deepEqual(clampToWorkArea({ x: 1000, y: 500, width: 800, height: 600 }, PRIMARY), {
    x: 907,
    y: 360,
    width: 800,
    height: 600,
  });
});

test('负坐标副屏上的窗口不会被误判为越界', () => {
  assert.equal(clampToWorkArea({ x: -1707, y: 0, width: 1280, height: 820 }, SECONDARY), null);
  // 但副屏高度 1067 的窗口挪到主屏（工作区 960）就该被收
  assert.deepEqual(clampToWorkArea({ x: 0, y: 0, width: 1280, height: 1067 }, PRIMARY), {
    x: 0,
    y: 0,
    width: 1280,
    height: 960,
  });
});

test('窗口比工作区宽且位置为负：先收缩再贴左上角', () => {
  assert.deepEqual(clampToWorkArea({ x: -500, y: -300, width: 2400, height: 1200 }, PRIMARY), {
    x: 0,
    y: 0,
    width: 1707,
    height: 960,
  });
});

test('无效尺寸（窗口还没创建 / 显示器数据异常）不产生 setBounds', () => {
  assert.equal(clampToWorkArea({ x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 0, height: 0 }), null);
  assert.equal(clampToWorkArea({ x: Number.NaN, y: 0, width: 800, height: 600 }, PRIMARY), null);
});

test('亚像素级小数不触发 setBounds（舍入后仍是原值）', () => {
  // HiDPI 换算常给出 100.6 这种坐标。四舍五入后与输入同一像素：
  // 返回 null 才对 —— 否则每次 resize 都发一次 setBounds，会跟用户拖拽互相打架。
  assert.equal(clampToWorkArea({ x: 100.6, y: 50.4, width: 800, height: 600 }, PRIMARY), null);
  // 真的越界时，输出坐标才收敛成整数
  assert.deepEqual(clampToWorkArea({ x: 1200.4, y: 900.7, width: 800, height: 600 }, PRIMARY), {
    x: 907,
    y: 360,
    width: 800,
    height: 600,
  });
});
