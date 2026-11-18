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

/**
 * 一篇论文的正文：**标题和摘要之间必须有一个句号**。
 *
 * 这不是风格问题。用空格拼的时候，标题没带结尾句号就会和摘要第一句黏成一句，
 * 于是「标题里的词」和「摘要第一句里的词」被判成「同一句出现」——假共现。
 * 实测过：同一篇论文，换个拼法结论就反了。
 *
 * 所以只留这一个出口，任何地方都不许自己拼。
 */
export function workText(work) {
  const title = String(work?.title ?? '').trim();
  const abstract = String(work?.abstract ?? '').trim();
  if (!title) return abstract;
  if (!abstract) return title;
  return `${title}. ${abstract}`;
}

export function splitSentences(text) {
  return String(text ?? '')
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function spansOf(sentence, term, offset) {
  const spans = [];
  // 词边界：`synthesis` 不能匹配到 `photosynthesis` 里面。
  // 只在词的**首尾是字母**时加边界——中文、化学式、带括号的说法都不加，
  // 否则 `H 2 O 2` 这种会被自己卡住。
  const raw = String(term);
  const lead = /^[A-Za-z]/.test(raw) ? '(?<![A-Za-z0-9])' : '';
  const tail = /[A-Za-z0-9]$/.test(raw) ? '(?![A-Za-z0-9])' : '';
  const re = new RegExp(`${lead}${escapeRe(raw)}${tail}`, 'gi');
  let match;
  while ((match = re.exec(sentence)) !== null) {
    spans.push({ start: offset + match.index, end: offset + match.index + match[0].length, quote: match[0] });
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return spans;
}

/**
 * 求一组判据。返回每一项的命中与否 + 证据片段。
 * criteria: [{ id, kind, terms: string[], note?, scope?: 'any'|'title' }]
 */
export function evaluate(criteria, text, parts = {}) {
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

  /**
   * 作用域。
   *
   * 真实数据逼出来的：有三篇已知该算的论文，耦合证据写在**标题**里
   * （"Hydrogen Peroxide Production and Organic Synthesis"），摘要正文只讲 H2O2 制备。
   * 只在全文里找同句，就会漏掉它们。
   *
   * 标题本来就是一句话，而且信息密度最高——不看标题是没有道理的。
   */
  const sentencesIn = (scope) => {
    if (scope !== 'title' || !parts.title) return sentences;
    const title = String(parts.title).trim();
    const at = source.toLowerCase().indexOf(title.toLowerCase());
    if (at < 0) return sentences;
    return [{ text: title, offset: at, raw: title }];
  };

  return (criteria ?? []).map((criterion) => {
    const scope = criterion.scope ?? 'any';
    const scoped = sentencesIn(scope);
    const terms = (criterion.terms ?? []).filter(Boolean);
    const id = criterion.id ?? '(unnamed)';
    const kind = criterion.kind ?? 'any';
    const note = criterion.note ?? '';

    if (!terms.length) {
      return { id, kind, matched: false, evidence: [], note, reason: '判据没有词，视为未命中' };
    }

    if (kind === 'absent') {
      const found = [];
      for (const sentence of scoped) for (const term of terms) found.push(...spansOf(sentence.text, term, sentence.offset));
      if (found.length) {
        return { id, kind, matched: false, evidence: found.slice(0, 3), note, reason: `出现了 ${found.length} 处不该出现的说法` };
      }
      return { id, kind, matched: true, evidence: [], note, reason: '一条都没有出现' };
    }

    if (kind === 'any') {
      const found = [];
      for (const sentence of scoped) for (const term of terms) {
        const spans = spansOf(sentence.text, term, sentence.offset);
        if (spans.length) { found.push(...spans); break; }
      }
      return { id, kind, matched: found.length > 0, evidence: found.slice(0, 3), note, reason: found.length ? '命中' : '一条都没命中' };
    }

    // all / co-occur：都要求每条词都出现；co-occur 还要求落在同一句里。
    const perTerm = terms.map((term) => {
      for (const sentence of scoped) {
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
    for (const [index, sentence] of scoped.entries()) {
      const inThis = terms.map((term) => ({ term, spans: spansOf(sentence.text, term, sentence.offset) }));
      if (inThis.every((entry) => entry.spans.length)) {
        return {
          id,
          kind: 'co-occur',
          matched: true,
          // 证据给「每个词各自的命中片段」，不是整句。
          // 整句一截断，人就核对不了；给片段才能一眼看出是哪两个说法撞在一起的。
          evidence: inThis.flatMap((entry) => entry.spans.slice(0, 1)),
          note,
          reason: `${terms.length} 个说法落在第 ${index + 1} 句里`,
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
 * 判定一篇论文。**规则只写在这里一处。**
 *
 * 之前这条规则在 refine / try / ledger 里各写了一份，而且已经不一致：
 * refine 是二值（共现不中就是「不算」），try 和 ledger 是三值（还有「疑似」）。
 * 结果是同一篇论文，两个工具给两个答案——而 refine 的注释还写着「与 try 保持一致」。
 *
 * 三档的意义（来自真实记录第 33 行，学生原话「半是半不是，不好确定」）：
 *   算   共现判据命中——两个说法真的撞在一起
 *   疑似 只有泛词命中，没有共现证据
 *   不算 都没有，或踩到排除信号
 *
 * 二值会替人做一个它没资格做的决定，所以这里必须是三档。
 */
export function decide(criteria, text, parts = {}) {
  const results = evaluate(criteria, text, parts);
  const violated = results.find((r) => r.kind === 'absent' && !r.matched);
  const coOccur = results.filter((r) => r.kind === 'co-occur');
  const positive = results.filter((r) => r.kind !== 'absent' && r.matched);

  const strong = coOccur.some((r) => r.matched);
  const weak = positive.length > 0;

  let verdict;
  if (violated) verdict = '不算';
  else if (strong) verdict = '算';
  else if (weak) verdict = '疑似';
  else verdict = '不算';

  return { verdict, results, violated: Boolean(violated), strong, weak, positive };
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

  // 生成和求值必须用同一套匹配规则。
  //
  // 这里原来用 `sentence.includes(term)`——没有词边界，`synthesis` 会匹配进
  // `photosynthesis`。于是生成出一条共现判据，而求值器（有词边界）永远不命中它。
  // 实测过：生成器说「synthesis + aerobic 是共现对」，求值器说「synthesis 整篇都没有」。
  // 生成出来就死的判据，比没有更糟——它占着位置还让人以为覆盖了。
  const hits = (sentence, term) => spansOf(sentence, term, 0).length > 0;

  for (const work of positives) {
    const seenInThisWork = new Set();
    for (const sentence of splitSentences(workText(work))) {
      for (const [i, a] of (work._terms ?? []).entries()) {
        for (const b of (work._terms ?? []).slice(i + 1)) {
          if (a === b) continue;
          if (hits(sentence, a) && hits(sentence, b)) {
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
    for (const sentence of splitSentences(workText(work))) {
      for (const [i, a] of (work._terms ?? []).entries()) {
        for (const b of (work._terms ?? []).slice(i + 1)) {
          if (hits(sentence, a) && hits(sentence, b)) negativePairs.add(a < b ? `${a}||${b}` : `${b}||${a}`);
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
