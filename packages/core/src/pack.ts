import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A pack is the only place a field is allowed to exist.
 * Nothing in this module (or in the engine) may name a domain term.
 */
export interface Slot {
  id: string;
  role?: string;
  terms: string[];
  note?: string;
}

export interface Dimension {
  id: string;
  terms: string[];
  scope?: string;
  note?: string;
}

export interface ExtraQuery {
  id: string;
  query: string;
  why?: string;
}

/** A text test to flag on a single paper. Belongs to the domain, not the engine. */
export interface Check {
  id: string;
  /** Flagged when this pattern matches the text. */
  pattern?: string;
  /**
   * Flagged when this pattern does NOT match the text — an absence signal.
   * Needed for criteria like "the abstract never says the two things happen
   * at the same time", which no positive pattern can express.
   */
  absent?: string;
  note?: string;
}

export interface StageDef {
  id: string;
  label: string;
  dimensions: string[];
  extraQueries?: string[];
  doiFallback?: boolean;
}

export interface Pack {
  id: string;
  title?: string;
  version?: string;
  description?: string;
  /** One-slot shorthand. Ignored when `slots` is present. */
  object?: { id?: string; terms: string[]; note?: string };
  /** One or more slots; all of them are ANDed. */
  slots?: Slot[];
  dimensions: Dimension[];
  extraQueries?: ExtraQuery[];
  checks?: Check[];
  stages: StageDef[];
  gold?: string | null;
  evaluation?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface Stage {
  id: string;
  label: string;
  queries: string[];
  doiFallback: boolean;
}

const quote = (t: string): string => `"${assertSafeTerm(t)}"`;

/**
 * Terms are interpolated into a boolean query string, so one that contains a
 * quote or a backslash can end the phrase early and inject query syntax. A
 * shared pack could then silently widen what gets retrieved, with nothing in the
 * results to show it happened. Allowlist only — keep this in sync with the same
 * check in bench/validate-pack.mjs.
 */
const SAFE_TERM = /^[\p{L}\p{N}\s\-.,()+/'’·]+$/u;
const MAX_TERM_LENGTH = 80;

export function assertSafeTerm(term: string): string {
  const value = String(term ?? '').trim();
  if (!value) throw new Error('pack term is empty');
  if (value.length > MAX_TERM_LENGTH) {
    throw new Error(`pack term is longer than ${MAX_TERM_LENGTH} characters`);
  }
  if (!SAFE_TERM.test(value)) {
    throw new Error(`pack term contains characters that can break the query grammar: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A disjunction of terms. Phrases are quoted so multi-word terms stay phrases. */
export function orExpr(terms: string[]): string {
  return `(${terms.map(quote).join(' OR ')})`;
}

/** Normalise `object` and `slots` into one list. */
export function slotsOf(pack: Pack): Slot[] {
  const slots = pack.slots ?? (pack.object ? [{ id: pack.object.id ?? 'object', terms: pack.object.terms }] : []);
  if (!slots.length) throw new Error(`pack ${pack.id}: needs "object" or "slots"`);
  for (const slot of slots) {
    if (!slot.id) throw new Error(`pack ${pack.id}: slot without id`);
    if (!Array.isArray(slot.terms) || !slot.terms.length) throw new Error(`pack ${pack.id}: slot ${slot.id} has no terms`);
  }
  return slots;
}

/** All slots, ANDed. Two-subject intersections are expressed here, not in code. */
export function slotExpr(pack: Pack): string {
  return slotsOf(pack)
    .map((slot) => orExpr(slot.terms))
    .join(' AND ');
}

export function dimensionQuery(pack: Pack, dimensionId: string): string {
  const dim = pack.dimensions.find((d) => d.id === dimensionId);
  if (!dim) throw new Error(`pack ${pack.id}: unknown dimension "${dimensionId}"`);
  return `${orExpr(dim.terms)} AND ${slotExpr(pack)}`;
}

/** Expand stage definitions into concrete queries. Pure: no fs, no network. */
export function stagesOf(pack: Pack): Stage[] {
  const extras = new Map((pack.extraQueries ?? []).map((e) => [e.id, e]));
  return pack.stages.map((stage) => {
    if (!stage.id) throw new Error(`pack ${pack.id}: stage without id`);
    const dimIds = stage.dimensions.includes('*') ? pack.dimensions.map((d) => d.id) : stage.dimensions;
    const extraIds = (stage.extraQueries ?? []).includes('*') ? [...extras.keys()] : (stage.extraQueries ?? []);
    return {
      id: stage.id,
      label: stage.label,
      queries: [
        ...dimIds.map((id) => dimensionQuery(pack, id)),
        ...extraIds.map((id) => {
          const extra = extras.get(id);
          if (!extra) throw new Error(`pack ${pack.id}: stage ${stage.id} references unknown extraQuery "${id}"`);
          return extra.query;
        }),
      ],
      doiFallback: Boolean(stage.doiFallback),
    };
  });
}

export function loadPackFromDir(dir: string): Pack {
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) throw new Error(`no pack.json in ${dir}`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8')) as Pack;
  if (!pack.id) throw new Error(`${file}: missing "id"`);
  if (!Array.isArray(pack.dimensions) || !pack.dimensions.length) throw new Error(`${file}: missing "dimensions"`);
  if (!Array.isArray(pack.stages) || !pack.stages.length) throw new Error(`${file}: missing "stages"`);
  slotsOf(pack);
  stagesOf(pack); // fail on bad references before anything runs
  return pack;
}

/**
 * Where the default pack lives. The engine never names a pack: the choice lives
 * in data (`$CRITERIA_PACK_DIR`, `packs/default.json`, or a single pack dir).
 */
function packsRootNearModule(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'packs');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not running from a file URL */
  }
  return null;
}

export function defaultPackDir(): string {
  if (process.env.CRITERIA_PACK_DIR) return process.env.CRITERIA_PACK_DIR;

  const roots = [path.resolve(process.cwd(), 'packs'), packsRootNearModule()].filter(Boolean) as string[];
  for (const root of roots) {
    const pointer = path.join(root, 'default.json');
    if (fs.existsSync(pointer)) {
      const { pack } = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { pack?: string };
      if (pack) return path.join(root, pack);
    }
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name);
    if (dirs.length === 1) return path.join(root, dirs[0]!);
  }
  throw new Error('no pack found: set CRITERIA_PACK_DIR, add packs/default.json, or pass --pack');
}

export function goldPathOf(pack: Pack, dir: string): string | null {
  return pack.gold ? path.resolve(dir, pack.gold) : null;
}
