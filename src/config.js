import path from 'node:path';

export const DEFAULTS = {
  input: 'input/domains.txt',
  outDir: 'output',
  debugDir: 'debug',
  summary: '_summary.csv',
  concurrency: 2,
  delay: 1500,
  timeout: 30000,
  retries: 2,
  backoff: 2000,
  maxPages: 25,
  limitPerDomain: 0,
  limit: 0,
  headful: false,
  saveHtml: false,
  resume: false,
  userAgent: '',
  storageState: '',
  baseUrl: 'https://host.io',
  direct: false,
  // A rotating proxy lifts host.io's per-IP ceiling; credentials come from the
  // flag or HOSTIO_PROXY, so they are never stored in the repo.
  proxy: process.env.HOSTIO_PROXY || '',
  followShowAll: true,
  logLevel: 'info',
};

const NUMERIC = new Set([
  'concurrency', 'delay', 'timeout', 'retries', 'backoff', 'maxPages',
  'limitPerDomain', 'limit',
]);
const BOOLEAN = new Set([
  'headful', 'saveHtml', 'resume', 'force', 'help', 'direct', 'followShowAll',
]);

const ALIASES = {
  i: 'input', o: 'outDir', c: 'concurrency', n: 'limit', h: 'help',
  out: 'outDir', 'out-dir': 'outDir', 'max-pages': 'maxPages',
  'limit-per-domain': 'limitPerDomain', 'save-html': 'saveHtml',
  'debug-dir': 'debugDir', 'user-agent': 'userAgent',
  'storage-state': 'storageState', 'log-level': 'logLevel',
  'follow-show-all': 'followShowAll', 'no-follow-show-all': 'followShowAll',
};

const camel = (flag) => ALIASES[flag] ?? flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      parsed.input = arg; // bare positional is the input list
      continue;
    }
    const [flagPart, inlineValue] = arg.replace(/^--?/, '').split('=');
    const key = camel(flagPart);
    if (BOOLEAN.has(key)) {
      parsed[key] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${flagPart}`);
    parsed[key] = NUMERIC.has(key) ? Number(value) : value;
  }
  return parsed;
}

export function buildConfig(argv, cwd = process.cwd()) {
  const parsed = parseArgs(argv);
  const config = { ...DEFAULTS, ...parsed };
  for (const key of NUMERIC) {
    if (Number.isNaN(config[key])) throw new Error(`--${key} must be a number`);
  }
  if (config.concurrency < 1) throw new Error('--concurrency must be at least 1');
  config.input = path.resolve(cwd, config.input);
  config.outDir = path.resolve(cwd, config.outDir);
  config.debugDir = path.resolve(cwd, config.debugDir);
  config.summaryPath = path.resolve(config.outDir, config.summary);
  return config;
}

export const USAGE = `
redirect-scrape — collect the domains redirecting to each company domain (via host.io)

Usage:
  node src/cli.js [input-file] [options]

How it works:
  For each domain the browser opens host.io, types the domain into the search
  box, and reads the "Redirects" section of the resulting domain page. That
  section carries host.io's own count plus a sample of the list; the full
  listing (/redirects/<domain>) needs a signed-in session, so pass
  --storage-state to get beyond the sample.

Options:
  -i, --input <file>        domain list, .txt or .csv (default: input/domains.txt)
  -o, --out <dir>           output directory (default: output)
  -c, --concurrency <n>     domains scraped in parallel (default: 2)
  -n, --limit <n>           only process the first n domains
      --limit-per-domain <n>  stop after n redirecting domains per company domain
      --max-pages <n>       pagination cap per domain (default: 25)
      --delay <ms>          pause between page loads (default: 1500)
      --timeout <ms>        navigation timeout (default: 30000)
      --retries <n>         retries per page (default: 2)
      --backoff <ms>        base retry backoff, doubled per attempt (default: 2000)
      --resume              skip domains that already have a CSV
      --force               overwrite existing CSVs (default behaviour without --resume)
      --headful             run the browser with a visible window
      --save-html           dump each fetched page to --debug-dir
      --debug-dir <dir>     where --save-html writes (default: debug)
      --user-agent <ua>     override the browser user agent
      --storage-state <f>   Playwright storageState JSON (for a logged-in host.io session)
      --base-url <url>      host.io base URL (default: https://host.io)
      --log-level <level>   silent | error | warn | info | debug (default: info)
  -h, --help                show this help

Output:
  <out>/<domain>.csv        one row per domain redirecting to <domain>
  <out>/_summary.csv        one row per input domain: counts, status, errors
`.trim();
