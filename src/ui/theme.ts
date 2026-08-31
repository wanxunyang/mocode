import { stdout } from 'node:process';

/**
 * 终端 UI 主题:TTY 感知的 ANSI 颜色 + 多套可切换调色板。
 *
 * 设计:
 *  - `ui` 是单例对象,颜色字段为 **getter**——每次 `${ui.cyan}` 都现取当前调色板的值,
 *    故 `setTheme(name)` 后全项目 60+ 内联调用点零改动即自动跟随。`isTTY`/`reset`/
 *    `bold`/`dim`/`reverse` 是属性 / 跨主题不变量,保持普通字面量(非 getter)。
 *  - 非 TTY(管道 / 重定向)时 `wrap` 把所有颜色退化成空串,避免转义码污染日志;此门控
 *    集中在 getter 里,是正确性不变量——切主题不会绕过它。
 *  - `getThemeVersion()` 在 `setTheme` 时自增,供 markdown MEMO 等缓存按版本失效
 *    (否则切主题后重渲染会命中旧主题的缓存行)。
 *  - truecolor(`\x1B[38;2;r;g;bm`)安全:渲染层 SGR 正则 `/\x1b\[[0-9;]*m/` 通配;
 *    调色板约定所有 span 用 `ui.reset`(`\x1B[0m`)闭合(content.ts 只认精确 reset)。
 *
 * 叶子模块:不反向依赖 config / 业务。启动时由 repl 调 `setTheme(config.theme)` 注入。
 */
const isTTY = Boolean(stdout.isTTY);
const wrap = (code: string) => (isTTY ? code : '');

/** 可切换的颜色字段(属性 bold/dim/reverse/reset 跨主题不变,不在此)。 */
export interface Palette {
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  gray: string;
  brightCyan: string;
  brightMagenta: string;
  /**
   * 主题主色(accent):承载"主题感"的关键 UI 锚点 —— 启动 logo / 标题 ● /
   * 输入框顶上线 / 状态栏 ● / 菜单选中项。切主题时只动这一处,其它基础色
   * 槽保持多色辨识度不变。各主题须显式定义(无默认值)。
   */
  accent: string;
  /** 用户消息满宽背景色(上滑时易辨认)。 */
  userBg: string;
  /** diff 新增行整行底色——浅深主题下都柔和可辨,跟绿字 fg 配对;SGR 自洽,每行 reset 闭合。 */
  addBg: string;
  /** diff 删除行整行底色——同 addBg,跟红字 fg 配对。 */
  delBg: string;
}
// 注意:本模块**不碰终端窗口背景**(OSC 11)。终端底色一律保持用户终端自身的原色,
// 切主题只换 SGR 前景/行内底色。唯一例外是退出时 `resetTerminalBackground()`(OSC 111),
// 那是为了清掉子进程(agent 跑的 run_command)可能留下的背景污染,把终端拉回默认。

export type ColorKey = keyof Palette;

/** default = One Dark(truecolor):平衡柔和的深色调色板,跨终端一致(不再依赖终端 16 色板)。 */
const DEFAULT: Palette = {
  red: '\x1B[38;2;224;108;117m',
  green: '\x1B[38;2;152;195;121m',
  yellow: '\x1B[38;2;229;192;123m',
  blue: '\x1B[38;2;97;175;239m',
  magenta: '\x1B[38;2;198;120;221m',
  cyan: '\x1B[38;2;86;182;194m',
  gray: '\x1B[38;2;92;99;112m',
  brightCyan: '\x1B[38;2;86;182;194m',
  brightMagenta: '\x1B[38;2;198;120;221m',
  accent: '\x1B[38;2;86;182;194m', // 与 cyan 同源(One Dark):logo/标题/输入框顶线/选中项统一承载
  userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
  // diff 行底色:One Dark bg #282c34 上加 ~14% 亮度的对应色,够辨识但不刺眼
  addBg: '\x1B[48;2;44;62;42m', // 偏暗绿(One Dark green(152,195,121)暗化)
  delBg: '\x1B[48;2;62;38;42m', // 偏暗红(One Dark red(224,108,117)暗化)
};

/**
 * 内建主题表。default=One Dark、light=Solarized Light、solarized=Solarized Dark、
 * gruvbox / nord 取各自经典调色板的 truecolor 强调色。值可调;关键是不存在悬空 reset(用 \x1B[0m 闭合)。
 */
