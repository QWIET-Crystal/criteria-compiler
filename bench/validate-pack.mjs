#!/usr/bin/env node
/**
 * Validate domain packs.
 *
 * A pack is the only place a field is allowed to exist. This script is the
 * guard: it checks that every pack is structurally sound and that its gold set
 * is real, without knowing anything about the field itself.
 *
 * Usage:
 *   node bench/validate-pack.mjs              # every pack under packs/ except _template
 *   node bench/validate-pack.mjs packs/cof-h2o2
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PACKS_ROOT = path.join(ROOT, 'packs');

const errors = [];
const warnings = [];
const fail = (pack, msg) => errors.push(`${pack}: ${msg}`);
const warn = (pack, msg) => warnings.push(`${pack}: ${msg}`);

function listPacks(explicit) {
  if (explicit.length) return explicit.map((p) => path.resolve(p));
  if (!fs.existsSync(PACKS_ROOT)) return [];
  return fs
    .readdirSync(PACKS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => path.join(PACKS_ROOT, d.name));
}

function parseGold(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const head = lines[0].split(',').map((h) => h.trim());
  const labelAt = head.indexOf('label');
  const doiAt = head.indexOf('doi');
  if (labelAt < 0) throw new Error('gold.csv has no "label" column');
  if (doiAt < 0) throw new Error('gold.csv has no "doi" column');
  const rows = lines.slice(1);
  const labels = rows.map((r) => Number(r.split(',')[labelAt]));
  return {
    rows: rows.length,
    positives: labels.filter((l) => l === 2).length,
    partials: labels.filter((l) => l === 1).length,
    negatives: labels.filter((l) => l === 0).length,
    bad: labels.filter((l) => ![0, 1, 2].includes(l)).length,
  };
}

// ── 三条离线检查：都是实测让人白跑一趟的坑 ──────────────────────────────────
//
// 共同点：**不跑一次就发现不了，而跑了才发现要重跑。** 这类错误必须在校验阶段拦。

/**
 * 单复数。
 *
 * 检索按字面匹配：`"covalent organic framework"` 匹配不到 frameworks。
 * 一位使用者实测：18 条正例只找到 9 条，补上复数变成 16 条。
 * 这不是某个领域的问题，是所有加引号的人都会遇到。
 */
function pluralOf(word) {
  const w = word.toLowerCase();
  if (!/^[a-z-]+$/.test(w)) return null;          // 缩写、化学式、带数字的不猜
  if (w.length < 4) return null;
  if (/(ss|us|is)$/.test(w)) return null;         // analysis / glass / status

  // 不可数 / 名词化后缀：这些词本来就没有复数。
  // 没有这一条，校验会报出 "chart answerings"、"satellite imageries" 这种鬼话，
  // 39 条警告等于没有警告——噪音会把真正的坑淹掉。
  if (/(ing|tion|sion|ment|ity|ness|ship|ance|ence|age|ery|ics|ism|ology)$/.test(w)) return null;

  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  if (/s$/.test(w)) return null;                  // 已经像复数了
  return `${w}s`;
}

function phrasalWarnings(pack, name, terms, where) {
  // 豁免要写进包里，不能靠口头说「这个不用管」。
  // 比如 hydrogen peroxide 是化学名，没有复数形式——这种例外必须留痕，
  // 否则下次有人看到警告会以为漏了，改出一个「hydrogen peroxides」。
  const exempt = new Set((pack.pluralExempt ?? []).map((t) => String(t).toLowerCase()));
  for (const term of terms) {
    const text = String(term);
    if (exempt.has(text.toLowerCase())) continue;
    if (/[*?]/.test(text)) {
      fail(name, `${where} 的 "${text}" 含通配符：title_and_abstract.search 不接受 * 或 ?，请求会直接 400`);
    }
    const words = text.trim().split(/\s+/);
    if (words.length < 2) continue;
    const last = words[words.length - 1];
    const plural = pluralOf(last);
    if (!plural) continue;
    const variant = [...words.slice(0, -1), plural].join(' ');
    if (terms.some((t) => String(t).toLowerCase() === variant)) continue;
    warn(
      name,
      `${where} 的 "${text}" 只有单数。加引号后按字面匹配，${plural} 找不到——` +
      `实测有人 18 条正例只找回 9 条，补上复数变 16 条。建议同时列 "${variant}"`,
    );
  }
}

const validated = [];

