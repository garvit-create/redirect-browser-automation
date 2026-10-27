/**
 * End-to-end check of the browser path: a local HTTP server stands in for
 * host.io so the real Chromium run, pagination, and CSV output are exercised
 * without touching the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8');

async function startFakeHostIo() {
  const [page1, page2, empty] = await Promise.all([
    fixture('redirects-page1.html'),
    fixture('redirects-page2.html'),
    fixture('redirects-empty.html'),
  ]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const page = url.searchParams.get('page') ?? '1';
    let body = empty;
    if (url.pathname === '/redirects/stripe.com') body = page === '2' ? page2 : page1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test('cli scrapes both pages and writes one CSV per domain', { timeout: 120000 }, async (t) => {
  const { server, baseUrl } = await startFakeHostIo();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const dir = await mkdtemp(path.join(tmpdir(), 'redirects-e2e-'));
  const input = path.join(dir, 'domains.txt');
  const outDir = path.join(dir, 'out');
  await (await import('node:fs/promises')).writeFile(input, 'https://www.stripe.com/\nnowhere-at-all.example\n');

  await run('node', [
    path.join(root, 'src/cli.js'),
    '--input', input,
    '--out', outDir,
    '--base-url', baseUrl,
    '--delay', '0',
    '--concurrency', '1',
    '--log-level', 'silent',
  ], { cwd: root });

  const csv = await readFile(path.join(outDir, 'stripe.com.csv'), 'utf8');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'redirecting_domain,target_domain,title,description,source_url,page,checked_at');
  const found = lines.slice(1).map((line) => line.split(',')[0]);
  assert.deepEqual(found, ['stripe.co', 'stripe.dev', 'getstripe.com', 'stripe.net', 'stripepayments.io']);
  assert.match(csv, /"Payments, ""quoted"" & comma, included"/);

  const empty = await readFile(path.join(outDir, 'nowhere-at-all.example.csv'), 'utf8');
  assert.equal(empty.trim().split('\r\n').length, 1);

  const summary = await readFile(path.join(outDir, '_summary.csv'), 'utf8');
  assert.match(summary, /^stripe\.com,5,124,2,ok,/m);
  assert.match(summary, /^nowhere-at-all\.example,0,,1,empty,/m);
});