const THEMES: Record<string, Palette> = {
  default: DEFAULT,
  light: {
    // Solarized Light:浅底(base3 #fdf6e3)用 Solarized 经典强调色(与 solarized 暗底同源);
    // gray 取 base01(浅底下可读的次级灰),userBg 取 base2(浅米底)。
    red: '\x1B[38;2;220;50;47m',
    green: '\x1B[38;2;133;153;0m',
    yellow: '\x1B[38;2;181;137;0m',
    blue: '\x1B[38;2;38;139;210m',
    magenta: '\x1B[38;2;211;54;130m',
    cyan: '\x1B[38;2;42;161;152m',
    gray: '\x1B[38;2;88;110;117m',
    brightCyan: '\x1B[38;2;42;161;152m',
    brightMagenta: '\x1B[38;2;108;113;196m',
    accent: '\x1B[38;2;38;139;210m', // Solarized blue:浅底下更醒目的强调
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:Solarized Light base2(238,232,213)上贴同色族浅 tint,
    // 比直接用 base1 更柔,跟深 fg(red/green)对比充足
    addBg: '\x1B[48;2;220;235;205m',
    delBg: '\x1B[48;2;245;218;215m',
  },
  solarized: {
    red: '\x1B[38;2;220;50;47m',
    green: '\x1B[38;2;133;153;0m',
    yellow: '\x1B[38;2;181;137;0m',
    blue: '\x1B[38;2;38;139;210m',
    magenta: '\x1B[38;2;211;54;130m',
    cyan: '\x1B[38;2;42;161;152m',
    gray: '\x1B[38;2;88;110;117m',
    brightCyan: '\x1B[38;2;147;161;161m',
    brightMagenta: '\x1B[38;2;108;113;196m',
    accent: '\x1B[38;2;42;161;152m', // Solarized cyan(深底版):暗底上跳出
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:Solarized Dark base03(0,43,54)上加对应色族暗 tint
    addBg: '\x1B[48;2;20;50;38m',
    delBg: '\x1B[48;2;55;30;30m',
  },
  gruvbox: {
    red: '\x1B[38;2;251;73;52m',
    green: '\x1B[38;2;184;187;38m',
    yellow: '\x1B[38;2;250;189;47m',
    blue: '\x1B[38;2;131;165;152m',
    magenta: '\x1B[38;2;211;134;155m',
    cyan: '\x1B[38;2;142;192;124m',
    gray: '\x1B[38;2;146;131;116m',
    brightCyan: '\x1B[38;2;142;192;124m',
    brightMagenta: '\x1B[38;2;211;134;155m',
    accent: '\x1B[38;2;250;189;47m', // Gruvbox yellow(主题色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:Gruvbox dark bg(40,40,40)上贴暗 bg0_a 风格
    addBg: '\x1B[48;2;40;55;30m',
    delBg: '\x1B[48;2;70;35;30m',
  },
  nord: {
    red: '\x1B[38;2;191;97;106m',
    green: '\x1B[38;2;163;190;140m',
    yellow: '\x1B[38;2;235;203;139m',
    blue: '\x1B[38;2;129;161;193m',
    magenta: '\x1B[38;2;180;142;173m',
    cyan: '\x1B[38;2;143;188;187m',
    gray: '\x1B[38;2;76;86;106m',
    brightCyan: '\x1B[38;2;136;192;208m',
    brightMagenta: '\x1B[38;2;180;142;173m',
    accent: '\x1B[38;2;136;192;208m', // Nord 浅冰蓝(主题色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:Nord polar night(46,52,64)上贴对应色族暗 tint
    addBg: '\x1B[48;2;46;66;52m',
    delBg: '\x1B[48;2;72;46;52m',
  },
  orange: {
    // 秋季/南瓜橙:深暖底(#231c16 系)+ accent 主强调走橙色;yellow 槽也偏橙
    // 保持调性一致(标题、菜单等关键 UI 元素走 accent);red 取暖珊瑚避免与
    // 橙黄撞色;蓝/紫/青保留冷色锚点维持多色辨识度。
    red: '\x1B[38;2;255;105;90m', // 暖珊瑚红
    green: '\x1B[38;2;150;200;115m', // 黄绿
    yellow: '\x1B[38;2;255;170;60m', // 南瓜橙(主题色)
    blue: '\x1B[38;2;120;170;230m', // 冷蓝锚点
    magenta: '\x1B[38;2;225;130;195m', // 暖粉紫
    cyan: '\x1B[38;2;110;195;195m', // 雾青
    gray: '\x1B[38;2;150;130;110m', // 暖灰
    brightCyan: '\x1B[38;2;160;220;220m',
    brightMagenta: '\x1B[38;2;245;165;215m',
    accent: '\x1B[38;2;255;170;60m', // 南瓜橙(主题主色:logo/标题/输入框顶线/选中项)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:暖深棕底上贴对应色族暗 tint,跟 fg 配对柔和可辨
    addBg: '\x1B[48;2;55;70;35m',
    delBg: '\x1B[48;2;78;42;32m',
  },
  rose: {
    // 玫红:深紫底 + accent 玫粉作主强调;magenta 槽与 accent 同源(主题色),
    // red 偏暖玫;蓝/青保留冷色锚点维持多色辨识度。
    red: '\x1B[38;2;240;100;120m', // 暖玫红
    green: '\x1B[38;2;160;200;130m', // 黄绿
    yellow: '\x1B[38;2;240;180;140m', // 暖杏
    blue: '\x1B[38;2;130;160;230m', // 冷蓝锚点
    magenta: '\x1B[38;2;230;90;170m', // 主玫红(主题色)
    cyan: '\x1B[38;2;120;200;200m', // 雾青
    gray: '\x1B[38;2;160;140;150m', // 暖灰紫
    brightCyan: '\x1B[38;2;170;220;220m',
    brightMagenta: '\x1B[38;2;250;160;200m',
    accent: '\x1B[38;2;230;90;150m', // 玫粉(主题主色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:深紫底贴对应色族暗 tint,绿暗化偏橄榄、红暗化偏紫红
    addBg: '\x1B[48;2;50;60;42m',
    delBg: '\x1B[48;2;75;40;52m',
  },
  emerald: {
    // 翡翠绿:深绿底 + accent 翡翠绿作主强调;green 槽与 accent 同源(主题色),
    // cyan 偏青绿;蓝/紫保留冷色锚点,red/yellow 保留暖色警示色。
    red: '\x1B[38;2;235;110;110m', // 暖红(警示色)
    green: '\x1B[38;2;80;210;140m', // 主翡翠绿(主题色)
    yellow: '\x1B[38;2;230;200;100m', // 暖黄
    blue: '\x1B[38;2;100;180;210m', // 冷青蓝
    magenta: '\x1B[38;2;190;140;210m', // 冷紫
    cyan: '\x1B[38;2;100;210;190m', // 青绿
    gray: '\x1B[38;2;110;140;130m', // 冷绿灰
    brightCyan: '\x1B[38;2;140;230;210m',
    brightMagenta: '\x1B[38;2;210;170;230m',
    accent: '\x1B[38;2;80;210;140m', // 翡翠绿(主题主色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:深绿底贴对应色族暗 tint,绿暗化偏深绿、红暗化偏暗红
    addBg: '\x1B[48;2;30;55;40m',
    delBg: '\x1B[48;2;60;40;40m',
  },
  amber: {
    // 琥珀金黄:深棕底 + accent 琥珀金黄作主强调;yellow 槽与 accent 同源(主题色),
    // 跟 orange 区分(orange 南瓜橙偏橙红,amber 琥珀偏金黄);蓝/紫/青保留冷色锚点。
    red: '\x1B[38;2;230;120;90m', // 暖橙红(警示色)
    green: '\x1B[38;2;180;180;80m', // 黄绿
    yellow: '\x1B[38;2;255;200;80m', // 主琥珀金黄(主题色)
    blue: '\x1B[38;2;120;160;200m', // 冷蓝
    magenta: '\x1B[38;2;220;140;180m', // 暖粉
    cyan: '\x1B[38;2;130;180;170m', // 雾青绿
    gray: '\x1B[38;2;150;130;100m', // 暖灰
    brightCyan: '\x1B[38;2;170;210;200m',
    brightMagenta: '\x1B[38;2;240;180;210m',
    accent: '\x1B[38;2;255;200;80m', // 琥珀金黄(主题主色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:深棕底贴对应色族暗 tint,绿暗化偏橄榄、红暗化偏暗棕红
    addBg: '\x1B[48;2;50;55;25m',
    delBg: '\x1B[48;2;70;40;28m',
  },
  lavender: {
    // 薰衣草淡紫:深紫底 + accent 淡紫作主强调;magenta 槽与 accent 同源(主题色),
    // blue 偏冷蓝锚点(略带紫调);red/yellow 保留暖色警示色。
    red: '\x1B[38;2;230;130;150m', // 暖粉红(警示色)
    green: '\x1B[38;2;150;200;140m', // 黄绿
    yellow: '\x1B[38;2;230;200;140m', // 暖杏
    blue: '\x1B[38;2;140;160;230m', // 冷蓝锚点(略带紫)
    magenta: '\x1B[38;2;180;150;230m', // 主薰衣草紫(主题色)
    cyan: '\x1B[38;2;140;210;210m', // 雾青
    gray: '\x1B[38;2;140;130;160m', // 冷灰紫
    brightCyan: '\x1B[38;2;180;230;230m',
    brightMagenta: '\x1B[38;2;210;180;250m',
    accent: '\x1B[38;2;180;150;230m', // 薰衣草紫(主题主色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:深紫底贴对应色族暗 tint,绿暗化偏冷绿、红暗化偏冷紫红
    addBg: '\x1B[48;2;38;46;42m',
    delBg: '\x1B[48;2;60;40;55m',
  },
  sunset: {
    // 日落珊瑚:深棕红底 + accent 珊瑚红作主强调;red 槽与 accent 同源(主题色);
    // 跟 orange 区分(orange 南瓜橙偏橙黄,sunset 珊瑚偏红);蓝/青保留冷色锚点。
    red: '\x1B[38;2;255;120;100m', // 主珊瑚红(主题色)
    green: '\x1B[38;2;180;200;110m', // 黄绿
    yellow: '\x1B[38;2;255;170;80m', // 暖橙黄
    blue: '\x1B[38;2;110;170;220m', // 冷蓝锚点
    magenta: '\x1B[38;2;230;120;180m', // 玫红
    cyan: '\x1B[38;2;120;200;190m', // 雾青
    gray: '\x1B[38;2;160;120;110m', // 暖灰
    brightCyan: '\x1B[38;2;170;225;215m',
    brightMagenta: '\x1B[38;2;250;170;210m',
    accent: '\x1B[38;2;255;120;100m', // 珊瑚红(主题主色)
    userBg: '\x1B[48;2;72;78;90m', // 统一灰白用户消息底(黑底终端可见)
    // diff 行底色:深棕红底贴对应色族暗 tint,绿暗化偏橄榄、红暗化偏暗棕红
    addBg: '\x1B[48;2;50;55;30m',
    delBg: '\x1B[48;2;75;32;30m',
  },
};

