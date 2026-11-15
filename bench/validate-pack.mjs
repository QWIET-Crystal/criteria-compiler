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
