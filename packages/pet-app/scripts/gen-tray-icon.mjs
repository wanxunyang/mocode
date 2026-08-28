// 一次性构建脚本:生成系统托盘图标(32x32 RGBA PNG),与 mascot.svg 的青色主题呼应。
// 造型:圆润机器人头(带天线+圆耳+大眼睛+微笑嘴),比早期的纯圆形"眼睛"图标更可爱、更易辨认。
//
// 配色关键点(Windows 任务栏通常是白色/浅色背景):亮青色 #2afadf 的相对亮度接近纯白,
// 直接用作图标最外层轮廓/描边时,与白色背景的对比度极低,缩到 16px 后近乎"隐形"。
// 因此外层轮廓与天线一律改为深色底 DARK(#0d1b2a,对比度约 19:1,在白底上非常突出),
// 青色只用作被深色包裹的"内部发光点"(眼睛/嘴巴/天线灯芯)——这些像素永远和深色相邻,
// 而不是和白色背景直接相邻,既保留了品牌色的可爱感,又不牺牲在浅色任务栏上的可见度。
//
// 不引入图像处理依赖(sharp/canvas 等)——手写最小 PNG 编码器(IHDR+IDAT+IEND,zlib 走 node:zlib 内置),
// 像素形状用 SDF(有向距离场)拼出圆角矩形/圆形,只在需要重新生成图标时手动运行一次
// (`node scripts/gen-tray-icon.mjs`),生成结果提交进 assets/ 作为静态资源。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 32;
const CYAN = [42, 250, 223, 255]; // #2afadf,与 mascot.svg cyanGrad 起色一致
const DARK = [13, 27, 42, 255]; // #0d1b2a,机身底色
const SPARK = [235, 255, 253, 255]; // 眼睛里的小高光点,提升"可爱感"

/** 圆角矩形有向距离(Inigo Quilez 的 SDF 公式),负值 = 在形状内部。 */
function roundedRectDist(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.max(Math.abs(x - cx) - (halfW - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (halfH - r), 0);
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** 圆形有向距离,负值 = 在形状内部。 */
function circleDist(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

const CX = SIZE / 2; // 16,头部水平中心
const HEAD_CY = 18; // 头部垂直中心(留出顶部天线空间,天线变短后上移一点)
const HEAD = { halfW: 13, halfH: 9, r: 4 }; // 纵向再收窄一点,给天线杆腾出更多长度空间
const EYE = { dx: 5, dy: 0.8, r: 3.1 };
// 嘴巴:一条水平直线。
const MOUTH_PIXELS = new Set([
  `${CX - 4},${HEAD_CY + 6}`,
  `${CX - 3},${HEAD_CY + 6}`,
  `${CX - 2},${HEAD_CY + 6}`,
  `${CX - 1},${HEAD_CY + 6}`,
  `${CX},${HEAD_CY + 6}`,
  `${CX + 1},${HEAD_CY + 6}`,
  `${CX + 2},${HEAD_CY + 6}`,
  `${CX + 3},${HEAD_CY + 6}`,
  `${CX + 4},${HEAD_CY + 6}`,
]);

/** CRC32(PNG 每个 chunk 的 type+data 都需要)。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 像素:圆润机器人宠物头,32x32 在系统托盘缩放到 16px 时仍可辨识出天线+大眼睛的轮廓。
 *
 * 配色原则:整个外部轮廓(天线杆/珠、头部)统一用深色 DARK 填充/描边——
 * 这样图标边缘在白色任务栏背景下永远是深色像素,对比度足够。
 * 青色 CYAN 只用在被深色完全包裹的"内部发光点"上(眼睛瞳孔、嘴巴、天线灯芯),
 * 视觉上是深色轮廓里的一对"亮眼睛",既保留了品牌色的可爱感,又不会紧贴白色背景导致糊成一片。
 */
function pixelAt(x, y) {
  const px = x + 0.5;
  const py = y + 0.5;

  // 天线:深色细杆 + 深色圆珠,珠芯留一个青色高光点(呼应 mascot.svg 天线发光效果)。
  // 珠子上移、杆身延长一点,天线整体更长;珠子半径加大,更显眼。
  // 青色芯块中间左右各突出一个小圆块,呈"三节"造型,增加细节但仍被深色珠体完全包裹。
  const antennaBall = circleDist(px, py, CX, 3.5, 3);
  if (antennaBall <= 0) {
    const coreCyan = circleDist(px, py, CX, 3.5, 1.4) <= 0;
    const bumpCyan =
      circleDist(px, py, CX - 1.8, 3.5, 0.6) <= 0 || circleDist(px, py, CX + 1.8, 3.5, 0.6) <= 0;
    return coreCyan || bumpCyan ? CYAN : DARK;
  }
  if (Math.abs(px - CX) <= 0.9 && py >= 3.5 && py <= HEAD_CY - HEAD.halfH + 1.5) return DARK;

  // 头部:圆角方形,整体深色填充(轮廓在白底任务栏上清晰锐利)。
  const headDist = roundedRectDist(px, py, CX, HEAD_CY, HEAD.halfW, HEAD.halfH, HEAD.r);
  if (headDist <= 0) {
    // 大眼睛(圆形青色瞳,带一点高光,营造萌感——被深色头部完全包裹,不贴白底)。
    for (const sign of [-1, 1]) {
      const eyeCx = CX + sign * EYE.dx;
      const eyeCy = HEAD_CY - EYE.dy;
      if (circleDist(px, py, eyeCx, eyeCy, EYE.r) <= 0) {
        if (circleDist(px, py, eyeCx - 0.9, eyeCy - 0.9, 0.7) <= 0) return SPARK;
        return CYAN;
      }
    }

    // 微笑嘴。
    if (MOUTH_PIXELS.has(`${x},${y}`)) return CYAN;

    return DARK;
  }

  return [0, 0, 0, 0]; // 透明背景
}

const raw = [];
for (let y = 0; y < SIZE; y++) {
  raw.push(0); // 每行前缀 filter byte = 0(无滤波)
  for (let x = 0; x < SIZE; x++) {
    raw.push(...pixelAt(x, y));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const idatData = deflateSync(Buffer.from(raw));
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', idatData),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
writeFileSync(outPath, png);
console.log(`[gen-tray-icon] 已生成 ${outPath}(${png.length} 字节)`);
