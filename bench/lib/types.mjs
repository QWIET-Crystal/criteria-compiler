// 四型分型器。
//
// 来源：skills/criteria-compiler/references/rules.md 第一节「耦合的四种型」。
// 那是课题组自己沉淀的判据表，这里把它变成可执行的检测。
//
// 设计上刻意**不给硬结论**：分型决定综述的章节骨架，定错一章整篇就歪。
// 所以只输出「哪一型的信号出现在哪一句」+ 证据强度，人确认才算。
//
//   A 载流子耦合：电子端产 H2O2、空穴端氧化底物，同体系同时进行
//       信号：simultaneous / synchronous / concurrent / co-production / coupled with，
//             且同一句里要出现产物或氧化词（否则「同时提高了稳定性」也会被算进来）
//   B H2O2 介导：H2O2 本身作氧化剂
//       信号：H2O2 as (an) oxidant / oxidized by H2O2
//   C H2O2→ROS：H2O2 先转 ·OH 再氧化
//       信号：hydroxyl radical / ·OH / •OH / DMPO / Fenton / H2O2 decomposition
//       ★ 不能只认两个字母 OH：材料名 TTPh–OH、TT-COF-OH 里也有，那不是自由基
//   D 附加/级联：产 H2O2 时伴随有机转化，允许非同体系
//       信号：tandem / stepwise / two-step / sequential
//       ★ 不能认 furthermore / moreover / in addition：这些词每篇都有

export const TYPES = {
  A: { name: '载流子耦合', short: '同体系同时：一端产 H2O2，一端氧化底物' },
  B: { name: 'H2O2 介导', short: 'H2O2 本身作氧化剂' },
  C: { name: 'H2O2→ROS', short: 'H2O2 先转 ·OH 再氧化' },
  D: { name: '附加/级联', short: '伴随有机转化，允许非同体系' },
};

// 产物词表。刻意留宽：
//   · 摘要里拼写常有出入（实测见过 cinnamonaldehyde / cinnamonmic acid），
//     卡死整词会把本该命中的句子漏掉；
//   · `value-added` 是这类论文的高频说法，几乎等同于「有价值产物」。
// 放宽的代价由「必须和同时性说法同句」这一条兜住——单有产物词不算 A 型。
const PRODUCT =
  /(furfuryl|furoic|benzylamine|benzaldehyde|benzyl|alcohol|glycerol|glycolic|methane|ethanol|cinnam\w*|amine|oxidation|valoriz\w+|upgrad\w*|synthesis of|value[\s-]?added)/i;

const DETECTORS = {
  A: (s) =>
    /\b(simultaneous\w*|synchronous\w*|concurrent\w*|co-?production|coupled with)\b/i.test(s) && PRODUCT.test(s),
  B: (s) =>
    /H\s*2\s*O\s*2[^.]{0,60}(serves? as|acts? as|used as|as an?)\s+(an?\s+)?(oxidant|oxidizing agent)/i.test(s) ||
    /(oxidized|oxidation)\s+(by|with|using)\s+H\s*2\s*O\s*2/i.test(s),
  C: (s) =>
    /hydroxyl radical/i.test(s) ||
    /[·•]\s*OH\b/.test(s) ||
    /\bDMPO\b/i.test(s) ||
    /\bFenton\b/i.test(s) ||
    /H\s*2\s*O\s*2\s+(decompos\w+|dissociat\w+)/i.test(s),
  D: (s) => /\b(tandem|stepwise|two-?step|sequential\w*)\b/i.test(s),
};

/**
 * 给一篇论文分型。
 * @param {string[]} sentences 已经切好的句子（标题会作为第一句）
 * @returns {{type: string|null, confidence: string, evidence: object, note: string}}
 */
export function detectType(sentences) {
  const fired = {};
  for (const [type, test] of Object.entries(DETECTORS)) {
    const hits = sentences.filter(test);
    if (hits.length) fired[type] = hits;
  }

  const types = Object.keys(fired);

  // 只有一型命中：直接给。
  // 多型命中：先给「更具体」的那一型——B/C 是机制，A/D 是组织方式，
  // 机制比组织方式更具体，所以 B/C 优先；同属组织方式的，A 有同时性证据比 D 强。
  const order = ['C', 'B', 'A', 'D'];
  const picked = order.find((t) => fired[t]) ?? null;

  if (!picked) {
    return {
      type: null,
      confidence: 'none',
      evidence: fired,
      note: '四条型的信号一条都没出现。不是「不属于」——是摘要里没有分型依据，需要看正文。',
    };
  }

  const only = types.length === 1;
  return {
    type: picked,
    confidence: only ? 'high' : 'medium',
    evidence: fired,
    note: only
      ? `只有 ${picked} 型的信号`
      : `同时命中 ${types.join('/')}，按「机制优先于组织方式」取 ${picked}`,
  };
}
