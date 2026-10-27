# redirect-browser-automation

Browser automation that, for every company domain in a list, collects the
**domains redirecting to it** from [host.io](https://host.io) and writes one CSV
per domain.

For each input domain it drives headless Chromium to the host.io homepage,
types the domain into the search box, and reads the **Redirects** section of
the resulting domain page — host.io's own count plus the sample it lists — then
writes `output/<domain>.csv` and a run-level `output/_summary.csv`.

It then follows the "Show All" link to `/redirects/<domain>`, which host.io
serves with a **404 status but a real body** — up to 48 domains, with the page
itself saying "To view all the domains, please use our API". The body is
parsed regardless of the status; rows are marked `listing=full` when they come
from there and `listing=sample` when only the domain page was readable, and
`status=partial` whenever the count falls short of host.io's own total, so a
truncated result is never mistaken for a complete one.

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
| `--direct` | skip the search box, go straight to `/<domain>` |
| `--follow-show-all=false` | don't attempt the gated full listing |
| `--base-url <url>` | point at a stand-in server (used by the tests) |

## Output

`output/<domain>.csv` — one row per domain that redirects to the company domain:

```csv
redirecting_domain,target_domain,listing,source_url,checked_at
stripecdn.com,stripe.com,sample,https://host.io/stripe.com,2026-10-27T14:57:23.356Z
```

`output/_summary.csv` — one row per input domain:

```csv
target_domain,redirecting_domain_count,reported_total,listing,pages_scraped,status,error,source_url,csv_file,checked_at
stripe.com,24,1277,sample,1,partial,,https://host.io/stripe.com,stripe.com.csv,2026-10-27T14:57:23.356Z
```

`reported_total` is host.io's own count, so comparing it with
`redirecting_domain_count` shows how much of the list you actually got.
`status` is `ok` (count matches the total), `partial` (sample only), `empty`,
`no_redirects_section`, `rate_limited`, `challenge`, `paywalled` or `error`;
the exit code is `2` if any domain failed.

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
fixture (`--save-html`) instead of a live run. The fixtures in `test/fixtures/`
are trimmed copies of real host.io pages.

Browser setup follows [Camoufox](https://github.com/daijro/camoufox)'s
reasoning about detectable automation: the context is kept internally
consistent (the engine's own user agent, one locale and timezone, a real
viewport) rather than spoofing a user agent the rest of the fingerprint would
contradict, and the search box is typed into with per-key delays instead of
being filled in one shot. host.io serves this setup fine; if a target does
fingerprint-block it, Camoufox itself is the drop-in next step — it wraps the
same Playwright API, so only `openBrowser()` in `src/scraper.js` changes.

## Tests

```bash
npm test
```

The end-to-end test serves the fixtures from a local HTTP server and runs the
real CLI with `--base-url` against it, so no network access is needed.

## Notes and limits

- **Network access.** `host.io` must be reachable from wherever this runs. In a
  restricted environment the run fails with a proxy/connection error per domain.
- **48 domains is the hard ceiling.** The domain page renders 24, the "Show
  All" listing 48, and it carries no pagination links at all — verified on
  `stripe.com` (1,277 reported, 48 served). Past that, host.io's own answer is
  their API; no amount of browser automation gets further, and anything above
  48 comes back `partial` by design.
- **Be polite.** Keep `--concurrency` low with a non-zero `--delay`; the
  scraper also detects rate-limit and challenge pages and records them per
  domain rather than hammering on.
- **Markup drift.** `parse.js` identifies result rows by their link shape
  (`/<domain>` pages inside the results region, nav/footer excluded) rather than
  by brittle CSS classes, but a redesign can still change what counts as a row.
  Verify a sample against the site before trusting a large run.
