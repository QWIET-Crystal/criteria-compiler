// 分型器自测。重点是把「看似像其实不是」的几种情况钉住。
import { detectType } from './types.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
};

// ── A 型：必须同时性说法 + 产物 ─────────────────────────────────────────────
{
  const r = detectType(['Furfuryl alcohol valorization coupled with H2O2 production.']);
  check('A：simultaneous/coupled + 产物 → A', r.type === 'A', r.type);
  check('A：只命中一型时置信 high', r.confidence === 'high', r.confidence);
}
{
  // 「同时提高了稳定性」不是耦合
  const r = detectType(['The material simultaneously improved stability and selectivity.']);
  check('A：同时性词没有产物 → 不算 A', r.type !== 'A', r.type);
}

// ── C 型：不能把材料名里的 OH 当自由基 ──────────────────────────────────────
{
  const r = detectType(['We synthesized TTPh-OH and TT-COF-OH by a solvothermal route.']);
  check('C：材料名 TTPh-OH 不触发 C', r.type !== 'C', r.type);
}
{
  const r = detectType(['DMPO trapping confirmed the generation of ·OH.']);
  check('C：DMPO / ·OH → C', r.type === 'C', r.type);
}

// ── D 型：只认明确的阶段词 ─────────────────────────────────────────────────
{
  const r = detectType(['Furthermore, the material was tested in another reaction.']);
  check('D：furthermore 不触发 D', r.type !== 'D', r.type);
}
{
  const r = detectType(['A tandem photocatalytic strategy integrates H2O2 generation with in situ utilization.']);
  check('D：tandem → D', r.type === 'D', r.type);
}

// ── 多型同时命中：机制优先 ─────────────────────────────────────────────────
{
  const r = detectType(['A tandem process where H2O2 serves as an oxidant.']);
  check('多型：B 比 D 更具体，取 B', r.type === 'B', r.type);
  check('多型：置信降为 medium', r.confidence === 'medium', r.confidence);
}

// ── 一条都没有：不许瞎猜 ───────────────────────────────────────────────────
{
  const r = detectType(['We report a new material with a high surface area.']);
  check('无信号：返回 null 而不是硬猜', r.type === null, String(r.type));
  check('无信号：说明是「摘要没依据」而不是「不属于」', /没有分型依据/.test(r.note), r.note);
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
