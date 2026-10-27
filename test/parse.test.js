import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectBlock, domainFromPath, looksEmpty, normalizeDomain,
  parseNextPage, parseRedirectsPage, parseTotal,
} from '../src/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8');

test('normalizeDomain strips scheme, www, path and port', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.Stripe.com/pricing?a=1'), 'stripe.com');
  assert.equal(normalizeDomain('stripe.com:8443'), 'stripe.com');
  assert.equal(normalizeDomain(''), '');
});

test('domainFromPath accepts domain pages and rejects site chrome', () => {
  assert.equal(domainFromPath('/stripe.co'), 'stripe.co');
  assert.equal(domainFromPath('/pricing'), null);
  assert.equal(domainFromPath('/redirects/stripe.com'), null);
  assert.equal(domainFromPath('/'), null);
  assert.equal(domainFromPath('/notadomain'), null);
});

test('parseRedirectsPage extracts rows, skips nav, footer and the target', async () => {
  const html = await fixture('redirects-page1.html');
  const { domains, total, nextPage } = parseRedirectsPage(html, 'stripe.com', 1);
  assert.deepEqual(domains.map((d) => d.domain), ['stripe.co', 'stripe.dev', 'getstripe.com']);
  assert.equal(domains[2].label, 'Get Stripe');
  assert.match(domains[0].description, /Financial Infrastructure/);
  assert.equal(total, 124);
  assert.equal(nextPage, 2);
});

test('parseNextPage returns null on the last page', async () => {
  const html = await fixture('redirects-page2.html');
  // The last page links only backwards, so there is nothing left to follow.
  assert.equal(parseNextPage(html, 2), null);
  assert.equal(parseNextPage(html, 1), null);
});

test('parseTotal and looksEmpty handle the no-results page', async () => {
  const html = await fixture('redirects-empty.html');
  assert.equal(parseTotal(html), null);
  assert.equal(looksEmpty(html), true);
  assert.deepEqual(parseRedirectsPage(html, 'nowhere-at-all.example', 1).domains, []);
});

test('detectBlock recognises a rate-limit page', async () => {
  assert.equal(detectBlock(await fixture('rate-limited.html')), 'rate_limited');
  assert.equal(detectBlock(await fixture('redirects-page1.html')), null);
});
