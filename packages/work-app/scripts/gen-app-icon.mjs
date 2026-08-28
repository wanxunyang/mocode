// 应用图标维护脚本 —— 透传版,避免误生成回旧的"白底圆角 + 像素兔"。
//
// 现在应用图标的来源是 assets/icon.png(由产品所有者维护/替换,例如设计师交付的 M-code logo)。
// 本脚本只做两件事:
//   1. 若提供了"更原始"的源图 assets/icon-source.png,则将其同步到 assets/icon.png
//      (适用于设计师交付了一张更高分辨率 / 含透明通道的 PNG,需要标准化)。
//   2. 否则什么都不写,只确认 icon.png 存在,并提示如何替换。
//
// 历史:此脚本早先是手写 PNG 编码器,会自动生成"白底圆角 + 草绿描边 + 像素兔"。
//      M-code 品牌确定后,该硬编码方案不再适用,改成本透传脚本以保留重新生成的能力
//      又避免误覆盖。
import { cpSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'assets');
const iconSrc = path.join(assetsDir, 'icon-source.png');
const iconDst = path.join(assetsDir, 'icon.png');

if (existsSync(iconSrc)) {
  cpSync(iconSrc, iconDst);
  const sz = statSync(iconDst).size;
  console.log(`[gen-app-icon] 已将 ${iconSrc} -> ${iconDst}(${sz} 字节)`);
  process.exit(0);
}

if (!existsSync(iconDst)) {
  console.error(`[gen-app-icon] 缺少应用图标:请把 PNG 放到 ${iconDst} 或 ${iconSrc}`);
  process.exit(1);
}

const sz = statSync(iconDst).size;
console.log(
  `[gen-app-icon] 应用图标已是最新: ${iconDst}(${sz} 字节)。\n` +
    `  如需替换,直接覆盖该文件然后重新构建(dist 会自动同步)。`,
);
