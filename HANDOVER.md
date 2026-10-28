# Handover

Everything needed to run this yourself, plus what was learned building it.
`README.md` documents the tool; this file is the state of play.

## What it does

For each company domain, drives headless Chromium to host.io, searches the
domain, and reads the **Redirects** section of its page — the domains that
redirect to it. Writes one CSV per domain plus a run summary, and rolls those
up into one row per company.

## Run it locally

```bash
git clone <this repo> && cd redirect-browser-automation
git checkout claude/elegant-bohr-ganvcq
npm install
npx playwright install chromium

# scrape
node src/cli.js -i input/tier2_gtm_companies.csv -o tier2-output \
  --concurrency 2 --delay 5000 --resume

# roll up into one row per company
node src/export.js --input input/tier2_gtm_companies.csv \
  --results tier2-output --out tier2-output/companies_redirects.csv

npm test   # 17 tests, no network needed
```

`--resume` skips domains that already have a CSV, so a killed run picks up
where it stopped. Nothing else needs cleaning up between runs.

### With a rotating proxy

```bash
export HOSTIO_PROXY="http://USER-rotate:PASS@p.webshare.io:80"
node src/cli.js -i input/tier2_gtm_companies.csv -o tier2-output \
  --concurrency 8 --delay 500 --resume
```

Credentials live in the flag or the environment, never in this repo. With a
per-request rotating proxy the per-IP ceiling below stops binding, so
concurrency can go up and the delay down — raise both gradually and watch for
`rate_limited` in the summary.

This could not be tested from the cloud sandbox this was built in: that
container has no direct sockets, and Chromium cannot chain through its egress
proxy to reach another one. On a normal machine it is a plain Playwright
proxy option and should just work — verify with a handful of domains before
committing to a long run.

## What host.io actually allows (measured, not documented)

- The full list is at `/redirects/<domain>` behind the "Show All" link. It
  returns **HTTP 404 as its status while serving a real body** — parse the
  body, never trust the status.
- **48 domains per company is a hard ceiling.** The domain page renders 24,
  the Show All listing 48, and it carries no pagination. `stripe.com` reports
  1,277 redirects and serves 48 of them. Past that host.io's own answer is
  their paid API. No amount of automation moves this; a proxy gets you more
  *companies*, never a longer list for one company.
- **Rate limiting is by IP**, in two layers:
  - a burst limit: ~1,240 page loads (12 minutes at 3 workers / 1.2s delay)
    before the first HTTP 429;
  - a daily cap: after ~5,000 loads in one day, even 30s spacing was refused
    until the next morning. The 429 page says "too many requests **today**".
  - Roughly **2,000 domains per day from one IP** (~2.2 page loads each).
  - The counter follows the IP, not the session: a fresh browser process was
    refused immediately, so more tabs only spend the budget faster.
- Backing off to 1 worker recovered 167 of 171 blocked domains within the
  same day; the last few needed the next day.

## Results in this repo

`tier2-output/companies_redirects.csv` — 1,963 companies:

| | |
| --- | --- |
| with at least one redirecting domain | 1,569 |
| genuinely zero | 393 |
| capped at 48 (reported total is higher) | 254 |
| total redirects reported by host.io | 68,304 |

Columns: `company_name, domain, redirect_count, redirect_domains`.
`redirect_count` is **host.io's own total**, so it can exceed the number of
domains in the cell (the 48 cap). `redirect_domains` is pipe-separated.

`tier2-output/_summary.csv` has the per-domain detail: counts, `listing`
(`full` = from the Show All page, `sample` = domain page only), `status`
(`ok` / `partial` / `empty` / `rate_limited` / `challenge` / `error`) and the
source URL. The 1,963 individual per-domain CSVs are **not** committed — they
are reproducible and add ~9 MB; drop `tier2-output/` from `.gitignore` if you
want them tracked.

`output/` holds an earlier eight-domain run.

## Known gaps

- `pos.toasttab.com` has its 24-domain sample but not the 48-row listing: its
  Show All page was still rate-limited when the run ended. Re-running that one
  domain on a fresh quota fills it in.
- 254 companies are capped at 48 as above.
- The full listing for signed-in users is untested. `--storage-state <file>`
  takes a Playwright session, and `parseRedirectsPage` handles pagination if a
  logged-in listing turns out to have any — nobody has seen one.

## Two bugs worth not reintroducing

Both were found by running against the live site, not by the tests, and both
have regression tests now.

1. **Block detection matched page text anywhere.** A company whose host.io
   description read "Rate limiting, observability, and compliance built in"
   was classified as a 429 and retried five times. Pages carrying host.io's
   own content markers are now never treated as blocks.
2. **A run rewrote the summary from scratch.** Re-scraping a single domain
   discarded the rows for the other 1,962 — the counts had to be recovered
   from a git commit. Rows for domains a run does not touch are now carried
   over.

## Design notes

- `src/parse.js` is pure: HTML in, data out, no Playwright. Markup drift can
  be reproduced from a saved page (`--save-html`) instead of a live run, and
  the fixtures in `test/fixtures/` are trimmed copies of real host.io pages.
- The browser context is kept internally consistent (engine's own user agent,
  one locale and timezone, a real viewport) rather than spoofing a user agent
  the rest of the fingerprint contradicts — Camoufox's reasoning. host.io
  never challenged plain Chromium; its blocks are quota, not fingerprinting.
  If a target does fingerprint-block, Camoufox wraps the same Playwright API
  and only `openBrowser()` would change.
- Scraping 100k domains through a browser is ~220k page loads. If that is the
  plan, consider fetching the HTML over plain HTTP instead and feeding it to
  the same parser: host.io is server-rendered, so the HTML is identical and it
  is roughly an order of magnitude cheaper per domain. Not built.
