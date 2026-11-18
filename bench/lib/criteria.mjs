// 判据求值器：四种形式，四种都**给得出原文**。
//
// 为什么要有这一层：数「命中了几个词」分不开正例和无关论文——实测里唯一正例命中 6 个，
// 一篇无关综述命中 7 个。词频不携带这个信息，但「两个说法出现在同一句里」携带。
//
// 四种形式，都是领域无关的，具体词全部来自配置包：
//   any       任一命中                    （原来的 pattern）
//   all       全部命中                     （合取）
//   co-occur  全部命中，且落在同一句里      （共现——这才是缺的那一件）
//   absent    一个都不许有                  （排除信号）
//
// 每条都返回命中位置与原文片段。**给不出原文的判据，不许存在**——这是「能查」的底线。

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+|[\r\n]+/;

export function splitSentences(text) {
  return String(text ?? '')
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function spansOf(sentence, term, offset) {
  const spans = [];
  const re = new RegExp(escapeRe(term), 'gi');
  let match;
  while ((match = re.exec(sentence)) !== null) {
    spans.push({ start: offset + match.index, end: offset + match.index + match[0].length, quote: match[0] });
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return spans;
}

/**
 * 求一组判据。返回每一项的命中与否 + 证据片段。
 * criteria: [{ id, kind, terms: string[], note?, window? }]
 */
export function evaluate(criteria, text) {
  const source = String(text ?? '');
  const sentences = [];
  {
    // 逐句跑一遍，同时记下每句在原文里的起点，好回填偏移。
    let cursor = 0;
    for (const piece of source.split(SENTENCE_SPLIT)) {
      const at = source.indexOf(piece, cursor);
      if (piece.trim()) sentences.push({ text: piece, offset: at >= 0 ? at : cursor, raw: piece });
      cursor = at >= 0 ? at + piece.length : cursor;
    }
  }

  return (criteria ?? []).map((criterion) => {
    const terms = (criterion.terms ?? []).filter(Boolean);
    const id = criterion.id ?? '(unnamed)';
    const kind = criterion.kind ?? 'any';
    const note = criterion.note ?? '';

    if (!terms.length) {
      return { id, kind, matched: false, evidence: [], note, reason: '判据没有词，视为未命中' };
    }

    if (kind === 'absent') {
      const found = [];
      for (const sentence of sentences) for (const term of terms) found.push(...spansOf(sentence.text, term, sentence.offset));
      if (found.length) {
        return { id, kind, matched: false, evidence: found.slice(0, 3), note, reason: `出现了 ${found.length} 处不该出现的说法` };
      }
      return { id, kind, matched: true, evidence: [], note, reason: '一条都没有出现' };
    }

    if (kind === 'any') {
      const found = [];
      for (const sentence of sentences) for (const term of terms) {
        const spans = spansOf(sentence.text, term, sentence.offset);
        if (spans.length) { found.push(...spans); break; }
      }
      return { id, kind, matched: found.length > 0, evidence: found.slice(0, 3), note, reason: found.length ? '命中' : '一条都没命中' };
    }

    // all / co-occur：都要求每条词都出现；co-occur 还要求落在同一句里。
    const perTerm = terms.map((term) => {
      for (const sentence of sentences) {
        const spans = spansOf(sentence.text, term, sentence.offset);
        if (spans.length) return { term, spans, sentence };
      }
      return { term, spans: [], sentence: null };
    });
    const missing = perTerm.filter((entry) => !entry.spans.length);

    if (kind === 'all') {
      const evidence = perTerm.flatMap((entry) => entry.spans.slice(0, 1));
      return {
        id, kind, matched: missing.length === 0, evidence,
        note,
        reason: missing.length ? `缺：${missing.map((m) => m.term).join('、')}` : '全部出现',
      };
    }

    // co-occur：找一句里同时出现全部词。
    for (const sentence of sentences) {
      const inThis = terms.map((term) => ({ term, spans: spansOf(sentence.text, term, sentence.offset) }));
      if (inThis.every((entry) => entry.spans.length)) {
        return {
          id, kind: 'co-occur', matched: true,
          evidence: [{ start: sentence.offset, end: sentence.offset + sentence.text.length, quote: sentence.text.slice(0, 240) }],
          note,
          reason: `${terms.length} 个说法落在同一句里`,
        };
      }
    }
    const anywhere = perTerm.filter((entry) => entry.spans.length).map((entry) => entry.term);
    return {
      id, kind: 'co-occur', matched: false, evidence: [],
      note,
      reason: anywhere.length
        ? `分别出现但不在同一句：${anywhere.join('、')}${missing.length ? `；整篇都没有：${missing.map((m) => m.term).join('、')}` : ''}`
        : '都没有出现',
    };
  });
}

/**
 * 从正反例里找「共现对」。
 *
 * 一个 (A, B) 要成为判据，必须同时满足：
 *   - 在 ≥minPos 篇正例的**同一句**里一起出现
 *   - 在**任何**一篇反例的同一句里都没一起出现
 *
 * 第二条是最容易偷懒的地方：只查「反例里有没有 B」是不够的，要查「有没有一起出现」。
 */
export function findCooccurrences(positives, negatives, { minPos = 2, limit = 8 } = {}) {
  const pairs = new Map(); // "a||b" -> count
  const pairSentence = new Map();

  for (const work of positives) {
    const seenInThisWork = new Set();
    for (const sentence of splitSentences(`${work.title ?? ''}. ${work.abstract ?? ''}`)) {
      const lower = sentence.toLowerCase();
      for (const [i, a] of (work._terms ?? []).entries()) {
        for (const b of (work._terms ?? []).slice(i + 1)) {
          if (a === b) continue;
          if (lower.includes(a) && lower.includes(b)) {
            const key = a < b ? `${a}||${b}` : `${b}||${a}`;
            if (!seenInThisWork.has(key)) { seenInThisWork.add(key); pairSentence.set(key, sentence.slice(0, 200)); }
          }
        }
      }
    }
    for (const key of seenInThisWork) pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  const negativePairs = new Set();
  for (const work of negatives) {
    for (const sentence of splitSentences(`${work.title ?? ''}. ${work.abstract ?? ''}`)) {
      const lower = sentence.toLowerCase();
      for (const [i, a] of (work._terms ?? []).entries()) {
        for (const b of (work._terms ?? []).slice(i + 1)) {
          if (lower.includes(a) && lower.includes(b)) negativePairs.add(a < b ? `${a}||${b}` : `${b}||${a}`);
        }
      }
    }
  }

  return [...pairs.entries()]
    .filter(([key, count]) => count >= minPos && !negativePairs.has(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => {
      const [a, b] = key.split('||');
      return { terms: [a, b], positiveCount: count, sample: pairSentence.get(key) ?? '' };
    });
}
