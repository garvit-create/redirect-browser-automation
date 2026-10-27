/**
 * End-to-end check of the browser path: a local HTTP server stands in for
 * host.io (homepage search form, domain pages, and the gated full listing) so
 * the real Chromium run and the CSV output are exercised without the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8');

const HOME = `<!doctype html><html><head><title>host.io</title></head><body>
<form action="/search" method="get">
  <input type="text" name="domain" placeholder="e.g. ipinfo.io">
  <button type="submit">search</button>
</form></body></html>`;

async function startFakeHostIo() {
  const [withRedirects, without, fullList] = await Promise.all([
    fixture('domain-page.html'),
    fixture('domain-page-no-redirects.html'),
    fixture('full-list.html'),
  ]);
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    seen.push(url.pathname + url.search);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (url.pathname === '/') return send(200, HOME);
    if (url.pathname === '/search') {
      res.writeHead(302, { location: `/${url.searchParams.get('domain')}` });
      return res.end();
    }
    // host.io serves the full listing with a 404 *status* but a real body for
    // the domains it knows, and a genuine 404 for the ones it does not.
    if (url.pathname === '/redirects/stripe.com') return send(404, fullList);
    if (url.pathname.startsWith('/redirects/')) return send(404, '<html><body>Not found</body></html>');
    if (url.pathname === '/stripe.com') return send(200, withRedirects);
    return send(200, without);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, seen };
}

test('cli searches from the homepage and writes one CSV per domain', { timeout: 120000 }, async (t) => {
  const { server, baseUrl, seen } = await startFakeHostIo();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const dir = await mkdtemp(path.join(tmpdir(), 'redirects-e2e-'));
  const input = path.join(dir, 'domains.txt');
  const outDir = path.join(dir, 'out');
  await writeFile(input, 'https://www.stripe.com/\nb2bconsultancyservices.com\n');

  await run('node', [
    path.join(root, 'src/cli.js'),
    '--input', input, '--out', outDir, '--base-url', baseUrl,
    '--delay', '0', '--concurrency', '1', '--retries', '0', '--log-level', 'silent',
  ], { cwd: root });

  const csv = await readFile(path.join(outDir, 'stripe.com.csv'), 'utf8');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'redirecting_domain,target_domain,listing,source_url,checked_at');
  // The listing page wins over the domain page's shorter sample, 404 or not.
  assert.deepEqual(lines.slice(1).map((line) => line.split(',')[0]), [
    'stripecdn.com', 'kingsdemolition.com', 'bettersugarnow.com',
    'closeitnowbootcamplg.com', 'wspieramkosciol.pl', 'paytherapywithkrysta.com',
    'subtractionmethodmastery.com', 'bosscustomer.com',
  ]);
  assert.ok(lines.slice(1).every((line) => line.split(',')[2] === 'full'), csv);

  // The search box was used, and the gated listing was attempted and refused.
  assert.ok(seen.includes('/search?domain=stripe.com'), seen.join(' '));
  assert.ok(seen.includes('/redirects/stripe.com'), seen.join(' '));

  const empty = await readFile(path.join(outDir, 'b2bconsultancyservices.com.csv'), 'utf8');
  assert.equal(empty.trim().split('\r\n').length, 1);

  const summary = await readFile(path.join(outDir, '_summary.csv'), 'utf8');
  // 6 rows against a reported 1,277 is a sample, not the full list.
  assert.match(summary, /^stripe\.com,8,1277,full,\d+,partial,,/m);
  assert.match(summary, /^b2bconsultancyservices\.com,0,0,sample,\d+,empty,,/m);
});
