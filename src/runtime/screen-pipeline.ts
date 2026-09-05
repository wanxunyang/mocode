/**
 * Computer Use 截图管线:捕获 → 缩放/裁剪(纯 JS PNG) → norm1000 坐标换算。
 *
 * 职责边界:
 * - 抓屏本身在 screen-capture.ts(平台相关),本文件只管图像后处理与坐标数学。
 * - 坐标对外只暴露归一化 0-1000 整数网格(x 右 / y 下),模型从不感知物理分辨率;
 *   执行层按最近一次截图的 scale 因子换算回物理像素。
 * - 零原生图像依赖:PNG 解码/编码用 Node 内置 zlib 手写,最近邻重采样。
 *   只支持截图工具产出的 8-bit RGB/RGBA PNG(screencapture/PowerShell Bitmap 均为该族)。
 */
import { inflateSync, deflateSync } from 'node:zlib';

// ── PNG 解码/编码(8-bit RGB/RGBA,filter 0-4)────────────────────────────

export interface PngImage {
  width: number;
  height: number;
  /** 解码后的 RGBA(每像素 4 字节,统一转成 RGBA 便于处理)。 */
  data: Buffer;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解码 PNG → RGBA 像素。非 8-bit RGB/RGBA 直接抛错(截图工具不会产出其它形态)。 */
export function decodePng(buf: Buffer): PngImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 8 + len + 4; // +4 CRC
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  // 反滤镜
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowIn + x];
      const a = x >= bpp ? out[rowOut + x - bpp] : 0;
      const b = y > 0 ? out[rowOut + x - stride] : 0;
      const c = x >= bpp && y > 0 ? out[rowOut + x - stride - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${f}`);
      }
      out[rowOut + x] = v & 0xff;
    }
  }
  // RGB → RGBA
  if (bpp === 4) return { width, height, data: out };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i];
    rgba[j + 1] = out[i + 1];
    rgba[j + 2] = out[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, data: rgba };
}

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 编码 RGBA → PNG(colorType 6,filter 0)。 */
export function encodePng(img: PngImage): Buffer {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 缩放 / 裁剪(最近邻)─────────────────────────────────────────────────

function resample(img: PngImage, newW: number, newH: number): PngImage {
  const { width, height, data } = img;
  const out = Buffer.alloc(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const srcY = Math.min(height - 1, Math.floor((y * height) / newH));
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(width - 1, Math.floor((x * width) / newW));
      const s = (srcY * width + srcX) * 4;
      const d = (y * newW + x) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: newW, height: newH, data: out };
}

/** 长边缩到 ≤ maxEdge,保持纵横比。已 ≤ maxEdge 时原样返回(零成本直通)。 */
export function downscale(img: PngImage, maxEdge: number): { img: PngImage; scale: number } {
  const long = Math.max(img.width, img.height);
  if (long <= maxEdge) return { img, scale: 1 };
  const scale = maxEdge / long;
  const newW = Math.max(1, Math.round(img.width * scale));
  const newH = Math.max(1, Math.round(img.height * scale));
  return { img: resample(img, newW, newH), scale };
}

/** 长边精确缩放到 edge(放大或缩小,zoom 动作用),保持纵横比。 */
export function fitToLongEdge(img: PngImage, edge: number): PngImage {
  const long = Math.max(img.width, img.height);
  if (long === edge) return img;
  const scale = edge / long;
  const newW = Math.max(1, Math.round(img.width * scale));
  const newH = Math.max(1, Math.round(img.height * scale));
  return resample(img, newW, newH);
}

/** 裁出 (x,y,w,h) 矩形,越界自动收敛到图像内。 */
export function crop(img: PngImage, x: number, y: number, w: number, h: number): PngImage {
  const cx = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(img.width - cx, Math.round(w)));
  const ch = Math.max(1, Math.min(img.height - cy, Math.round(h)));
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const s = ((cy + row) * img.width + cx) * 4;
    img.data.copy(out, row * cw * 4, s, s + cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

// ── norm1000 坐标换算 ──────────────────────────────────────────────────

/** 归一化坐标(0-1000)→ 物理像素。scale = 喂模型的图相对物理的缩放比。 */
export function normToPhysical(nx: number, ny: number, physW: number, physH: number): [number, number] {
  const x = Math.round((clamp1000(nx) / 1000) * physW);
  const y = Math.round((clamp1000(ny) / 1000) * physH);
  return [Math.min(physW - 1, x), Math.min(physH - 1, y)];
}

/** 物理像素 → 归一化坐标(0-1000)。 */
export function physicalToNorm(px: number, py: number, physW: number, physH: number): [number, number] {
  return [clamp1000(Math.round((px / physW) * 1000)), clamp1000(Math.round((py / physH) * 1000))];
}

/** 归一化矩形 [x,y,w,h](0-1000)→ 物理矩形像素。 */
export function normRectToPhysical(
  rect: readonly [number, number, number, number],
  physW: number,
  physH: number,
): { x: number; y: number; w: number; h: number } {
  const [nx, ny, nw, nh] = rect;
  const [x0, y0] = normToPhysical(nx, ny, physW, physH);
  const [x1, y1] = normToPhysical(nx + nw, ny + nh, physW, physH);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function clamp1000(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1000, Math.round(v)));
}

/** 校验一个值是否为有限数且落在 norm1000 区间。 */
export function isNormCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000;
}
