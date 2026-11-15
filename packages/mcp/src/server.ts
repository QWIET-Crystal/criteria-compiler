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
  },
  async ({ pack: packDir, dimensions, extraQueries, cap }) => {
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
    const sample = [...pool.values()].slice(0, 50);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ pack: pack.id, dir, poolSize: pool.size, dimensions: dims, sample }, null, 2),
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
  },
  async ({ pack: packDir, stage, cap }) => {
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
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ pack: pack.id, gold: { path: goldPathOf(pack, dir), records: gold.length }, ...result }, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
