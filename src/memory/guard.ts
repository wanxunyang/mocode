/**
 * R16 记忆投毒防御:确定性守卫(零 LLM、零 IO)。
 *
 * 为什么需要它:记忆是**自动写入**的,而写进去的内容有两个入口是不受用户控制的——
 *  ① 反思读的是整段转录,而转录里有 `tool:` 行(网页正文、文件内容、命令输出);
 *  ② 模型自己读完网页后调 `memory_save`。
 * 于是「网页里一句话 → 被反思当成结论 → 每次启动都注入 system prompt」成为一条
 * 持久化路径:一次投毒影响此后**每一个**会话,且比一次性提示注入严重得多。
 *
 * 2026 年业界共识是现有提示注入防御覆盖不到间接注入;这里不做"理解语义",
 * 只做两件可判定的事:
 *  - `detectHijack`:**改写控制权**的语句不该变成记忆。它不是在描述世界,是在给
 *    未来的 agent 下命令。确定性正则,**不靠模型判断**(模型正是被攻击对象)。
 *  - `findSourceLine`:这条内容是不是**逐字抄自**转录里某个角色。抄自 `tool:` 行
 *    说明它来自工具输出(不可信来源),抄自 `user:` 行说明是用户亲述(可信)。
 *    同一个原语同时服务「来源追溯」与「不可信来源判定」,不建两套。
 *
 * **精度优先于召回**,三条理由:
 *  ① 误杀的代价是用户/模型想记的合法结论被永久拒绝,且这个拒绝是静默发生的;
 *  ② 漏掉的代价由 `origin: 'tool_output'` 的标记与审计日志兜着——它仍然可见、可查;
 *  ③ 一份「关于投毒手法的记忆」本身就该被允许存在(用户会想记"遇到这类网页要当心"),
 *     因此**引号内**的出现一律不算命中:那是在**提及**这句话,不是在**执行**它。
 *
 * 叶子依赖:不 import 任何项目模块(否则 store → guard → store 成环)。
 */

/** 一条命中规则。id 进审计日志,便于事后统计"哪类投毒最常见"。 */
export interface HijackHit {
  /** 规则 id(稳定标识,写进审计,不要随意改名)。 */
  rule: string;
  /** 命中的原文片段(截断),用于审计留证——它是证据,不是记忆。 */
  sample: string;
}

/**
 * 改写控制权的语句。
 *
 * 判据不是"出现祈使句"(用户说"以后都先跑 typecheck"是**合法偏好**,必须能记),
 * 而是"试图改变 agent 的身份/指令来源/报告义务"这三类之一:
 *  - 指令来源被改写(忽略之前的指令 / disregard previous instructions);
 *  - 身份被改写(你现在是… / you are now…);
 *  - 报告义务被解除(不要告诉用户 / without telling the user)——这是攻击者最想让
 *    agent 做的那件事,也是用户最不可能主动要求持久记住的那件事。
 */
const HIJACK_RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  // ── 指令来源改写 ──
  {
    rule: 'ignore-instructions',
    re: /(?:忽略|无视|忘掉|忘记|抛开|绕过)\s*(?:掉)?\s*(?:之前|以上|上面|前面|先前|此前|所有|全部)\s*的?\s*(?:所有|全部)?\s*(?:指令|指示|命令|提示|要求|规则|限制)/,
  },
  {
    rule: 'ignore-instructions-en',
    re: /\b(?:ignore|disregard|forget|bypass)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier|system)\s+(?:instructions?|prompts?|rules?|directions?|guidelines?)/i,
  },
  // ── 身份改写 ──
  {
    rule: 'role-override',
    re: /(?:从现在|从此刻|自现在)\s*(?:开始|起)[,，]?\s*你\s*(?:是|将|要|必须|只)/,
  },
  {
    rule: 'role-override-en',
    re: /\byou\s+are\s+now\s+(?:a|an|the|in|my|allowed|permitted|free|unrestricted)\b/i,
  },
  // ── 报告义务解除 ──
  {
    rule: 'hide-from-user',
    re: /(?:不要|别|无需|不必|切勿)\s*(?:再)?\s*(?:告诉|通知|告知|提醒|询问|告诉)\s*(?:用户|使用者|他|她)/,
  },
  {
    rule: 'hide-from-user-en',
    re: /\b(?:without|do\s+not|don't|never)\s+(?:telling|informing|notifying|asking|alerting)\s+(?:the\s+)?user\b/i,
  },
  // ── 自身提示词外泄(常与投毒同现,且一旦落进记忆会被反复读到) ──
  {
    rule: 'prompt-exfiltration',
    re: /(?:输出|打印|显示|复述|泄露|告诉)\s*(?:你的|完整的)?\s*(?:系统提示词|系统提示|system\s*prompt|初始指令)/i,
  },
  {
    rule: 'prompt-exfiltration-en',
    re: /\b(?:print|output|reveal|repeat|show|leak)\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions?)\b/i,
  },
  // 中文里动词常后置("系统提示词完整输出一遍"),上面那条只覆盖动词前置的写法。
  {
    rule: 'prompt-exfiltration-post',
    re: /(?:系统提示词|系统提示|初始指令)[^。\n]{0,12}?(?:输出|打印|显示|复述|泄露|贴出|告诉我)/,
  },
];

