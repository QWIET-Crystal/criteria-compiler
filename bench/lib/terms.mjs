// 术语提取：从「正反例」里长出区分词。
//
// 两个脚本共用：start.mjs（起草判据）和 refine.mjs（按标注改判据）。
// 抽出来的原因是——如果两份各写一套，起草和改判就会用不同标准，
// 那「越用越懂」就成了越用越飘。

const STOP = new Set(`a an the and or of for in on with by to from at as is are was were be been being
this that these those we our their its it they them us use used using based via into than then
herein study results show shows shown report reported present presents new high low two three
one both such can may also more most less very between among during within without under over
however moreover furthermore thus therefore which where while when what who whom not no non
abstract introduction conclusion method methods approach approaches paper work works figure figures
table tables data result analysis system systems model models performance effect effects
achieving achieve achieved exceeded exceeding notably promising efficient efficiency
significantly enhanced improve improved improving strategy strategies facile
respectively thereby toward towards role roles insight insights design designs
recent novel excellent superior remarkable effective successfully easily first time
due owing attributed enabled enables enable allow allows allowing provide provides provided
obtained obtain obtaining observed observe shows revealed reveals reveal found find
compared comparison relatively highly greatly largely mainly primarily
great units unit best well shown using makes make made allow gives give expected expect
including includes included future perspective perspectives unique various different several
many much widely well known widely-reported respectively referred refers refer called termed
promising potential potentials significant important key main major crucial essential`.split(/\s+/));

export function escapeRe(term) {
  return String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 词与相邻双词。双词必须是原文相邻的两个词——
 * 先过滤再拼会拼出「photosynthesis aerobic」这种根本不存在的短语。
 */
export function termsOf(work) {
  const raw = `${work.title ?? ''} ${work.abstract ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const usable = (w) => w.length >= 4 && w.length <= 30 && !STOP.has(w) && !/^\d+$/.test(w);

  const set = new Set();
  for (const word of raw) if (usable(word)) set.add(word);
  for (let i = 0; i + 1 < raw.length; i++) {
    const [a, b] = [raw[i], raw[i + 1]];
    if (!usable(a) || !usable(b)) continue;
    const bigram = `${a} ${b}`;
    if (bigram.length <= 40) set.add(bigram);
  }
  return set;
}

/**
 * 某组文献的候选词。要求：至少出现在 minCount 篇里，且不出现在排除集里。
 * 只是第一层筛选——真正的过滤在 refineAgainstPool()。
 */
export function candidateTerms(works, { minCount = 2, exclude = new Set(), limit = 40 } = {}) {
  const counter = new Map();
  for (const work of works) for (const term of termsOf(work)) counter.set(term, (counter.get(term) ?? 0) + 1);

  return [...counter.entries()]
    .filter(([term, count]) => count >= Math.min(minCount, works.length) && !exclude.has(term))
    .sort((a, b) => (b[1] - a[1]) || (b[0].split(' ').length - a[0].split(' ').length) || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

export function documentFrequency(works) {
  const size = works.length || 1;
  const df = new Map();
  for (const work of works) for (const term of termsOf(work)) df.set(term, (df.get(term) ?? 0) + 1);
  return new Map([...df].map(([term, count]) => [term, count / size]));
}

/**
 * 用同领域的池子做背景，把「通用词」筛掉。
 *
 * 只用几篇正例，「photocatalysts」这种词当然满足「正例里有、反例里没有」——
 * 它不是判据，它是这个领域的常识。要判断一个词是不是区分性的，缺的从来
 * 不是正例，是**背景分布**。
 */
export function refineAgainstPool(candidates, poolWorks, { keep = 14, thresholds = [0.15, 0.3], strict = false } = {}) {
  const df = documentFrequency(poolWorks);
  const scored = candidates.map((c) => ({ ...c, df: df.get(c.term) ?? 0 }));

  for (const maxDf of thresholds) {
    const kept = scored
      .filter((c) => c.df <= maxDf)
      .sort((a, b) => (b.count - a.count) || (a.df - b.df) || b.term.length - a.term.length)
      .slice(0, keep);
    if (kept.length >= Math.min(5, candidates.length)) return kept;
  }
  // strict：一个都过不了阈值就返回空，不要退回「按出现次数硬取」。
  // 排除信号宁可没有，也不能拿 50% 覆盖率的通用词去排掉整个领域。
  return strict ? [] : scored.slice(0, keep);
}
