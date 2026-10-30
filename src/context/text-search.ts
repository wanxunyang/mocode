// 共享全文检索:CJK 感知分词 + BM25。零依赖纯函数,供 memory 与 archive 搜索复用。
//
// 分词:ASCII/数字按词;CJK 字符同时生成 unigram 与相邻 bigram——中文词多为两字,
// 单字召回噪声大、纯 bigram 又漏掉单字成词的情况,unigram+bigram 是 Elasticsearch
// cjk analyzer 的成熟折中。
//
// 多字段加权 BM25:每个字段独立长度归一,字段分按 weight 加权求和。

export interface IndexedField {
  text: string;
  weight: number;
}

export interface IndexableDoc {
  id: string;
  fields: IndexedField[];
}

export interface SearchHit {
  id: string;
  score: number;
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

/**
 * CJK 分词粒度。默认 `both`(unigram + bigram),是生产行为;
 * 另两档只用于 R15.2 的消融对照——不给业务代码传。
 */
export type TokenizeMode = 'both' | 'bigram' | 'unigram';

/** CJK 感知分词(小写)。 */
export function tokenize(input: string, mode: TokenizeMode = 'both'): string[] {
  const text = (input ?? '').toLowerCase();
  const tokens: string[] = [];
  const chars = Array.from(text);
  let word = '';
  const flushWord = (): void => {
    if (word) {
      tokens.push(word);
      word = '';
    }
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/[a-z0-9]/.test(ch)) {
      word += ch;
      continue;
    }
    flushWord();
    if (CJK_RE.test(ch)) {
      if (mode !== 'bigram') tokens.push(ch); // unigram
      if (mode !== 'unigram' && i + 1 < chars.length && CJK_RE.test(chars[i + 1])) {
        tokens.push(ch + chars[i + 1]); // bigram
      }
    }
  }
  flushWord();
  return tokens;
}

interface FieldStats {
  /** token → 出现在该字段的文档数(df)。 */
  df: Map<string, number>;
  /** token → docId → 词频。 */
  tf: Map<string, Map<number, number>>;
  /** docId → 字段长度。 */
  dl: Map<number, number>;
  avgdl: number;
}

export interface TextSearchOptions {
  k1?: number;
  b?: number;
  /**
   * 分词粒度。**建索引与查询必须同档**——索引里存的是 token,查询侧换档就会
   * 出现「df 里没有这个词」的全零命中,看起来像检索退化,其实是口径不一致。
   * 默认 'both' 即生产行为;换档只用于 R15.2 的消融对照。
   */
  tokenizeMode?: TokenizeMode;
  /**
   * 相关性下限:要求命中至少这么多个**证据词元**,否则该文档不进结果(0 = 不过滤)。
   *
   * 为什么需要:BM25 只做排序、不做「相关与否」判定,只要有任何 token 重合就返回。
   * R15 实测生产配置下 6 条无关查询(红烧肉/申根签证/kubernetes/Photoshop/lighthouse/剪指甲)
   * **全部**被召回,误报率 100%——模型看到一堆不相干的条目,自然不再调用 `memory_search`。
   *
   * 为什么是「证据词元数」而不是「分数阈值」:BM25 分数随语料规模(N)与 idf 漂移,
   * 同一份探针在 fixture(17 条)的最优阈值是 31.94、在真实库(31 条)是 40.60,
   * 写死任何一个都会在另一套数据上失效。词元命中数是**与规模无关**的量,可移植。
   *
   * 什么算证据:长度 ≥ 2 的 token —— ASCII 词,或 CJK **bigram**。单个汉字不算:
   * 「红烧肉怎么炖」里的「肉」「好」几乎必然出现在某条记忆的正文里,这正是误报的来源。
   * 查询本身没有证据词元时(如单字查询「画」)**不过滤**,否则短查询会整片变空。
   */
  minEvidenceMatched?: number;
}

