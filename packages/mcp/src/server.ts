#!/usr/bin/env node
/**
 * MCP server for criteria-compiler.
 *
 * Three tools, deliberately narrow:
 *   search_candidates  multi-family recall (never single-family)
 *   check_paper        single-record inspection: normalization + rule flags
 *   coverage_report    re-run the benchmark and return the coverage table
 *
 * There is intentionally no `judge_paper`: v0.1 does not call an LLM.
 * A model-based judge belongs behind an explicit provider option in v0.2.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FAMILIES,
  FIX_QUERIES,
  STAGES,
  collect,
  evaluate,
  familyQuery,
  normalizeDoi,
  canonicalDoi,
  hasFormula,
  parseGoldCsv,
  probeDoi,
  type FamilyName,
  type GoldRecord,
  type OpenAlexWork,
} from '@criteria-compiler/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/server.js -> packages/mcp/dist -> repo root */
const GOLD_PATH = process.env.GOLD_CSV ?? path.resolve(HERE, '..', '..', '..', 'bench', 'gold.csv');

let goldCache: GoldRecord[] | null = null;
function loadGold(): GoldRecord[] {
  if (goldCache) return goldCache;
  if (!fs.existsSync(GOLD_PATH)) {
    throw new Error(`gold set not found at ${GOLD_PATH}; set GOLD_CSV to override`);
  }
  goldCache = parseGoldCsv(fs.readFileSync(GOLD_PATH, 'utf8'));
  return goldCache;
}

const server = new McpServer({ name: 'criteria-compiler', version: '0.1.0' });

const mailto = process.env.OPENALEX_MAILTO;
// Without this the server silently falls back to the shared anonymous budget and
// every search fails with an opaque 429.
const apiKey = process.env.OPENALEX_API_KEY;

server.tool(
  'search_candidates',
  {
    families: z.array(z.string()).optional().describe('Material family names, e.g. ["COF","CMP"]. Omit for all six.'),
    extraQueries: z.array(z.string()).optional().describe('Raw OpenAlex title+abstract queries to union in.'),
    cap: z.number().int().min(200).max(5000).optional(),
  },
  async ({ families, extraQueries, cap }) => {
    const names = (families?.length ? families : Object.keys(FAMILIES)) as FamilyName[];
    const unknown = names.filter((n) => !(n in FAMILIES));
    if (unknown.length) {
      return { content: [{ type: 'text', text: `unknown families: ${unknown.join(', ')}` }], isError: true };
    }
    const pool = new Map<string, OpenAlexWork>();
    // exactOptionalPropertyTypes: build the options object conditionally instead of
    // passing `{ cap: undefined }`, which is a type error under strict settings.
    const opts: { cap?: number; mailto?: string; apiKey?: string } = {};
    if (typeof cap === 'number') opts.cap = cap;
    if (mailto) opts.mailto = mailto;
    if (apiKey) opts.apiKey = apiKey;
    for (const name of names) await collect(familyQuery(name), pool, opts);
    for (const q of extraQueries ?? []) await collect(q, pool, opts);
    const sample = [...pool.values()].slice(0, 50);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ poolSize: pool.size, families: names, sample }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'check_paper',
  {
    doi: z.string().describe('DOI of the paper to inspect'),
    text: z.string().optional().describe('Optional title+abstract text, if you already have it'),
  },
  async ({ doi, text }) => {
    const key = canonicalDoi(normalizeDoi(doi));
    const flags: string[] = [];
    if (text) {
      if (hasFormula(text, 'H2O2')) flags.push('mentions H2O2');
      if (hasFormula(text, 'Bi2O2S')) flags.push('mentions Bi2O2S (space-rendered forms included)');
      if (/\bin addition\b|\bfurthermore\b/i.test(text)) flags.push('contains "In addition"/"Furthermore" — likely a separate experiment');
      if (/\bsacrificial agent\b|\bhole scavenger\b/i.test(text)) flags.push('mentions a sacrificial agent');
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              doi: key,
              flags,
              reminder: 'This tool never returns a relevance verdict. Read the figure and the solvent before deciding.',
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
    stage: z.enum(['cof-only', 'six-families', 'six-families-with-fixes']).optional(),
    cap: z.number().int().min(200).max(5000).optional(),
  },
  async ({ stage, cap }) => {
    const gold = loadGold();
    const target = STAGES.find((s) => s.name === (stage ?? 'six-families-with-fixes')) ?? STAGES[2]!;
    if (!target) return { content: [{ type: 'text', text: 'no stage' }], isError: true };
    const pool = new Map<string, OpenAlexWork>();
    const opts: { cap?: number; mailto?: string; apiKey?: string } = {};
    if (typeof cap === 'number') opts.cap = cap;
    if (mailto) opts.mailto = mailto;
    if (apiKey) opts.apiKey = apiKey;
    for (const name of target.families) await collect(familyQuery(name), pool, opts);
    if (target.fixes) {
      for (const query of Object.values(FIX_QUERIES)) await collect(query, pool, opts);
    }
    if (target.doiFallback) {
      for (const g of gold.filter((x) => Number(x.label) === 2)) {
        const key = canonicalDoi(normalizeDoi(g.doi));
        if (!pool.has(key)) await probeDoi(g.doi, pool);
      }
    }
    const result = evaluate(pool, gold);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { stage: target.name, gold: { path: GOLD_PATH, records: gold.length }, ...result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