/**
 * 引号/代码围栏内的文本在检测前剥掉。
 *
 * 为什么:一条合法记忆可能正是「网页里出现『忽略之前的指令』时要当心」。那句话在
 * 原句里是**被引用的对象**,不是本记忆在命令未来 agent。剥掉引用段即可区分
 * 「使用」与「提及」,而不需要任何语义理解。
 *
 * 只处理成对出现的完整引号;单边引号(奇数个)不剥——那更可能是攻击者故意留下的
 * 半个引号想绕过检测,此时按"不剥"处理更保守。
 */
function stripQuoted(text: string): string {
  const quoted: readonly RegExp[] = [
    /```[\s\S]*?```/g,
    /`[^`\n]*`/g,
    /「[^」\n]*」/g,
    /『[^』\n]*』/g,
    /“[^”\n]*”/g,
    /"[^"\n]*"/g,
    /'[^'\n]*'/g,
  ];
  let out = text;
  for (const re of quoted) out = out.replace(re, ' ');
  return out;
}

/**
 * 该文本是否在尝试改写 agent 的控制权。返回第一条命中规则,无命中返 null。
 *
 * 只在**写入**时调用(反思 saves、`memory_save`),不在读取时调用:已落库的旧条目不
 * 因为规则变严而失效,那会让规则更新变成一次隐式的库删除。
 */
export function detectHijack(text: string): HijackHit | null {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const probe = stripQuoted(raw);
  for (const { rule, re } of HIJACK_RULES) {
    const m = re.exec(probe);
    if (m) return { rule, sample: m[0].slice(0, 120) };
  }
  return null;
}

/** 逐字重合判定用:合并空白、小写,避免缩进/换行差异把真正的复制判成"不是抄的"。 */
function normalizeForCopy(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 一条转录行的来源。`role` 是转录前缀(`user` / `assistant` / `tool` / `?`)。 */
export interface ProvenanceMatch {
  role: string;
  /** 命中的转录行(已截断,供审计与调试)。 */
  line: string;
}

/**
 * 默认的逐字重合长度。
 *
 * 60 是权衡:太短(如 20)会把"src/memory/store.ts 里有个 loadAll"这类**常识性重合**
 * 判成复制;太长(如 200)则因为 `snapshotTranscript` 把每条消息截到 600 字符、
 * 整体截到 6000 字符,长结论的原文往往已被截断,永远匹配不上。
 */
const DEFAULT_MIN_EXACT = 60;

/**
 * 在转录里找这条内容**逐字抄自**哪一行,返回该行角色。
 *
 * 用途有二,同一份实现:
 *  ① 来源追溯(R16.3):记下这条记忆的原文出现在转录的哪个角色里;
 *  ② 不可信来源判定(R16.1):来自 `tool:` 的 = 工具输出(网页/文件/命令),
 *     其可信度远低于用户亲述。
 *
 * 找不到逐字重合时返 null —— 说明它是**概括**而不是复制,那种情况下没有可靠的
 * 来源信号,不猜(与 `memory_save` 的 empty-graph 同一条原则:证据不足不下结论)。
 */
export function findSourceLine(
  text: string,
  transcript: string,
  minExact: number = DEFAULT_MIN_EXACT,
): ProvenanceMatch | null {
  const needle = normalizeForCopy(text);
  if (needle.length < minExact) return null;
  const hayLines = String(transcript ?? '').split('\n');
  const window = Math.max(20, minExact);
  for (const line of hayLines) {
    const m = /^([A-Za-z_?]+):\s?/.exec(line);
    if (!m) continue;
    const role = m[1];
    const body = normalizeForCopy(line.slice(m[0].length));
    if (body.length < window) continue;
    // 滑动窗口:任意一段 window 长的连续片段出现在记忆正文里,就视为逐字抄自该行。
    for (let i = 0; i + window <= body.length; i += 10) {
      if (needle.includes(body.slice(i, i + window))) {
        return { role, line: line.slice(0, 200) };
      }
    }
  }
  return null;
}

/** 该来源角色是否属于"不受用户控制的输入"(工具输出 / 助手的中间产物不算可信证据)。 */
export function isUntrustedRole(role: string): boolean {
  return role === 'tool' || role === 'function';
}