/** BM25 多字段索引。文档量小(memory ≤百条、archive 索引),构建成本可忽略。 */
export class TextSearchIndex {
  private readonly k1: number;
  private readonly b: number;
  private readonly ids: string[];
  private readonly fieldStats: FieldStats[];
  private readonly fieldWeights: number[];
  private readonly mode: TokenizeMode;
  private readonly minEvidence: number;

  constructor(docs: IndexableDoc[], k1?: number, b?: number);
  constructor(docs: IndexableDoc[], opts?: TextSearchOptions);
  constructor(docs: IndexableDoc[], k1OrOpts: number | TextSearchOptions = 1.5, b = 0.75) {
    const opts: TextSearchOptions = typeof k1OrOpts === 'number' ? { k1: k1OrOpts, b } : (k1OrOpts ?? {});
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
    this.mode = opts.tokenizeMode ?? 'both';
    this.minEvidence = Math.max(0, opts.minEvidenceMatched ?? 0);
    this.ids = docs.map((d) => d.id);
    const fieldCount = Math.max(1, ...docs.map((d) => d.fields.length));
    this.fieldWeights = Array.from({ length: fieldCount }, (_, f) => docs[0]?.fields[f]?.weight ?? 1);
    this.fieldStats = Array.from({ length: fieldCount }, () => ({
      df: new Map(),
      tf: new Map(),
      dl: new Map(),
      avgdl: 0,
    }));

    docs.forEach((doc, docId) => {
      doc.fields.forEach((field, f) => {
        const stats = this.fieldStats[f];
        const toks = tokenize(field.text, this.mode);
        stats.dl.set(docId, toks.length);
        const seen = new Set<string>();
        for (const t of toks) {
          let perDoc = stats.tf.get(t);
          if (!perDoc) {
            perDoc = new Map();
            stats.tf.set(t, perDoc);
          }
          perDoc.set(docId, (perDoc.get(docId) ?? 0) + 1);
          seen.add(t);
        }
        for (const t of seen) stats.df.set(t, (stats.df.get(t) ?? 0) + 1);
      });
    });

    const n = docs.length || 1;
    for (const stats of this.fieldStats) {
      let total = 0;
      for (const len of stats.dl.values()) total += len;
      stats.avgdl = total / n;
    }
  }

  /** 检索;无有效查询词时返回空数组(调用方自行决定是否回退全量)。 */
  search(query: string, limit = 10): SearchHit[] {
    const terms = tokenize(query, this.mode);
    if (terms.length === 0 || this.ids.length === 0) return [];
    const n = this.ids.length;
    // 下限的分子:查询里有多少「证据词元」(长度 ≥ 2)。分母与文档无关,先算一次。
    // 查询没有证据词元时(如单字「画」)整条规则退化为不过滤——短查询不该被误杀。
    const evidenceTerms = this.minEvidence > 0 ? [...new Set(terms.filter((t) => t.length >= 2))] : [];
    const needEvidence = evidenceTerms.length === 0 ? 0 : Math.min(this.minEvidence, evidenceTerms.length);
    const hits: SearchHit[] = [];
    for (let docId = 0; docId < n; docId++) {
      let score = 0;
      const matchedEvidence = needEvidence > 0 ? new Set<string>() : null;
      this.fieldStats.forEach((stats, f) => {
        const dl = stats.dl.get(docId);
        if (dl === undefined) return;
        const norm = this.k1 * (1 - this.b + (this.b * dl) / Math.max(stats.avgdl, 1));
        for (const term of terms) {
          const tf = stats.tf.get(term)?.get(docId);
          if (!tf) continue;
          if (matchedEvidence && term.length >= 2) matchedEvidence.add(term);
          const df = stats.df.get(term) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += ((this.fieldWeights[f] ?? 1) * (idf * (tf * (this.k1 + 1)))) / (tf + norm);
        }
      });
      if (score <= 0) continue;
      // 相关性下限:命中证据词元数不够就不算「相关」,无论分数多高。
      // 放在排序前而不是截断后:被过滤的文档不该占 limit 的名额。
      if (needEvidence > 0 && (matchedEvidence?.size ?? 0) < needEvidence) continue;
      hits.push({ id: this.ids[docId], score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
  }
}
