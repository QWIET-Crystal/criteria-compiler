/**
 * Gold-set parsing. Pure: takes CSV text, returns records. No fs.
 *
 * The gold set is the only thing in this project that cannot be generated,
 * so it is kept deliberately boring: DOI + label + why.
 */
export interface GoldRecord {
  doi: string;
  label: number; // 2 = positive, 1 = partial, 0 = negative
  couplingType: string;
  materialScope: string;
  hasAbstract: boolean | null;
  note: string;
  line: number;
}

const HEADER = ['doi', 'label', 'coupling_type', 'material_scope', 'has_abstract', 'note'];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseGoldCsv(text: string): GoldRecord[] {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => l.trim().length > 0);
  if (headerIndex < 0) return [];

  const head = splitCsvLine(lines[headerIndex]!).map((h) => h.trim().toLowerCase());
  const missing = HEADER.filter((h) => !head.includes(h));
  if (missing.length) {
    throw new Error(`gold.csv is missing column(s): ${missing.join(', ')}`);
  }
  const at = (row: string[], name: string) => (row[head.indexOf(name)] ?? '').trim();

  const records: GoldRecord[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    const row = splitCsvLine(lines[i]!);
    const doi = at(row, 'doi');
    if (!doi) continue;
    const label = Number(at(row, 'label'));
    if (![0, 1, 2].includes(label)) {
      throw new Error(`gold.csv line ${i + 1}: label must be 0, 1 or 2 (got "${at(row, 'label')}")`);
    }
    const hasAbstractRaw = at(row, 'has_abstract').toLowerCase();
    records.push({
      doi,
      label,
      couplingType: at(row, 'coupling_type'),
      materialScope: at(row, 'material_scope'),
      hasAbstract: hasAbstractRaw === 'yes' ? true : hasAbstractRaw === 'no' ? false : null,
      note: at(row, 'note'),
      line: i + 1,
    });
  }
  return records;
}

export function positives(records: GoldRecord[]): GoldRecord[] {
  return records.filter((r) => r.label === 2);
}

export function negatives(records: GoldRecord[]): GoldRecord[] {
  return records.filter((r) => r.label === 0);
}