for (const dir of listPacks(process.argv.slice(2))) {
  const name = path.basename(dir);
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) {
    fail(name, 'missing pack.json');
    continue;
  }

  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(name, `pack.json is not valid JSON: ${err.message}`);
    continue;
  }

  for (const key of ['id', 'title', 'dimensions', 'stages']) {
    if (!pack[key]) fail(name, `missing required field "${key}"`);
  }

  // Either one object slot or several. Several are ANDed, which is how a
  // two-subject intersection (method × application) is expressed.
  const slots = pack.slots ?? (pack.object ? [{ id: 'object', terms: pack.object.terms }] : []);
  if (!slots.length) fail(name, 'needs either "object" or "slots"');
  if (pack.slots && pack.object) warn(name, 'both "object" and "slots" present; "object" is ignored');
  const slotIds = new Set();
  for (const slot of slots) {
    if (!slot.id) fail(name, 'slot without id');
    else if (slotIds.has(slot.id)) fail(name, `duplicate slot id "${slot.id}"`);
    else slotIds.add(slot.id);
    if (!Array.isArray(slot.terms) || !slot.terms.length) fail(name, `slot ${slot.id} has no terms`);
    else if (slot.terms.length === 1) warn(name, `slot ${slot.id} has a single term`);
    else phrasalWarnings(pack, name, slot.terms, `槽位 ${slot.id}`);
  }
  if (pack.id !== name) warn(name, `id "${pack.id}" does not match directory name "${name}"`);
  if (!/^\d+\.\d+\.\d+$/.test(pack.version ?? '')) warn(name, 'version should be semver (x.y.z)');

  const dims = pack.dimensions ?? [];
  if (!dims.length) fail(name, 'dimensions is empty');
  const dimIds = new Set();
  for (const dim of dims) {
    if (!dim.id) fail(name, 'dimension without id');
    else if (dimIds.has(dim.id)) fail(name, `duplicate dimension id "${dim.id}"`);
    else dimIds.add(dim.id);
    if (!Array.isArray(dim.terms) || !dim.terms.length) fail(name, `dimension ${dim.id} has no terms`);
    else if (dim.terms.length === 1) warn(name, `dimension ${dim.id} has a single term`);
    else phrasalWarnings(pack, name, dim.terms, `维度 ${dim.id}`);
    if (!dim.scope) warn(name, `dimension ${dim.id} has no scope; coverage accounting needs one`);
  }

  const extras = pack.extraQueries ?? [];
  const extraIds = new Set();
  for (const extra of extras) {
    if (!extra.id) fail(name, 'extraQuery without id');
    else if (extraIds.has(extra.id)) fail(name, `duplicate extraQuery id "${extra.id}"`);
    else extraIds.add(extra.id);
    if (!extra.query) fail(name, `extraQuery ${extra.id} has no query`);
    if (!extra.why) fail(name, `extraQuery ${extra.id} has no "why" — every correction must name what it recovers`);
    if (/[*?]/.test(extra.query)) {
      fail(name, `extraQuery ${extra.id} 的查询里含通配符：title_and_abstract.search 按词干检索，不接受 * / ?，会 400`);
    }
  }

  // 豁免列表本身也要校验：写了个不存在的词，等于给自己开了个空头免责声明。
  for (const item of pack.pluralExempt ?? []) {
    const text = String(item).toLowerCase();
    const usedSomewhere = [SLOTS.flatMap((s2) => s2.terms ?? []), dims.flatMap((d) => d.terms ?? []), extras.map((e) => e.query ?? '')]
      .flat()
      .some((t) => String(t).toLowerCase().includes(text));
    if (!usedSomewhere) warn(name, `pluralExempt 里的 "${item}" 在包里根本没出现，删掉它`);
  }

  // 时间窗口：不给就说明白「时间只能事后筛」，别让人以为工具会管。
  if (pack.dateWindow) {
    for (const key of ['since', 'until']) {
      const value = pack.dateWindow[key];
      if (value == null) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        fail(name, `dateWindow.${key} 必须是 YYYY-MM-DD，现在是 "${value}"`);
      }
    }
    if (pack.dateWindow.since && pack.dateWindow.until && pack.dateWindow.since > pack.dateWindow.until) {
      fail(name, 'dateWindow.since 晚于 until，这个窗口永远是空的');
    }
  } else {
    warn(name, '没有 dateWindow：检索语句里不带日期，「近三年」只能检索完再筛。文献综述里「新」很靠前，建议显式给一个窗口');
  }

  const checks = pack.checks ?? [];
  const checkIds = new Set();
  for (const check of checks) {
    if (!check.id) fail(name, 'check without id');
    else if (checkIds.has(check.id)) fail(name, `duplicate check id "${check.id}"`);
    else checkIds.add(check.id);
    if (!check.pattern && !check.absent) {
      fail(name, `check ${check.id} has neither pattern nor absent`);
    } else {
      for (const [kind, source] of [['pattern', check.pattern], ['absent', check.absent]]) {
        if (!source) continue;
        try {
          new RegExp(source, 'i');
        } catch (err) {
          fail(name, `check ${check.id} has an invalid ${kind} regex: ${err.message}`);
        }
      }
    }
  }

  const stages = pack.stages ?? [];
  if (!stages.length) fail(name, 'stages is empty');
  const stageIds = new Set();
  for (const stage of stages) {
    if (!stage.id) fail(name, 'stage without id');
    else if (stageIds.has(stage.id)) fail(name, `duplicate stage id "${stage.id}"`);
    else stageIds.add(stage.id);
    if (!stage.label) warn(name, `stage ${stage.id} has no label`);
    const dimsRef = stage.dimensions ?? [];
    if (!dimsRef.length) fail(name, `stage ${stage.id} selects no dimensions`);
    for (const ref of dimsRef) {
      if (ref !== '*' && !dimIds.has(ref)) fail(name, `stage ${stage.id} references unknown dimension "${ref}"`);
    }
    for (const ref of stage.extraQueries ?? []) {
      if (ref !== '*' && !extraIds.has(ref)) fail(name, `stage ${stage.id} references unknown extraQuery "${ref}"`);
    }
  }

  validated.push(pack);

  if (pack.gold) {    const goldFile = path.join(dir, pack.gold);
    if (!fs.existsSync(goldFile)) {
      fail(name, `gold file "${pack.gold}" not found`);
    } else {
      try {
        const stats = parseGold(goldFile);
        if (stats.bad) fail(name, `gold.csv has ${stats.bad} label(s) that are not 0/1/2`);
        if (stats.positives < 3) warn(name, `only ${stats.positives} positive(s); percentages will be unstable`);
        if (!stats.negatives) warn(name, 'no negative examples; the judge is untested against look-alikes');
        console.log(`  ${name}: gold ${stats.rows} rows (${stats.positives}+ / ${stats.partials}~ / ${stats.negatives}-)`);
      } catch (err) {
        fail(name, `gold.csv unusable: ${err.message}`);
      }
    }
  } else {
    console.log(`  ${name}: retrieval-only (no gold set)`);
  }
}

