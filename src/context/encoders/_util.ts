// encoder 共享小工具(非 encoder,纯函数)。供 graph/doc/summary 等复用。
// log/code 各有专属逻辑(log 用重复行折叠;code 用前缀感知空行检测),不在此。

/** 去 ANSI CSI 序列(颜色 / 光标 / 清屏等)。语义无损:颜色码不含信息。 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * 折叠连续空行(只含空白字符的行)≥ threshold → 单个空行。
 * 用于 prose / source dump(web_fetch / use_skill / task):HTML→文本与 markdown 常留多余空行,
 * 多空行与单空行语义等价,折叠无损。默认 threshold=3(只动真正过量的空行,常见 ≤2 空行不动)。
 * 注:codegraph 已 skill 化(用 run_command 调 CLI,落到 log encoder),graph kind 现仅作保留值。
 *
 * 注意:用 `.trim() === ''` 判空——故 read_file 的 `     2\t`(行号前缀 + tab,trim 后剩 `2`)不会被
 * 视作空行。read_file 的空行折叠见 code encoder(前缀感知)。
 */
export function collapseBlankRuns(text: string, threshold = 3): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      const run = j - i;
      if (run >= threshold) {
        out.push(''); // 单个空行
      } else {
        for (let k = 0; k < run; k++) out.push(lines[i]);
      }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}
