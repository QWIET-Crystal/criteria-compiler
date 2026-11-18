// 漏检原因：认不出来的三类，必须分开记。
//
// 起因很具体：三篇「疑似」摊开看，原因根本不一样——
//   · 一篇是判据缺一条（耦合写在标题里）      → 该改判据
//   · 一篇是化学式被渲染成空格（H 2 O 2）      → 该清洗数据
//   · 一篇是摘要根本不提产物                   → 概念不在摘要里
//
// 三类混在一起，人就会一直去改判据，而其中两类改判据是白改。
//
// 存成独立文件（不是塞回 gold.csv），因为原因属于分析过程，不属于金标。

import fs from 'node:fs';
import path from 'node:path';

import { normalizeDoi } from './io.mjs';

export const CAUSES = {
  criterion: {
    label: '判据缺一条',
    hint: '该改判据——这是唯一一类值得动 criteria 的',
  },
  data: {
    label: '数据要清洗',
    hint: '化学式空格、缺摘要、编码问题——改判据没用，先修数据',
  },
  out_of_scope: {
    label: '概念不在摘要里',
    hint: '摘要根本没有这个概念（或金标本身存疑）——加判据也救不回来',
  },
};

const fileOf = (packDir) => path.join(packDir, 'causes.json');

export function readCauses(packDir) {
  const file = fileOf(packDir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeCause(packDir, doi, cause, note) {
  if (!CAUSES[cause]) throw new Error(`未知原因 "${cause}"，只能是：${Object.keys(CAUSES).join(' / ')}`);
  const all = readCauses(packDir);
  all[normalizeDoi(doi)] = {
    cause,
    note: note ?? all[normalizeDoi(doi)]?.note ?? '',
    at: new Date().toISOString(),
  };
  fs.writeFileSync(fileOf(packDir), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return all;
}

/** 把一批漏检按原因归类，顺便指出「哪一类占比最高、该怎么办」。 */
export function summariseCauses(rows) {
  const buckets = { criterion: [], data: [], out_of_scope: [], unknown: [] };
  for (const row of rows) {
    const cause = row.cause?.cause ?? 'unknown';
    (buckets[cause] ?? buckets.unknown).push(row);
  }
  const total = rows.length;
  let advice = null;
  if (total) {
    const ranked = ['criterion', 'data', 'out_of_scope']
      .map((key) => ({ key, count: buckets[key].length }))
      .sort((a, b) => b.count - a.count);
    const top = ranked[0];
    if (top.count >= Math.ceil(total / 2) && top.count > 0) {
      advice = top.key;
    }
  }
  return { buckets, total, advice };
}
