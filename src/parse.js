/**
 * Pure HTML parsing for host.io redirect pages.
 *
 * Kept free of Playwright/DOM APIs so it can be unit-tested against saved
 * fixtures: the scraper hands it `page.content()` and gets plain data back.
 */

// host.io paths that are site chrome, not result rows.
const RESERVED_PATHS = new Set([
  'about', 'api', 'blog', 'contact', 'dashboard', 'docs', 'faq', 'login',
  'logout', 'pricing', 'privacy', 'products', 'search', 'signup', 'terms',
  'tools',
]);

// Sections of host.io that are prefixed paths rather than domain pages.
const RESERVED_PREFIXES = [
  'redirects', 'backlinks', 'ns', 'mx', 'ip', 'asn', 'domains', 'web',
  'rank', 'email', 'adsense', 'analytics', 'facebook', 'twitter', 'linkedin',
  'instagram', 'youtube', 'googleplay', 'itunes', 'assets', 'static',
];

const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** Strip tags/entities from an HTML fragment and collapse whitespace. */
export function textOf(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn an href into a host.io path ("/example.com") or null if external. */
function toLocalPath(href) {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('//')) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    const m = /^https?:\/\/(?:www\.)?host\.io(\/[^#?]*)?/i.exec(trimmed);
    return m ? (m[1] || '/') : null;
  }
  if (!trimmed.startsWith('/')) return null;
  return trimmed.split(/[?#]/)[0];
}

/** True when a host.io path is a domain detail page, e.g. "/stripe.com". */
export function domainFromPath(path) {
  if (!path || path === '/') return null;
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const candidate = segments[0].toLowerCase();
  if (RESERVED_PATHS.has(candidate)) return null;
  if (RESERVED_PREFIXES.includes(candidate)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(candidate)) {
    return null;
  }
  if (!/\.[a-z]{2,}$/.test(candidate)) return null;
  return candidate;
}

/** Normalize a domain the way host.io does: lowercase, no scheme, no www. */
export function normalizeDomain(input) {
  if (!input) return '';
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/:\d+$/, '');
  return d.replace(/\.$/, '');
}

/**
 * Narrow the HTML to the results region so footer/nav links are ignored.
 * Falls back to the whole document when the markers are not found.
 */
function resultsRegion(html) {
  const start = html.search(/<main\b|id=["']results["']|class=["'][^"']*\bcard\b/i);
  const bodyStart = start >= 0 ? start : 0;
  const footer = html.toLowerCase().indexOf('<footer');
  const bodyEnd = footer > bodyStart ? footer : html.length;
  return html.slice(bodyStart, bodyEnd);
}

/** Total number of redirecting domains host.io reports, or null. */
export function parseTotal(html) {
  const text = textOf(html);
  const patterns = [
    /([\d,]+)\s+domains?\s+redirect/i,
    /redirects?\s*\(\s*([\d,]+)\s*\)/i,
    /showing\s+[\d,]+\s*(?:-|to)\s*[\d,]+\s+of\s+([\d,]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  return null;
}

/** Detect the "no results" state so an empty CSV is not read as a failure. */
export function looksEmpty(html) {
  return /no\s+(?:redirects|domains|results)\b|we\s+(?:could not|couldn'?t)\s+find/i.test(textOf(html));
}

/** Detect a block page (rate limit, captcha, login wall). */
export function detectBlock(html) {
  const text = textOf(html).toLowerCase();
  if (/rate\s*limit|too many requests/.test(text)) return 'rate_limited';
  if (/just a moment|checking your browser|cf-challenge|captcha/.test(text)) return 'challenge';
  if (/sign\s*in to (?:view|see)|upgrade your plan|requires? an? (?:paid )?account/.test(text)) return 'paywalled';
  return null;
}

/**
 * Extract the redirecting domains from one results page.
 *
 * @param {string} html raw page HTML
 * @param {string} target the company domain the results point at
 * @param {number} currentPage 1-based page number this HTML came from
 * @returns {{domains: Array<{domain: string, label: string, description: string}>,
 *            total: number|null, nextPage: number|null}}
 */
export function parseRedirectsPage(html, target, currentPage = 1) {
  const region = resultsRegion(html);
  const normalizedTarget = normalizeDomain(target);
  const seen = new Set();
  const matches = [];

  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(region)) !== null) {
    const path = toLocalPath(m[1]);
    const domain = domainFromPath(path);
    if (!domain || domain === normalizedTarget || seen.has(domain)) continue;
    seen.add(domain);
    matches.push({ domain, label: textOf(m[2]) || domain, start: m.index, end: ANCHOR_RE.lastIndex });
  }

  // Best-effort description: the text between this row's link and whatever
  // link comes next, so neighbouring rows and pagination do not bleed in.
  const domains = matches.map((entry, i) => {
    const nextLink = region.indexOf('<a', entry.end);
    const nextMatch = i + 1 < matches.length ? matches[i + 1].start : region.length;
    const bound = nextLink === -1 ? nextMatch : Math.min(nextMatch, nextLink);
    const between = region.slice(entry.end, Math.min(bound, entry.end + 2000));
    const description = textOf(between).replace(/^[\s·|-]+/, '').slice(0, 300);
    return { domain: entry.domain, label: entry.label, description };
  });

  return { domains, total: parseTotal(html), nextPage: parseNextPage(html, currentPage) };
}

/**
 * Find the next pagination page number, or null when this is the last page.
 * Returns the lowest linked page above `currentPage`, preferring an explicit
 * "next" link when the markup provides one.
 */
export function parseNextPage(html, currentPage = 1) {
  const region = resultsRegion(html);
  const pages = new Set();
  ANCHOR_RE.lastIndex = 0;
  let m;
  let explicitNext = null;
  while ((m = ANCHOR_RE.exec(region)) !== null) {
    const href = m[1];
    const pageMatch = /[?&]page=(\d+)/.exec(href);
    if (!pageMatch) continue;
    const num = Number(pageMatch[1]);
    pages.add(num);
    if (/next|›|»/i.test(textOf(m[2])) || /rel=["']next["']/i.test(m[0])) {
      explicitNext = explicitNext === null ? num : Math.min(explicitNext, num);
    }
  }
  if (explicitNext !== null && explicitNext > currentPage) return explicitNext;
  const ahead = [...pages].filter((n) => n > currentPage);
  return ahead.length ? Math.min(...ahead) : null;
}
