#!/usr/bin/env node
/**
 * MCP server for criteria-compiler.
 *
 * Every tool takes an optional `pack` (a directory). The server itself knows no
 * domain: it loads whatever pack it is pointed at and reports what that pack
 * defines. Without a gold set a pack can be searched but not scored.
 *
 * There is intentionally no LLM judge in v0.1.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  collect,
  defaultPackDir,
  evaluate,
  goldPathOf,
  loadPackFromDir,
  normalizeDoi,
  canonicalDoi,
  hasFormula,
  parseGoldCsv,
  runStage,
  orExpr,
  slotExpr,
  slotsOf,
  stagesOf,
  type GoldRecord,
  type OpenAlexWork,
} from '@criteria-compiler/core';

const server = new McpServer({ name: 'criteria-compiler', version: '0.1.0' });

const mailto = process.env.OPENALEX_MAILTO;
const apiKey = process.env.OPENALEX_API_KEY;

const goldCache = new Map<string, GoldRecord[]>();
function loadGold(dir: string, packGold: string | null): GoldRecord[] | null {
  if (!packGold) return null;
  const cached = goldCache.get(dir);
  if (cached) return cached;
  if (!fs.existsSync(packGold)) return null;
  const records = parseGoldCsv(fs.readFileSync(packGold, 'utf8'));
  goldCache.set(dir, records);
  return records;
}

function options(cap: number | undefined): { cap?: number; mailto?: string; apiKey?: string } {
  const opts: { cap?: number; mailto?: string; apiKey?: string } = {};
  if (typeof cap === 'number') opts.cap = cap;
  if (mailto) opts.mailto = mailto;
  if (apiKey) opts.apiKey = apiKey;
  return opts;
}

server.tool(
  'search_candidates',
  {
    pack: z.string().optional().describe('Pack directory. Omit to use $CRITERIA_PACK_DIR, else packs/default.json.'),
    dimensions: z.array(z.string()).optional().describe('Dimension ids to query. Omit for all axes of the pack.'),
    extraQueries: z.array(z.string()).optional().describe('ExtraQuery ids to add. Omit for none.'),
    cap: z.number().int().min(100).max(2000).optional(),
    sampleSize: z
      .number()
      .int()
      .min(0)
      .max(200)
      .optional()
      .describe('How many rows to inline. Defaults to 50. The full pool is only reachable via dumpPath.'),
    dumpPath: z
      .string()
      .optional()
      .describe('Write the WHOLE pool to this CSV path and return only the path and count. Use this for downstream work — the inline sample is for eyeballing, not for processing.'),
  },
  async ({ pack: packDir, dimensions, extraQueries, cap, sampleSize, dumpPath }) => {
    const dir = packDir ?? defaultPackDir();
    const pack = loadPackFromDir(dir);
    const known = new Set(pack.dimensions.map((d) => d.id));
    const dims = dimensions?.length ? dimensions : pack.dimensions.map((d) => d.id);
    const unknown = dims.filter((d) => !known.has(d));
    if (unknown.length) {
      return { content: [{ type: 'text', text: `unknown dimensions: ${unknown.join(', ')}` }], isError: true };
    }

    const knownExtras = new Map((pack.extraQueries ?? []).map((e) => [e.id, e]));
    const extras = extraQueries ?? [];
    const badExtras = extras.filter((id) => !knownExtras.has(id));
    if (badExtras.length) {
      return { content: [{ type: 'text', text: `unknown extraQueries: ${badExtras.join(', ')}` }], isError: true };
    }

    const stage = {
      id: 'adhoc',
      label: 'ad-hoc selection',
      queries: [
        ...dims.map((id) => {
          const dim = pack.dimensions.find((d) => d.id === id)!;
          return `${orExpr(dim.terms)} AND ${slotExpr(pack)}`;
        }),
        ...extras.map((id) => knownExtras.get(id)!.query),
      ],
      doiFallback: false,
    };

    const pool = new Map<string, OpenAlexWork>();
    for (const query of stage.queries) await collect(query, pool, options(cap));

    const all = [...pool.values()].sort((a, b) => (b.cited ?? 0) - (a.cited ?? 0));
    const limit = sampleSize ?? 50;

    // 池子才是产物，样本只是给你看一眼。
    // 之前只能拿到 50 条，使用者为了下游处理绕到 bench --dump 写 CSV —— 那本来就是这里该做的事。
    let dumped: { path: string; rows: number } | null = null;
    if (dumpPath) {
      const esc = (v: unknown) => {
        const text = String(v ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const csv = ['doi,year,cited,title']
        .concat(all.map((w) => [w.doi, w.year ?? '', w.cited ?? 0, w.title].map(esc).join(',')))
        .join('\r\n');
      const resolved = path.resolve(dumpPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `\uFEFF${csv}\r\n`, 'utf8');
      dumped = { path: resolved, rows: all.length };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              pack: pack.id,
              dir,
              poolSize: pool.size,
              dimensions: dims,
              // 说清楚这份清单是怎么来的、按什么筛的 —— 这是使用者最缺的一句话。
              provenance: {
                queries: stage.queries,
                cap: cap ?? null,
                sampleInlined: Math.min(limit, all.length),
                fullPoolOnlyViaDump: !dumped,
              },
              dumped,
              sample: all.slice(0, limit),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'check_paper',
  {
    doi: z.string().describe('DOI of the paper'),
    text: z.string().optional().describe('Optional title+abstract; slot terms and pack checks are matched against it'),
    pack: z.string().optional().describe('Pack directory. Omit to use the default pack.'),
  },
  async ({ doi, text, pack: packDir }) => {
    const dir = packDir ?? defaultPackDir();
    const pack = loadPackFromDir(dir);
    const key = canonicalDoi(normalizeDoi(doi));

    const slots = slotsOf(pack).map((slot) => ({
      slot: slot.id,
      matched: text ? slot.terms.filter((t) => hasFormula(text, t)) : [],
      total: slot.terms.length,
    }));

    const flags: { id: string; note: string | null; matched: boolean }[] = (pack.checks ?? []).map((check) => {
      let matched = false;
      if (text) {
        try {
          if (check.absent) matched = !new RegExp(check.absent, 'i').test(text);
          else if (check.pattern) matched = new RegExp(check.pattern, 'i').test(text);
        } catch {
          matched = false;
        }
      }
      return { id: check.id, note: check.note ?? null, matched };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              doi: key,
              pack: pack.id,
              slots,
              checks: flags,
              reminder: 'No verdict is returned. Read the figure and the solvent before deciding.',
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'coverage_report',
  {
    pack: z.string().optional().describe('Pack directory. Omit to use the default pack.'),
    stage: z.string().optional().describe('Stage id defined by the pack. Defaults to the last stage.'),
    cap: z.number().int().min(100).max(2000).optional(),
    dumpPath: z
      .string()
      .optional()
      .describe('Write the full report to this JSON path and inline only a summary. Full stage C can take ~1 min and may exceed the client tool timeout; dumping plus a summary keeps the response small.'),
  },
  async ({ pack: packDir, stage, cap, dumpPath }) => {
    const dir = packDir ?? defaultPackDir();
    const pack = loadPackFromDir(dir);
    const gold = loadGold(dir, goldPathOf(pack, dir));
    if (!gold) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { pack: pack.id, dir, retrievalOnly: true, reason: 'no gold set in this pack; coverage cannot be computed' },
              null,
              2,
            ),
          },
        ],
      };
    }
    const stages = stagesOf(pack);
    const target = stage ?? stages[stages.length - 1]!.id;
    const result = await runStage(pack, target, gold, options(cap));
    const full = { pack: pack.id, gold: { path: goldPathOf(pack, dir), records: gold.length }, ...result };

    if (dumpPath) {
      const resolved = path.resolve(dumpPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
      // 只回摘要：完整报告在文件里，别让它撑爆消息体。
      const summary = Object.fromEntries(
        Object.entries(full).filter(([key]) => !['perQuery', 'sample', 'queries'].includes(key)),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...summary, dumped: resolved }, null, 2) }],
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(full, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
