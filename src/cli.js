#!/usr/bin/env node
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildConfig, USAGE } from './config.js';
import { createLogger } from './logger.js';
import { normalizeDomain } from './parse.js';
import { openBrowser, scrapeDomain } from './scraper.js';
import { appendCsv, readDomainList, writeCsv } from './csv.js';

const DOMAIN_CSV_HEADER = [
  'redirecting_domain', 'target_domain', 'title', 'description',
  'source_url', 'page', 'checked_at',
];

const SUMMARY_HEADER = [
  'target_domain', 'redirecting_domain_count', 'reported_total', 'pages_scraped',
  'status', 'error', 'csv_file', 'checked_at',
];

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
        summaryRows.push([
          domain, result.rows.length, result.total ?? '', result.pages,
          result.status, '', path.relative(config.outDir, csvFile), result.checkedAt,
        ]);
        log.info(`[${position}] ${domain}: ${result.rows.length} redirecting domain(s) -> ${csvFile}`);
      } catch (error) {
        failures += 1;
        const kind = error.name === 'BlockedError' ? error.kind : 'error';
        summaryRows.push([
          domain, 0, '', 0, kind, error.message, '', new Date().toISOString(),
        ]);
        log.error(`[${position}] ${domain}: ${kind} — ${error.message}`);
      }
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (summaryRows.length) {
    summaryRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (config.resume && (await exists(config.summaryPath))) {
      await appendCsv(config.summaryPath, SUMMARY_HEADER, summaryRows);
    } else {
      await writeCsv(config.summaryPath, SUMMARY_HEADER, summaryRows);
    }
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
