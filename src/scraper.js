import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectBlock,
  normalizeDomain,
  parseDomainPage,
  parseRedirectsPage,
} from './parse.js';

// Resolved through require() so a globally installed Playwright (as in some
// container images) works without a local node_modules copy.
const require = createRequire(import.meta.url);

function loadChromium() {
  try {
    return require('playwright').chromium;
  } catch (error) {
    throw new Error(
      'Playwright is not available. Install it with `npm install` in this project, ' +
      `or point NODE_PATH at an existing installation. (${error.message})`,
    );
  }
}

const trimSlash = (url) => url.replace(/\/+$/, '');
export const domainUrl = (domain, baseUrl = 'https://host.io') =>
  `${trimSlash(baseUrl)}/${encodeURIComponent(normalizeDomain(domain))}`;
export const redirectsUrl = (domain, page = 1, baseUrl = 'https://host.io') => {
  const base = `${trimSlash(baseUrl)}/redirects/${encodeURIComponent(normalizeDomain(domain))}`;
  return page > 1 ? `${base}?page=${page}` : base;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

/**
 * Launch a browser and build a context shared by all workers.
 *
 * Following Camoufox's guidance, the context is kept internally consistent
 * (engine's own user agent, one locale/timezone, a real viewport) rather than
 * spoofing a user agent the rest of the fingerprint would contradict.
 */
export async function openBrowser(config) {
  const browser = await loadChromium().launch({ headless: !config.headful });
  const context = await browser.newContext({
    userAgent: config.userAgent || undefined,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    storageState: config.storageState || undefined,
  });
  context.setDefaultTimeout(config.timeout);
  context.setDefaultNavigationTimeout(config.timeout);

  // Results are plain HTML; skipping heavy assets keeps runs fast and polite.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  return { browser, context };
}

export class BlockedError extends Error {
  constructor(kind, url) {
    super(`host.io returned a ${kind} page for ${url}`);
    this.name = 'BlockedError';
    this.kind = kind;
  }
}

/** Read a loaded page, raising on block pages. */
async function htmlOf(page, url) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const html = await page.content();
  const blocked = detectBlock(html);
  if (blocked) throw new BlockedError(blocked, url);
  return html;
}

/**
 * Open a domain's host.io page.
 *
 * By default this starts at the host.io homepage and uses its search box, the
 * way a person would; `--direct` navigates straight to /<domain> instead.
 */
async function openDomainPage(page, domain, config, log) {
  const target = normalizeDomain(domain);
  const direct = domainUrl(target, config.baseUrl);

  if (!config.direct) {
    const home = trimSlash(config.baseUrl) + '/';
    const response = await page.goto(home, { waitUntil: 'domcontentloaded' });
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()} for ${home}`);

    const search = page.locator('form[action="/search"] input[name="domain"]').last();
    await search.waitFor({ state: 'visible', timeout: config.timeout });
    await search.click();
    await search.fill('');
    await search.type(target, { delay: jitter(60) }); // typed, not pasted
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: config.timeout }),
      search.press('Enter'),
    ]);

    const landed = page.url();
    if (new RegExp(`/${target.replace(/\./g, '\\.')}(?:[/?#]|$)`, 'i').test(landed)) {
      return { html: await htmlOf(page, landed), url: landed, via: 'search' };
    }
    log.warn(`${target}: search landed on ${landed}; falling back to a direct URL`);
  }

  const response = await page.goto(direct, { waitUntil: 'domcontentloaded' });
  const status = response ? response.status() : 0;
  if (status === 429 || status === 503) throw new BlockedError('rate_limited', direct);
  if (status >= 400) throw new Error(`HTTP ${status} for ${direct}`);
  return { html: await htmlOf(page, direct), url: direct, via: 'direct' };
}

