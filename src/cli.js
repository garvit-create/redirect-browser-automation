#!/usr/bin/env node
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildConfig, USAGE } from './config.js';
import { createLogger } from './logger.js';
import { normalizeDomain } from './parse.js';
import { openBrowser, scrapeDomain } from './scraper.js';
import { appendCsv, parseCsv, readDomainList, writeCsv } from './csv.js';

const DOMAIN_CSV_HEADER = [
  'redirecting_domain', 'target_domain', 'reported_total', 'listing',
  'source_url', 'checked_at',
];

const SUMMARY_HEADER = [
  'target_domain', 'redirecting_domain_count', 'reported_total', 'listing',
  'pages_scraped', 'status', 'error', 'source_url', 'csv_file', 'checked_at',
];

/** Existing summary rows, or [] when there is no readable summary yet. */
async function readSummaryRows(file) {
  const { readFile } = await import('node:fs/promises');
  try {
    const rows = parseCsv(await readFile(file, 'utf8')).filter((r) => r.some((c) => c !== ''));
    return rows.slice(1); // drop the header
  } catch {
    return [];
  }
}

/** Collapse a multi-line driver error into one short CSV-friendly line. */
function errorLine(error) {
  const message = String(error?.message || error);
  return message.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 300);
}

const exists = (file) => access(file).then(() => true, () => false);

/** Run `task` over `items` with at most `limit` in flight. */
async function pool(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function main(argv) {
  const config = buildConfig(argv);
  if (config.help) {
    console.log(USAGE);
    return 0;
  }

  const log = createLogger(config.logLevel);

  if (!(await exists(config.input))) {
    log.error(`Input file not found: ${config.input}`);
    return 1;
  }

  const raw = await readDomainList(config.input);
  const seen = new Set();
  let domains = [];
  for (const entry of raw) {
    const domain = normalizeDomain(entry);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  if (config.limit) domains = domains.slice(0, config.limit);

  if (domains.length === 0) {
    log.error(`No usable domains in ${config.input}`);
    return 1;
  }

  await mkdir(config.outDir, { recursive: true });
  log.info(`Scraping ${domains.length} domain(s) with concurrency ${config.concurrency}`);

  const { browser, context } = await openBrowser(config);
  const summaryRows = [];
  let failures = 0;

  // Rows for domains this run is not touching are carried over: a run over a
  // handful of domains must not drop the rest of an existing summary. Rows are
  // then appended as domains finish, so an interrupted run keeps its counts.
  const inherited = (await readSummaryRows(config.summaryPath))
    .filter((row) => !seen.has(row[0]));
  await writeCsv(config.summaryPath, SUMMARY_HEADER, inherited);
  const record = async (row) => {
    summaryRows.push(row);
    await appendCsv(config.summaryPath, SUMMARY_HEADER, [row]);
  };

  try {
    await pool(domains, config.concurrency, async (domain, index) => {
      const csvFile = path.join(config.outDir, `${domain}.csv`);
      const position = `${index + 1}/${domains.length}`;

      if (config.resume && !config.force && (await exists(csvFile))) {
        log.info(`[${position}] ${domain}: skipped (CSV already exists)`);
        return;
      }

      try {
        const result = await scrapeDomain(context, domain, config, log);
        await writeCsv(
          csvFile,
          DOMAIN_CSV_HEADER,
          result.rows.map((row) => DOMAIN_CSV_HEADER.map((key) => row[key])),
        );
        await record([
          domain, result.rows.length, result.total ?? '', result.listing,
          result.pages, result.status, '', result.sourceUrl,
          path.relative(config.outDir, csvFile), result.checkedAt,
        ]);
        const of = result.total === null ? '' : ` of ${result.total} reported`;
        log.info(`[${position}] ${domain}: ${result.rows.length}${of} (${result.listing}, via ${result.via}) -> ${csvFile}`);
      } catch (error) {
        failures += 1;
        const kind = error.name === 'BlockedError' ? error.kind : 'error';
        await record([
          domain, 0, '', '', 0, kind, errorLine(error), '', '',
          new Date().toISOString(),
        ]);
        log.error(`[${position}] ${domain}: ${kind} — ${errorLine(error)}`);
      }
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (summaryRows.length || inherited.length) {
    // Rewrite in domain order now the appended, completion-ordered rows are in.
    const all = [...inherited, ...summaryRows]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    await writeCsv(config.summaryPath, SUMMARY_HEADER, all);
    log.info(`Summary written to ${config.summaryPath}`);
  }

  return failures > 0 ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  },
);
