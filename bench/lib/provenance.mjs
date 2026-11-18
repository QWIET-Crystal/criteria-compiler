// 来历与口径。
//
// 一位使用者说过：四句开场白比三个工具加起来有用，尤其「这份清单是从哪来的、按什么筛的」。
// 他就是在这一句上栽的，而且是他先栽的——说明连熟手都会漏。
//
// 那就不该只是文档里的一段话。每份产物旁边都要能回答三个问题：
//   builtFrom    输入是什么（哪几篇正例、哪几篇反例、哪些种子）
//   filteredBy   按什么筛的（哪些查询、日期窗口、上限、丢了什么）
//   notIncluded  明确没做什么（没查全文、没查引文网络……）
//
// 第三项最容易省，也最容易误导人：「找不到」和「没找」是两件事。

import fs from 'node:fs';
import path from 'node:path';

const fileOf = (packDir) => path.join(packDir, 'provenance.json');

/** 一条产物的来历。字段可以缺，但缺的会被标成 unknown——不允许静默省略。 */
export function make({ tool, builtFrom = {}, filteredBy = {}, notIncluded = [], limits = [] } = {}) {
  // 省略 null：不相关的字段（起草阶段没有种子）不该印成「未记录」。
  // 真正该警惕的「没记录」是整份 provenance.json 不存在，那由读的地方报。
  const filled = (obj, keys) =>
    Object.fromEntries(keys.filter((key) => obj[key] != null).map((key) => [key, obj[key]]));
  return {
    tool,
    generatedAt: new Date().toISOString(),
    builtFrom: filled(builtFrom, ['positives', 'negatives', 'seeds', 'want']),
    filteredBy: filled(filteredBy, ['queries', 'dateWindow', 'cap', 'poolSize', 'dropped', 'extraQueries']),
    notIncluded,
    limits,
  };
}

export function read(packDir) {
  const file = fileOf(packDir);
  if (!fs.existsSync(file)) return { artifacts: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { artifacts: {} };
  }
}

/** 记一条。按产物名合并，后来的覆盖前面的——同一份产物只保留最近一次的口径。 */
export function record(packDir, artifact, data) {
  const all = read(packDir);
  all.pack = all.pack ?? path.basename(packDir);
  all.artifacts = all.artifacts ?? {};
  all.artifacts[artifact] = { ...all.artifacts[artifact], ...data };
  fs.writeFileSync(fileOf(packDir), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return all;
}

/** 没有记录就叫「没记录」，不许假装有。 */
export const UNKNOWN = '（未记录）';

export function describe(entry) {
  if (!entry) return null;
  const lines = [];
  const { builtFrom = {}, filteredBy = {}, notIncluded = [], limits = [] } = entry;

  if (builtFrom.want) lines.push(`要做的事：${builtFrom.want}`);
  if (builtFrom.positives?.length) lines.push(`正例 ${builtFrom.positives.length} 篇：${builtFrom.positives.join('、')}`);
  if (builtFrom.negatives?.length) lines.push(`反例 ${builtFrom.negatives.length} 篇：${builtFrom.negatives.join('、')}`);
  if (builtFrom.seeds?.length) lines.push(`种子 ${builtFrom.seeds.length} 篇`);
  // 只印真的给了的。给了但为空（比如 seeds: []）也要印——那不是「没记录」，是「零篇」。
  for (const key of ['positives', 'negatives', 'seeds']) {
    if (Array.isArray(builtFrom[key]) && builtFrom[key].length === 0) lines.push(`${key}：0 篇`);
  }

  if (filteredBy.queries) lines.push(`发起查询：${filteredBy.queries} 条`);
  if (filteredBy.dateWindow) lines.push(`时间窗口：${filteredBy.dateWindow.since ?? '不限'} → ${filteredBy.dateWindow.until ?? '不限'}`);
  else if (entry.explicitNoDateWindow) lines.push('时间窗口：无（日期只能事后筛）');
  if (filteredBy.cap) lines.push(`单条查询上限：${filteredBy.cap}`);
  if (filteredBy.poolSize != null) lines.push(`候选池：${filteredBy.poolSize} 篇`);
  if (filteredBy.dropped != null) lines.push(`丢弃的通用词：${filteredBy.dropped}`);

  if (notIncluded.length) {
    lines.push('明确没做：');
    for (const item of notIncluded) lines.push(`  · ${item}`);
  }
  if (limits.length) {
    lines.push('已知局限：');
    for (const item of limits) lines.push(`  · ${item}`);
  }
  return lines;
}

/** 这些是几乎所有产物都适用的「没做」。写死在这里，是为了不让每个调用方都忘记写。 */
export const STANDARD_NOT_INCLUDED = [
  '没有取全文，只用标题与摘要',
  '没有查引文网络（参考文献、被引）',
  '非英文、无摘要的记录不会被召回',
];