// Rule: terms go straight into a boolean query, so they must not be able to
// break out of the quoted phrase. Mirrors assertSafeTerm() in packages/core/src/pack.ts.
const SAFE_TERM = /^[\p{L}\p{N}\s\-.,()+/'’·]+$/u;
for (const pack of validated) {
  const slots = pack.slots ?? (pack.object ? [pack.object] : []);
  const all = [
    ...slots.flatMap((s) => s.terms ?? []),
    ...(pack.dimensions ?? []).flatMap((d) => d.terms ?? []),
  ];
  for (const term of all) {
    const value = String(term ?? '').trim();
    if (!value) fail(pack.id, 'empty term');
    else if (value.length > 80) fail(pack.id, `term is longer than 80 characters: ${JSON.stringify(value.slice(0, 30))}…`);
    else if (!SAFE_TERM.test(value)) fail(pack.id, `term can break the query grammar: ${JSON.stringify(value)}`);
  }
}

// Rule: the engine must not know a pack's vocabulary.
// Collect every declared term and fail if one appears under packages/*/src.
const terms = new Map();
for (const pack of validated) {
  const slots = pack.slots ?? (pack.object ? [pack.object] : []);
  const all = [
    ...slots.flatMap((s) => s.terms ?? []),
    ...(pack.dimensions ?? []).flatMap((d) => d.terms ?? []),
  ];
  for (const t of all) {
    const key = String(t).toLowerCase();
    // Short acronyms produce false positives inside ordinary words.
    if (key.length >= 4) terms.set(key, pack.id);
  }
}

try {
  const root = path.join(ROOT, 'packages');
  const files = fs
    .readdirSync(root, { recursive: true })
    .filter(
      (f) =>
        typeof f === 'string' &&
        f.endsWith('.ts') &&
        f.split(path.sep).includes('src') &&
        !f.split(path.sep).includes('node_modules'),
    );
  let leaks = 0;
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      for (const [term, packId] of terms) {
        if (line.includes(term)) {
          fail('engine', `packages/${rel.split(path.sep).join('/')}:${i + 1} contains "${term}" from pack ${packId}`);
          if (++leaks >= 10) break;
        }
      }
      if (leaks >= 10) break;
    }
    if (leaks >= 10) break;
  }
  if (!leaks) console.log(`  engine: no pack term appears under packages/*/src (${terms.size} terms checked)`);
} catch (err) {
  warn('engine', `could not scan packages/ for pack terms: ${err.message}`);
}

for (const w of warnings) console.warn(`warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error ${e}`);
  console.error(`\npack validation failed: ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`\npack validation ok${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
