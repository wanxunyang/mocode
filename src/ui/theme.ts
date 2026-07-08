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
  /** 用户消息满宽背景色(上滑时易辨认)。 */
  userBg: string;
  /** diff 新增行整行底色——浅深主题下都柔和可辨,跟绿字 fg 配对;SGR 自洽,每行 reset 闭合。 */
  addBg: string;
  /** diff 删除行整行底色——同 addBg,跟红字 fg 配对。 */
  delBg: string;
}

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
  userBg: '\x1B[48;2;44;49;60m', // One Dark current-line bg,深色终端上微妙可辨
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
    userBg: '\x1B[48;2;238;232;213m',
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
    userBg: '\x1B[48;2;7;54;66m',
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
    userBg: '\x1B[48;2;40;40;40m',
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
    userBg: '\x1B[48;2;67;76;94m',
    // diff 行底色:Nord polar night(46,52,64)上贴对应色族暗 tint
    addBg: '\x1B[48;2;46;66;52m',
    delBg: '\x1B[48;2;72;46;52m',
  },
};

let currentName = 'default';
let version = 0;

function currentPalette(): Palette {
  return THEMES[currentName] ?? DEFAULT;
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
