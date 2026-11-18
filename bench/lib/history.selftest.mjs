// 变更史的自测：重点是「人改的」能不能被认出来。
//
// 这个仓库里最容易被悄悄破坏的一环就是它——历史少了，判据还是很能跑，
// 只是过两周没人说得清「当时为什么这么定」。

import { appendHistory, describeDiff, diffSnapshot, isEmptyDiff, lastSnapshot, snapshotOf } from './history.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const BASE = {
  criteria: [
    { id: 'core-any', kind: 'any', terms: ['a', 'b'] },
    { id: 'exclusion', kind: 'absent', terms: ['z'] },
  ],
  mustHave: [{ term: 'a' }, { term: 'b' }],
  mustNot: ['z'],
};

// ── 没变就是没变 ────────────────────────────────────────────────────────────
check('同一份快照：diff 为空', isEmptyDiff(diffSnapshot(snapshotOf(BASE), snapshotOf({ ...BASE }))));

// ── 删掉一条判据要被认出来 ──────────────────────────────────────────────────
{
  const edited = { ...BASE, criteria: BASE.criteria.filter((c) => c.id !== 'exclusion') };
  const diff = diffSnapshot(snapshotOf(BASE), snapshotOf(edited));
  check('删了一条判据：能认出来', diff.removed?.includes('exclusion'), JSON.stringify(diff));
  check('删了一条判据：不影响别的', !diff.removed.includes('core-any'));
}

// ── 改词也要被认出来 ────────────────────────────────────────────────────────
{
  const edited = { ...BASE, mustHave: [{ term: 'a' }, { term: 'c' }] };
  const diff = diffSnapshot(snapshotOf(BASE), snapshotOf(edited));
  check('词表变了：能认出来', diff.addedTerms?.includes('c') && diff.removedTerms?.includes('b'), JSON.stringify(diff));
}

// ── 只改措辞不算变更 ────────────────────────────────────────────────────────
{
  const edited = { ...BASE, criteria: BASE.criteria.map((c) => ({ ...c, note: '换了个说明' })) };
  check('只改 note：不算变更', isEmptyDiff(diffSnapshot(snapshotOf(BASE), snapshotOf(edited))));
}

// ── 追加记录后，snapshot 记的是改完的状态 ────────────────────────────────────
{
  const edited = { ...BASE, criteria: [BASE.criteria[0]] };
  const drafted = appendHistory(BASE, { by: 'start.mjs', what: '起草', diff: { initial: true } });
  const next = appendHistory({ ...edited, history: drafted.history }, { by: 'human', what: '删掉 exclusion' });
  check('记录追加成功', next.history.length === 2);
  check('版本号递增', next.history[1].version === 2);
  check('最后一份快照是改完后的状态', lastSnapshot(next).criteria.length === 1);
  check(
    '下一次比对能认出「自上次之后没再改」',
    isEmptyDiff(diffSnapshot(lastSnapshot(next), snapshotOf(edited))),
  );
}

// ── 描述要说得清人话 ────────────────────────────────────────────────────────
{
  const edited = { ...BASE, criteria: [BASE.criteria[1]], mustNot: [] };
  const text = describeDiff(diffSnapshot(snapshotOf(BASE), snapshotOf(edited)));
  check('描述里提到删掉的判据', text.includes('core-any'), text);
  check('描述里提到移除的词', text.includes('z'), text);
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
