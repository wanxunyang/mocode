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

/** CJK 感知分词(小写)。 */
export function tokenize(input: string): string[] {
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
      tokens.push(ch); // unigram
      if (i + 1 < chars.length && CJK_RE.test(chars[i + 1])) {
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

/** BM25 多字段索引。文档量小(memory ≤百条、archive 索引),构建成本可忽略。 */
export class TextSearchIndex {
  private readonly k1: number;
  private readonly b: number;
  private readonly ids: string[];
  private readonly fieldStats: FieldStats[];
  private readonly fieldWeights: number[];

  constructor(docs: IndexableDoc[], k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
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
        const toks = tokenize(field.text);
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
    const terms = tokenize(query);
    if (terms.length === 0 || this.ids.length === 0) return [];
    const n = this.ids.length;
    const hits: SearchHit[] = [];
    for (let docId = 0; docId < n; docId++) {
      let score = 0;
      this.fieldStats.forEach((stats, f) => {
        const dl = stats.dl.get(docId);
        if (dl === undefined) return;
        const norm = this.k1 * (1 - this.b + (this.b * dl) / Math.max(stats.avgdl, 1));
        for (const term of terms) {
          const tf = stats.tf.get(term)?.get(docId);
          if (!tf) continue;
          const df = stats.df.get(term) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += ((this.fieldWeights[f] ?? 1) * (idf * (tf * (this.k1 + 1)))) / (tf + norm);
        }
      });
      if (score > 0) hits.push({ id: this.ids[docId], score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
  }
}
