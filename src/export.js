#!/usr/bin/env node
/**
 * Roll the per-domain CSVs up into one row per company:
 *
 *   company_name,domain,redirect_count,redirect_domains
 *
 * `redirect_count` is host.io's own total for the domain (from the run
 * summary), which can exceed the number of domains listed — host.io serves at
 * most 48 per domain. `redirect_domains` holds what was actually collected,
 * pipe-separated so the cell stays safe to split.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv, readCompanyList, writeCsv } from './csv.js';
import { normalizeDomain } from './parse.js';

export const COMBINED_HEADER = ['company_name', 'domain', 'redirect_count', 'redirect_domains'];
const SEPARATOR = '|';

const read = (file) => readFile(file, 'utf8').then(parseCsv, () => null);

/** Index a run summary by target domain. */
async function readSummary(outDir) {
  const rows = await read(path.join(outDir, '_summary.csv'));
  const byDomain = new Map();
  if (!rows) return byDomain;
  const header = rows[0].map((c) => c.trim());
  const col = (name) => header.indexOf(name);
  for (const row of rows.slice(1)) {
    const domain = normalizeDomain(row[col('target_domain')]);
    if (!domain) continue;
    // A resumed run appends, so the last row for a domain is the current one.
    byDomain.set(domain, {
      reportedTotal: row[col('reported_total')],
      status: row[col('status')],
    });
  }
  return byDomain;
}

/** Read the domains collected for one target. */
async function readDomainCsv(outDir, domain) {
  const rows = await read(path.join(outDir, `${domain}.csv`));
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).map((row) => row[0]).filter(Boolean);
}

export async function buildCombined(companyFile, outDir) {
  const companies = await readCompanyList(companyFile);
  const summary = await readSummary(outDir);
  const out = [];
  for (const { domain, company } of companies) {
    const normalized = normalizeDomain(domain);
    const collected = await readDomainCsv(outDir, normalized);
    const entry = summary.get(normalized);
    const reported = entry && entry.reportedTotal !== '' ? Number(entry.reportedTotal) : null;
    const count = Number.isFinite(reported) ? reported : collected.length;
    out.push([company, normalized, count, collected.join(SEPARATOR)]);
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : args[i + 1];
  };
  const companyFile = get('--input', 'input/tier2_gtm_companies.csv');
  const outDir = get('--results', 'tier2-output');
  const target = get('--out', path.join(outDir, 'companies_redirects.csv'));
  const rows = await buildCombined(companyFile, outDir);
  await writeCsv(target, COMBINED_HEADER, rows);
  const withData = rows.filter((r) => r[3]).length;
  console.log(`${rows.length} companies -> ${target} (${withData} with redirect domains)`);
}
