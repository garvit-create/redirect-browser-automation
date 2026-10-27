import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

/** Quote a single CSV field per RFC 4180. */
export function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render rows (arrays) with a header into a CSV string. */
export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function writeCsv(file, header, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, toCsv(header, rows), 'utf8');
  return file;
}

/** Append rows to a CSV, writing the header first if the file is new. */
export async function appendCsv(file, header, rows) {
  const { appendFile, access } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true });
  let exists = true;
  try {
    await access(file);
  } catch {
    exists = false;
  }
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const out = (exists ? '' : header.map(csvCell).join(',') + '\r\n') + (body ? body + '\r\n' : '');
  if (out) await appendFile(file, out, 'utf8');
}

/**
 * Read the input list. Accepts a plain .txt list (one domain per line) or a
 * CSV, in which case the first column is used unless it is an obvious header.
 * Blank lines and lines starting with # are ignored.
 */
export async function readDomainList(file) {
  const raw = await readFile(file, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const first = trimmed.startsWith('"')
      ? (/^"((?:[^"]|"")*)"/.exec(trimmed)?.[1] ?? trimmed).replace(/""/g, '"')
      : trimmed.split(',')[0].trim();
    if (!first) continue;
    if (/^(domain|domains|website|url|company[_ ]?domain)$/i.test(first)) continue;
    out.push(first);
  }
  return out;
}

/** Stream the domain column out of an existing per-domain CSV (for --resume). */
export async function countCsvRows(file) {
  return new Promise((resolve, reject) => {
    let count = -1; // header
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.trim()) count += 1;
    });
    rl.on('close', () => resolve(Math.max(count, 0)));
    rl.on('error', reject);
  });
}