let currentName = 'default';
let version = 0;

function currentPalette(): Palette {
  return THEMES[currentName] ?? DEFAULT;
}

/**
 * 请终端还原自身默认背景(OSC 111)。
 *
 * 我们从不主动设背景(见 Palette 上的注释),这条只作**善后**:agent 跑 run_command
 * 时子进程可能自己下发 OSC 11 改了窗口底色,退出 alt screen 时拉回默认,免得把改动
 * 留在用户终端里。终端不支持 OSC 111 时该序列被忽略,无副作用。
 */
export function resetTerminalBackground(): void {
  if (!isTTY) return;
  stdout.write('\x1B]111\x07');
}

/** 取某颜色字段的当前 ANSI 码(经 isTTY 门控)。 */
function color(key: ColorKey): string {
  return wrap(currentPalette()[key] ?? DEFAULT[key]);
}

/**
 * 切主题。name 未知则回退 default(不抛——启动时 config.theme 可能是用户填的任意值)。
 * 仅当实际变更时自增 version(供缓存失效)。 */
export function setTheme(name: string): void {
  const next = THEMES[name] ? name : 'default';
  if (currentName !== next) {
    currentName = next;
    version++;
  }
}

export function getTheme(): string {
  return currentName;
}

export function listThemes(): string[] {
  return Object.keys(THEMES);
}

export function themeExists(name: string): boolean {
  return name in THEMES;
}

/** 主题版本号,每次 setTheme 实际变更自增;供 markdown MEMO 等缓存按版本失效。 */
export function getThemeVersion(): number {
  return version;
}

export const ui = {
  isTTY,
  reset: wrap('\x1B[0m'),
  bold: wrap('\x1B[1m'),
  dim: wrap('\x1B[2m'),
  reverse: wrap('\x1B[7m'), // 反白(fg/bg 互换):块状输入光标用,光标处字符整格反白
  get red() {
    return color('red');
  },
  get green() {
    return color('green');
  },
  get yellow() {
    return color('yellow');
  },
  get blue() {
    return color('blue');
  },
  get magenta() {
    return color('magenta');
  },
  get cyan() {
    return color('cyan');
  },
  get gray() {
    return color('gray');
  },
  get brightCyan() {
    return color('brightCyan');
  },
  get brightMagenta() {
    return color('brightMagenta');
  },
  get accent() {
    return color('accent');
  },
  get userBg() {
    return color('userBg');
  },
  get addBg() {
    return color('addBg');
  },
  get delBg() {
    return color('delBg');
  },
};
