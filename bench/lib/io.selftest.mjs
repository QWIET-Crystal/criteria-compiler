// io 层自测：CSV 解析与 BOM。
//
// BOM 这类问题不报错，只是让某个字段安静地取不到值——最难查的那种。

import { csvEscape, labelOf, latestArtifact, parseCsv, worksFromCsv } from './io.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// ── 基本 CSV ────────────────────────────────────────────────────────────────
{
  const rows = parseCsv('doi,title\n10.1/a,"A, with comma"\n10.1/b,plain\n');
  check('解析两行', rows.length === 2, String(rows.length));
  check('引号里的逗号不切分', rows[0].title === 'A, with comma', rows[0].title);
}

// ── 引号转义 ────────────────────────────────────────────────────────────────
{
  const rows = parseCsv('doi,title\n10.1/a,"He said ""hi"""\n');
  check('两个引号还原成一个', rows[0].title === 'He said "hi"', rows[0].title);
}

// ── BOM ─────────────────────────────────────────────────────────────────────
{
  // Excel / PowerShell 导出的 CSV 常带 BOM。不剥掉的话表头会变成 "\uFEFFdoi"，
  // 于是每一行的 doi 都取不到——而且不报错。
  const rows = parseCsv('\uFEFFdoi,title\n10.1/a,t\n');
  check('BOM 被剥掉，doi 列可用', rows[0].doi === '10.1/a', JSON.stringify(rows[0]));
}

// ── 空行与结尾换行 ──────────────────────────────────────────────────────────
{
  const rows = parseCsv('doi,title\n\n10.1/a,t\n\n');
  check('空行被跳过', rows.length === 1, String(rows.length));
}

// ── labelOf ─────────────────────────────────────────────────────────────────
{
  check('2 → 2', labelOf({ verdict: '2' }) === 2);
  check('0 → 0', labelOf({ verdict: '0' }) === 0);
  check('1 → 1', labelOf({ verdict: '1' }) === 1);
  check('空 → null', labelOf({ verdict: '' }) === null);
  check('缺列 → null', labelOf({}) === null);
}

// ── csvEscape ───────────────────────────────────────────────────────────────
{
  check('引号被替换成单引号', csvEscape('a"b') === '"a\'b"', csvEscape('a"b'));
}

// ── latestArtifact：版本号要比大小，不是比字符串 ─────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-selftest-'));
  try {
    for (const name of ['draft.json', 'draft-v2.json', 'draft-v10.json', 'draft-v9.json']) {
      fs.writeFileSync(path.join(dir, name), '{}', 'utf8');
    }
    const latest = latestArtifact(dir, 'draft', 'json');
    check('v10 胜过 v9（按数字比，不按字典序）', path.basename(latest) === 'draft-v10.json', path.basename(latest));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── worksFromCsv：缺 abstract 也要能读 ──────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-selftest-'));
  try {
    const file = path.join(dir, 'w.csv');
    fs.writeFileSync(file, 'doi,title,abstract\n10.1/a,A,t\n10.1/b,B,\n', 'utf8');
    const map = worksFromCsv(file);
    check('读入两篇', map.size === 2, String(map.size));
    check('没有摘要的记成空串而不是 undefined', map.get('10.1/b').abstract === '', String(map.get('10.1/b').abstract));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
