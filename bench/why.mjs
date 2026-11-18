#!/usr/bin/env node
// 记一句「为什么」。
//
// D4 的变更史能记「改了什么」，但「为什么改」只有人知道——脚本猜出来的理由是
// 「检测到手改」，那不是理由，是观察。
//
// 这条命令只做一件事：把一句人话钉在当前的判据版本上。
// 两周后有人问「当初为什么把这条共现删了」，答案就在这儿。
//
// Usage:
//   node bench/why.mjs --pack _h --note "学姐说串联也算，删掉同体系的限制"
//   node bench/why.mjs --pack _h --list          # 只看已经记了哪些

import fs from 'node:fs';
import path from 'node:path';

import { readDraft, ROOT } from './lib/io.mjs';
import { appendHistory } from './lib/history.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PACK_ARG = argValue('--pack', '');
if (!PACK_ARG) {
  console.error('用法：node bench/why.mjs --pack <包名> --note "为什么"｜--list');
  process.exit(1);
}

const PACK_DIR = (() => {
  const asPath = path.resolve(PACK_ARG);
  if (fs.existsSync(path.join(asPath, 'draft.json'))) return asPath;
  const under = path.join(ROOT, 'packs', PACK_ARG);
  return fs.existsSync(under) ? under : asPath;
})();

const draft = readDraft(PACK_DIR, argValue('--draft', ''));
if (!draft) {
  console.error(`\n${path.relative(ROOT, PACK_DIR)} 下没有 draft.json。\n`);
  process.exit(1);
}

const notes = (draft.data.history ?? []).filter((entry) => entry.by === 'human' && entry.what === '说明');

if (argv.includes('--list')) {
  console.log(`\n已经记下的「为什么」 · ${path.relative(ROOT, draft.file)}`);
  console.log('─'.repeat(78));
  if (!notes.length) {
    console.log('  还没有。');
    console.log('  变更史能记「改了什么」，但「为什么」只有人知道——脚本猜出来的不是理由。');
  } else {
    for (const note of notes) {
      const at = String(note.at ?? '').replace('T', ' ').slice(0, 16);
      console.log(`  ${at}  ${note.why}`);
    }
  }
  process.exit(0);
}

const note = argValue('--note', '').trim();
if (!note) {
  console.error('用法：node bench/why.mjs --pack <包名> --note "为什么"｜--list');
  process.exit(1);
}

const next = appendHistory(draft.data, {
  by: 'human',
  what: '说明',
  why: note,
  diff: null,
});

fs.writeFileSync(draft.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

console.log(`\n记下了 · ${path.relative(ROOT, draft.file)}`);
console.log('─'.repeat(78));
console.log(`  ${note}`);
console.log(`\n  它钉在这一版判据上（${(next.criteria ?? []).length} 条判据）。`);
console.log('  判据以后再改，这条说明会留在原来的版本旁边——查「当时为什么这么定」就靠它。');
