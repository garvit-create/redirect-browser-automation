# redirect-browser-automation

Browser automation that, for every company domain in a list, collects the
**domains redirecting to it** from [host.io](https://host.io) and writes one CSV
per domain.

For each input domain it drives headless Chromium through
`https://host.io/redirects/<domain>`, follows the pagination, and writes
`output/<domain>.csv` plus a run-level `output/_summary.csv`.

## Install

Node 20+ and Playwright's Chromium:

```bash
npm install
npx playwright install chromium   # skip if Chromium is already installed in the image
```

If Playwright is installed globally (some container images ship it), the tool
picks that copy up and `npm install` is not needed.

## Use

```bash
# domains go in input/domains.txt, one per line
node src/cli.js

# explicit input/output, two domains at a time
node src/cli.js input/domains.csv --out results --concurrency 2

# a quick smoke run: first 3 domains, 1 page each, page HTML kept for inspection
node src/cli.js -n 3 --max-pages 1 --save-html
```

`node src/cli.js --help` lists every flag. The ones that matter most:

| Flag | Purpose |
| --- | --- |
| `-i, --input <file>` | domain list, `.txt` or `.csv` (default `input/domains.txt`) |
| `-o, --out <dir>` | output directory (default `output`) |
| `-c, --concurrency <n>` | domains in parallel (default 2 — host.io rate-limits) |
| `--delay <ms>` | pause between page loads (default 1500) |
| `--max-pages <n>` | pagination cap per domain (default 25) |
| `--limit-per-domain <n>` | stop after n redirecting domains |
| `--resume` | skip domains that already have a CSV, append to the summary |
| `--retries` / `--backoff` | retry count and base backoff, doubled per attempt |
| `--storage-state <file>` | Playwright `storageState` JSON for a logged-in host.io session |
| `--save-html` | dump each fetched page under `--debug-dir` |
| `--base-url <url>` | point at a stand-in server (used by the tests) |

## Output

`output/<domain>.csv` — one row per domain that redirects to the company domain:

```csv
redirecting_domain,target_domain,title,description,source_url,page,checked_at
stripe.co,stripe.com,,Stripe | Financial Infrastructure for the Internet,https://host.io/redirects/stripe.com,1,2026-10-27T14:43:01.487Z
```

`output/_summary.csv` — one row per input domain:

```csv
target_domain,redirecting_domain_count,reported_total,pages_scraped,status,error,csv_file,checked_at
stripe.com,5,124,2,ok,,stripe.com.csv,2026-10-27T14:43:01.487Z
```

`reported_total` is the count host.io prints on the page, so it shows when
pagination or a plan limit cut the list short. `status` is `ok`, `empty`,
`rate_limited`, `challenge`, `paywalled` or `error`; the exit code is `2` if any
domain failed.

## Layout

```
src/cli.js       argument handling, work pool, CSV writing
src/scraper.js   browser lifecycle, page loading, retries, pagination
src/parse.js     pure HTML -> rows/total/next-page extraction (unit tested)
src/csv.js       RFC 4180 writing, input list reading
src/config.js    defaults, flag parsing, usage text
test/            unit tests over saved host.io fixtures + an end-to-end CLI run
```

Parsing is deliberately kept out of the browser: the scraper hands raw HTML to
`parse.js`, so selector changes on host.io can be reproduced from a saved
fixture (`--save-html`) instead of a live run.

## Tests

```bash
npm test
```

The end-to-end test serves the fixtures from a local HTTP server and runs the
real CLI with `--base-url` against it, so no network access is needed.

## Notes and limits

- **Network access.** `host.io` must be reachable from wherever this runs. In a
  restricted environment the run fails with a proxy/connection error per domain.
- **host.io limits.** Anonymous visitors see a truncated redirect list and get
  rate-limited; a signed-in session (`--storage-state`) and a low
  `--concurrency` with a non-zero `--delay` go further. If you have a host.io
  API token, their API is cheaper than scraping — this tool exists for the
  browser path.
- **Markup drift.** `parse.js` identifies result rows by their link shape
  (`/<domain>` pages inside the results region, nav/footer excluded) rather than
  by brittle CSS classes, but a redesign can still change what counts as a row.
  Verify a sample against the site before trusting a large run.