/** Run `attempt` with retries and exponential backoff. */
async function withRetries(config, log, label, attempt) {
  let lastError;
  for (let tries = 1; tries <= config.retries + 1; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (tries > config.retries) break;
      const backoff = jitter(config.backoff * 2 ** (tries - 1));
      log.warn(`${label} failed (${String(error.message).split('\n')[0]}); retry ${tries}/${config.retries} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

async function dump(config, name, html) {
  if (!config.saveHtml) return;
  await mkdir(config.debugDir, { recursive: true });
  await writeFile(path.join(config.debugDir, name), html, 'utf8');
}

/**
 * Follow the "Show All" listing (/redirects/<domain>).
 *
 * host.io serves this page with a 404 *status* while returning a real listing
 * in the body — roughly 48 domains for anonymous visitors, with the rest
 * behind their API. So the body is parsed first and the status only decides
 * what to do when there is nothing in it.
 *
 * Returns null when no listing could be read, so the caller keeps the sample.
 */
async function scrapeFullList(context, target, config, log) {
  const rows = [];
  const seen = new Set();
  let pageNum = 1;
  let pages = 0;

  while (pageNum && pages < config.maxPages) {
    const url = redirectsUrl(target, pageNum, config.baseUrl);
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = response ? response.status() : 0;
      if (status === 429 || status === 503) throw new BlockedError('rate_limited', url);

      const html = await htmlOf(page, url);
      await dump(config, `${target}-full-p${pageNum}.html`, html);
      const parsed = parseRedirectsPage(html, target, pageNum);
      pages += 1;

      if (parsed.domains.length === 0) {
        if (status >= 400 && rows.length === 0) {
          log.debug(`${target}: no listing on ${url} (HTTP ${status})`);
          return null;
        }
        break;
      }

      let added = 0;
      for (const entry of parsed.domains) {
        if (seen.has(entry.domain)) continue;
        seen.add(entry.domain);
        rows.push({ redirecting_domain: entry.domain, source_url: url });
        added += 1;
      }
      if (added === 0) break;
      if (config.limitPerDomain && rows.length >= config.limitPerDomain) {
        rows.length = config.limitPerDomain;
        break;
      }
      pageNum = parsed.nextPage;
      if (pageNum) await sleep(jitter(config.delay));
    } finally {
      await page.close().catch(() => {});
    }
  }

  return rows.length ? { rows, pages } : null;
}

/**
 * Collect the domains redirecting to one company domain.
 *
 * @returns {Promise<{domain: string, rows: object[], total: number|null,
 *                    listing: string, status: string, sourceUrl: string}>}
 */
export async function scrapeDomain(context, domain, config, log) {
  const target = normalizeDomain(domain);
  const checkedAt = new Date().toISOString();

  const { html, url, via } = await withRetries(config, log, `${target} page`, async () => {
    const page = await context.newPage();
    try {
      return await openDomainPage(page, target, config, log);
    } finally {
      await page.close().catch(() => {});
    }
  });

  await dump(config, `${target}.html`, html);
  const parsed = parseDomainPage(html, target);
  if (!parsed.found) {
    return {
      domain: target, rows: [], total: null, listing: 'none', pages: 1,
      status: 'no_redirects_section', sourceUrl: url, via, checkedAt,
    };
  }

  let rows = parsed.domains.map((d) => ({ redirecting_domain: d, source_url: url }));
  let listing = 'sample';
  let pages = 1;

  const wantsMore = config.followShowAll && parsed.showAllPath &&
    (parsed.total === null || parsed.total > rows.length);
  if (wantsMore) {
    await sleep(jitter(config.delay));
    const full = await scrapeFullList(context, target, config, log).catch((error) => {
      log.warn(`${target}: full list failed (${String(error.message).split('\n')[0]})`);
      return null;
    });
    if (full) {
      rows = full.rows;
      listing = 'full';
      pages += full.pages;
    }
  }

  if (config.limitPerDomain && rows.length > config.limitPerDomain) {
    rows.length = config.limitPerDomain;
  }

  let status = 'ok';
  if (rows.length === 0) status = 'empty';
  else if (parsed.total !== null && rows.length < parsed.total) status = 'partial';

  return {
    domain: target,
    rows: rows.map((row) => ({
      redirecting_domain: row.redirecting_domain,
      target_domain: target,
      reported_total: parsed.total ?? '',
      listing,
      source_url: row.source_url,
      checked_at: checkedAt,
    })),
    total: parsed.total,
    listing,
    pages,
    status,
    sourceUrl: url,
    via,
    checkedAt,
  };
}
