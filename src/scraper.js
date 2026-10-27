import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectBlock,
  looksEmpty,
  normalizeDomain,
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

export const redirectsUrl = (domain, page = 1, baseUrl = 'https://host.io') => {
  const base = `${baseUrl.replace(/\/+$/, '')}/redirects/${encodeURIComponent(normalizeDomain(domain))}`;
  return page > 1 ? `${base}?page=${page}` : base;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

/** Launch a browser and build a context shared by all workers. */
export async function openBrowser(config) {
  const browser = await loadChromium().launch({ headless: !config.headful });
  const context = await browser.newContext({
    userAgent: config.userAgent || undefined, // Chromium's own UA unless overridden
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
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

class BlockedError extends Error {
  constructor(kind, url) {
    super(`host.io returned a ${kind} page for ${url}`);
    this.name = 'BlockedError';
    this.kind = kind;
  }
}

/** Fetch one results page, with retries on navigation errors and rate limits. */
async function loadPage(context, url, config, log) {
  let lastError;
  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = response ? response.status() : 0;
      if (status === 429 || status === 503) throw new BlockedError('rate_limited', url);
      if (status >= 400) throw new Error(`HTTP ${status} for ${url}`);
      await page.waitForLoadState('networkidle', { timeout: config.timeout }).catch(() => {});
      const html = await page.content();
      const blocked = detectBlock(html);
      if (blocked) throw new BlockedError(blocked, url);
      return { html, status };
    } catch (error) {
      lastError = error;
      const backoff = jitter(config.backoff * 2 ** (attempt - 1));
      if (attempt <= config.retries) {
        log.warn(`${url} failed (${error.message}); retry ${attempt}/${config.retries} in ${backoff}ms`);
        await sleep(backoff);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
  throw lastError;
}

/**
 * Scrape every page of host.io/redirects/<domain>.
 *
 * @returns {Promise<{domain: string, rows: object[], total: number|null,
 *                    pages: number, status: string, error: string|null}>}
 */
export async function scrapeDomain(context, domain, config, log) {
  const target = normalizeDomain(domain);
  const checkedAt = new Date().toISOString();
  const rows = [];
  const seen = new Set();
  let total = null;
  let pages = 0;
  let pageNum = 1;

  while (pageNum && pages < config.maxPages) {
    const url = redirectsUrl(target, pageNum, config.baseUrl);
    const { html } = await loadPage(context, url, config, log);
    pages += 1;

    if (config.saveHtml) {
      const file = path.join(config.debugDir, `${target}-p${pageNum}.html`);
      await mkdir(config.debugDir, { recursive: true });
      await writeFile(file, html, 'utf8');
    }

    const parsed = parseRedirectsPage(html, target, pageNum);
    if (parsed.total !== null) total = parsed.total;

    let added = 0;
    for (const entry of parsed.domains) {
      if (seen.has(entry.domain)) continue;
      seen.add(entry.domain);
      added += 1;
      rows.push({
        redirecting_domain: entry.domain,
        target_domain: target,
        title: entry.label === entry.domain ? '' : entry.label,
        description: entry.description,
        source_url: url,
        page: pageNum,
        checked_at: checkedAt,
      });
    }

    log.debug(`${target} page ${pageNum}: +${added} (total so far ${rows.length})`);

    if (added === 0 && pageNum > 1) break; // pagination looped back on itself
    if (pageNum === 1 && rows.length === 0 && looksEmpty(html)) break;
    if (config.limitPerDomain && rows.length >= config.limitPerDomain) {
      rows.length = config.limitPerDomain;
      break;
    }

    pageNum = parsed.nextPage;
    if (pageNum) await sleep(jitter(config.delay));
  }

  return {
    domain: target,
    rows,
    total,
    pages,
    status: rows.length ? 'ok' : 'empty',
    error: null,
    checkedAt,
  };
}
