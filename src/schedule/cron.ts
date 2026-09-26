// 标准 5 段 cron 匹配（无第三方依赖）：分 时 日(月) 月 周
// 字段支持：*、数字、逗号列表 1,2,3、范围 1-5、步长 */15 或 1-10/2。
// 周：0-6，0=周日。
// 经典语义：当日(月)与周都不是 * 时，满足其一即触发；其一为 * 时只看另一个。

export type CronDate = Pick<Date, 'getMinutes' | 'getHours' | 'getDate' | 'getMonth' | 'getDay'>;

interface FieldRange {
  min: number;
  max: number;
}

const RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
} as const;

/** 解析单个字段为允许值集合。非法表达式抛错。 */
export function parseField(raw: string, range: FieldRange): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part === '') throw new Error(`empty field part in "${raw}"`);
    const [body, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);

    let lo: number;
    let hi: number;
    if (body === '*') {
      lo = range.min;
      hi = range.max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(body);
      hi = stepRaw === undefined ? lo : range.max; // "5/10" = 5,15,25…
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < range.min || hi > range.max || lo > hi) {
      throw new Error(`out-of-range or invalid "${part}" (allowed ${range.min}-${range.max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have exactly 5 fields, got ${fields.length}`);
  const [m, h, dom, mon, dow] = fields;
  return {
    minute: parseField(m, RANGES.minute),
    hour: parseField(h, RANGES.hour),
    dom: parseField(dom, RANGES.dom),
    month: parseField(mon, RANGES.month),
    dow: parseField(dow, RANGES.dow),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** 给定时间是否命中 cron。 */
export function cronMatches(expr: string, date: CronDate = new Date()): boolean {
  const c = parseCron(expr);
  if (!c.month.has(date.getMonth() + 1)) return false;
  if (!c.hour.has(date.getHours())) return false;
  if (!c.minute.has(date.getMinutes())) return false;
  const domMatch = c.dom.has(date.getDate());
  const dowMatch = c.dow.has(date.getDay());
  // 两者都受限 → OR；否则 AND 到 *（即只看受限方）。
  if (c.domRestricted && c.dowRestricted) return domMatch || dowMatch;
  if (c.domRestricted) return domMatch;
  if (c.dowRestricted) return dowMatch;
  return true;
}
