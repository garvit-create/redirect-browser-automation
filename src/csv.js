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

/** Minimal RFC 4180 parser: returns rows of fields. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Read an input list that also carries company names.
 * Expects a `domain` column and, when present, a `company_name` (or `company`
 * / `name`) column; a headerless file falls back to first/second column.
 *
 * @returns {Promise<Array<{domain: string, company: string}>>}
 */
export async function readCompanyList(file) {
  const rows = parseCsv(await readFile(file, 'utf8')).filter((r) => r.some((c) => c.trim()));
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const domainIdx = header.findIndex((c) => /^(domain|domains|website|url|company[_ ]?domain)$/.test(c));
  const companyIdx = header.findIndex((c) => /^(company[_ ]?name|company|name)$/.test(c));
  const body = domainIdx === -1 ? rows : rows.slice(1);
  const d = domainIdx === -1 ? 0 : domainIdx;
  const c = companyIdx === -1 ? 1 : companyIdx;
  return body
    .map((r) => ({ domain: (r[d] || '').trim(), company: (r[c] || '').trim() }))
    .filter((entry) => entry.domain && !entry.domain.startsWith('#'));
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
