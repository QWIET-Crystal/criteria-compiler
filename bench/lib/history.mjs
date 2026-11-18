// 判据变更史：记录「它什么时候、因为什么、从什么改成了什么」。
//
// 为什么这不是可选项：真实检索记录里，学生问「耦合和牺牲剂的分界线是什么」，
// 学姐用了 5 个来回才答清，而且结论比第一次回答宽得多（串联也可以、不必同体系）。
// 一次快照会把这个中间态固化成永恒，然后把后来被认可的论文全部误杀。
//
// 所以每份草案都带一条 history：机器改的、人改的，都记。没有记录的变化就是耍赖。

/** 取一份草案里「会改变判断结果」的那部分。别的字段不参与比对。 */
export function snapshotOf(draft) {
  return {
    criteria: draft.criteria ?? [],
    mustHave: (draft.mustHave ?? []).map((item) => (typeof item === 'string' ? item : item.term)),
    mustNot: draft.mustNot ?? [],
  };
}

const termsOf = (snap) => new Set(snap.mustHave ?? []);
const idsOf = (snap) => new Map((snap.criteria ?? []).map((item) => [item.id, item]));

function sameCriterion(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  const ta = (a.terms ?? []).join('|');
  const tb = (b.terms ?? []).join('|');
  return ta === tb;
}

/** 两份快照之间实际变了什么。空对象表示没变。 */
export function diffSnapshot(prev, next) {
  if (!prev) return { initial: true };

  const prevIds = idsOf(prev);
  const nextIds = idsOf(next);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, criterion] of nextIds) {
    if (!prevIds.has(id)) added.push(id);
    else if (!sameCriterion(prevIds.get(id), criterion)) changed.push(id);
  }
  for (const id of prevIds.keys()) if (!nextIds.has(id)) removed.push(id);

  const prevTerms = termsOf(prev);
  const nextTerms = termsOf(next);
  const addedTerms = [...nextTerms].filter((t) => !prevTerms.has(t));
  const removedTerms = [...prevTerms].filter((t) => !nextTerms.has(t));

  // 排除词也要比。漏了这一段，删掉一条排除信号就完全不留痕——
  // 而排除信号恰恰是最危险的那类改动（它能让一整类论文消失）。
  const prevNot = new Set(prev.mustNot ?? []);
  const nextNot = new Set(next.mustNot ?? []);
  const addedExclusions = [...nextNot].filter((t) => !prevNot.has(t));
  const removedExclusions = [...prevNot].filter((t) => !nextNot.has(t));

  const empty =
    !added.length && !removed.length && !changed.length &&
    !addedTerms.length && !removedTerms.length &&
    !addedExclusions.length && !removedExclusions.length;
  return empty ? {} : { added, removed, changed, addedTerms, removedTerms, addedExclusions, removedExclusions };
}

const isEmptyDiff = (diff) => !diff || (Object.keys(diff).length === 0) || diff.initial === true;

export function describeDiff(diff) {
  if (diff.initial) return '起草';
  const parts = [];
  if (diff.added?.length) parts.push(`新增判据 ${diff.added.join('、')}`);
  if (diff.removed?.length) parts.push(`删除判据 ${diff.removed.join('、')}`);
  if (diff.changed?.length) parts.push(`改写判据 ${diff.changed.join('、')}`);
  if (diff.addedTerms?.length) parts.push(`加入词 ${diff.addedTerms.join('、')}`);
  if (diff.removedTerms?.length) parts.push(`移除词 ${diff.removedTerms.join('、')}`);
  if (diff.addedExclusions?.length) parts.push(`新增排除词 ${diff.addedExclusions.join('、')}`);
  if (diff.removedExclusions?.length) parts.push(`移除排除词 ${diff.removedExclusions.join('、')}`);
  return parts.join('；') || '无实质变化';
}

/**
 * 往草案里追加一条变更记录。
 * snapshot 记的是**改完之后**的状态，这样下一次跑的时候能拿它比对出人手工改了什么。
 */
export function appendHistory(draft, entry) {
  const history = [...(draft.history ?? [])];
  history.push({
    version: entry.version ?? (history.length ? history[history.length - 1].version + 1 : 1),
    at: entry.at ?? new Date().toISOString(),
    by: entry.by ?? 'unknown',
    what: entry.what ?? '未命名变更',
    why: entry.why ?? null,
    diff: entry.diff ?? null,
    snapshot: entry.snapshotOverride ?? snapshotOf(draft),
  });
  return { ...draft, history };
}

/** 上一次记录的快照。没有就返回 null（说明这份草案从没记过史）。 */
export function lastSnapshot(draft) {
  const history = draft.history ?? [];
  if (!history.length) return null;
  return history[history.length - 1].snapshot ?? null;
}

export { isEmptyDiff };
