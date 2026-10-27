import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { csvCell, readDomainList, toCsv } from '../src/csv.js';

test('csvCell quotes separators, quotes and newlines', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
});

test('toCsv writes a header row and CRLF line endings', () => {
  assert.equal(toCsv(['a', 'b'], [[1, 2]]), 'a,b\r\n1,2\r\n');
});

test('readDomainList accepts txt lists and csv with a header', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'redirects-'));
  const txt = path.join(dir, 'domains.txt');
  await writeFile(txt, '# comment\nstripe.com\n\n  shopify.com  \n');
  assert.deepEqual(await readDomainList(txt), ['stripe.com', 'shopify.com']);

  const csv = path.join(dir, 'domains.csv');
  await writeFile(csv, 'domain,notes\nstripe.com,payments\n"shopify.com",ecommerce\n');
  assert.deepEqual(await readDomainList(csv), ['stripe.com', 'shopify.com']);
});
