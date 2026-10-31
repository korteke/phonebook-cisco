// Paged phonebook for Cisco 7941-style IP phones, built from a public Google Sheet.
//
// One file, no dependencies, two ways to run it:
//   Static files:      node phonebook.mjs --base-url http://host/phonebook/ --out ./public
//   Cloudflare Worker: npx wrangler deploy
//
// Limits come from Cisco's CiscoIPPhone.xsd: a CiscoIPPhoneDirectory holds at most
// 32 entries, and each Name holds at most 32 characters.

const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1-RofQmzz0WvN0BTRmKQFE0E7LXcZdKJMlvmIk9wUoIU/export?format=csv';
const TITLE = 'HamPY puhelinluettelo';
const PROMPT = 'Valitse numero';
const MAX_PAGE_SIZE = 32;
const MAX_NAME_LENGTH = 32;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_FRESH_MS = 5 * 60 * 1000;
const CACHE_KEEP_SECONDS = 30 * 24 * 60 * 60;
const CACHE_PATH = '/__sheet-cache';
const FETCHED_AT_HEADER = 'X-Fetched-At';
const MENU_FILE = 'directory.xml';
const PAGE_FILE = /^directory-\d+\.xml$/;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function clean(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

export function parseEntries(csv) {
  const rows = parseCsv(csv);
  const header = rows.findIndex((row) => clean(row[0]) === 'Numero');
  if (header === -1) throw new Error('Sheet has no Numero header row');

  const entries = rows
    .slice(header + 1)
    .map(([number, owner, details]) => ({
      number: clean(number),
      owner: clean(owner),
      details: clean(details),
    }))
    .filter((entry) => /^[0-9*#]{1,32}$/.test(entry.number));

  if (entries.length === 0) throw new Error('Sheet has no entries');
  return entries;
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function displayName({ number, owner, details }) {
  const name = owner && details ? `${owner} (${details})` : owner || details || number;
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join('').trimEnd();
}

function softKey(name, url, position) {
  return `<SoftKeyItem><Name>${name}</Name><Position>${position}</Position><URL>${escapeXml(url)}</URL></SoftKeyItem>`;
}

function pageFile(page) {
  return `directory-${page}.xml`;
}

function normalizeBaseUrl(baseUrl) {
  if (!/^https?:\/\/[^/]/i.test(baseUrl)) {
    throw new Error(`Base URL must start with http:// or https://: ${baseUrl}`);
  }
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

// The phone adds these items to its Directories list, so the directory URL must return a menu.
export function renderMenu(baseUrl) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CiscoIPPhoneMenu>',
    `<Title>${escapeXml(TITLE)}</Title>`,
    `<MenuItem><Name>${escapeXml(TITLE)}</Name><URL>${escapeXml(`${normalizeBaseUrl(baseUrl)}${pageFile(1)}`)}</URL></MenuItem>`,
    '</CiscoIPPhoneMenu>',
    '',
  ].join('\n');
}

function renderPage(entries, page, total, baseUrl) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CiscoIPPhoneDirectory>',
    `<Title>${escapeXml(`${TITLE} ${page}/${total}`)}</Title>`,
    `<Prompt>${escapeXml(PROMPT)}</Prompt>`,
    softKey('Dial', 'SoftKey:Dial', 1),
  ];
  if (page < total) lines.push(softKey('Next', `${baseUrl}${pageFile(page + 1)}`, 2));
  if (page > 1) lines.push(softKey('Previous', `${baseUrl}${pageFile(page - 1)}`, 3));
  lines.push(
    softKey('Exit', 'SoftKey:Exit', 4),
    softKey('EditDial', 'SoftKey:EditDial', 5),
    ...entries.map(
      (entry) =>
        `<DirectoryEntry><Name>${escapeXml(displayName(entry))}</Name><Telephone>${escapeXml(entry.number)}</Telephone></DirectoryEntry>`,
    ),
    '</CiscoIPPhoneDirectory>',
    '',
  );
  return lines.join('\n');
}

export function buildPages(entries, { baseUrl, pageSize = MAX_PAGE_SIZE }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`Page size must be between 1 and ${MAX_PAGE_SIZE}: ${pageSize}`);
  }

  const base = normalizeBaseUrl(baseUrl);
  const total = Math.ceil(entries.length / pageSize);
  return Array.from({ length: total }, (_, index) => {
    const page = index + 1;
    const slice = entries.slice(index * pageSize, page * pageSize);
    return { file: pageFile(page), xml: renderPage(slice, page, total, base) };
  });
}

async function fetchSheet(sheetUrl, fetchImpl) {
  const response = await fetchImpl(sheetUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Sheet download failed: HTTP ${response.status}`);
  return response.text();
}

// Static files

export async function generateFiles({
  baseUrl,
  out,
  pageSize,
  sheetUrl = SHEET_URL,
  fetchImpl = fetch,
}) {
  const { mkdir, readdir, rename, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  // Everything that can fail on bad input happens before the first write.
  const pages = buildPages(parseEntries(await fetchSheet(sheetUrl, fetchImpl)), { baseUrl, pageSize });

  const files = [{ file: MENU_FILE, xml: renderMenu(baseUrl) }, ...pages];

  await mkdir(out, { recursive: true });
  for (const { file, xml } of files) {
    const temp = join(out, `.${file}.tmp`);
    await writeFile(temp, xml);
    await rename(temp, join(out, file));
  }

  const current = new Set(files.map(({ file }) => file));
  for (const file of await readdir(out)) {
    if (PAGE_FILE.test(file) && !current.has(file)) await rm(join(out, file));
  }
  return pages;
}

async function runCli() {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      out: { type: 'string', default: './public' },
      'page-size': { type: 'string' },
      sheet: { type: 'string' },
    },
  });
  if (!values['base-url']) {
    throw new Error(
      'Usage: node phonebook.mjs --base-url http://host/phonebook/ [--out ./public] [--page-size 32] [--sheet csv-url]',
    );
  }

  const pages = await generateFiles({
    baseUrl: values['base-url'],
    out: values.out,
    pageSize: values['page-size'] === undefined ? undefined : Number(values['page-size']),
    sheetUrl: values.sheet,
  });
  console.log(`Wrote ${pages.length} page(s) to ${values.out}`);
}

async function runIfMain() {
  const { realpath } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const entry = await realpath(process.argv[1]);
  if (entry !== (await realpath(fileURLToPath(import.meta.url)))) return;
  await runCli();
}

if (globalThis.process?.argv?.[1]) {
  runIfMain().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

// Cloudflare Worker

async function loadEntries(request, env) {
  const fetchImpl = env.fetchImpl ?? fetch;
  const cache = env.cache ?? caches.default;
  const now = env.now ?? Date.now;
  const cacheKey = new URL(CACHE_PATH, request.url).href;

  const cached = await cache.match(cacheKey);
  const fetchedAt = Number(cached?.headers.get(FETCHED_AT_HEADER));
  if (cached && now() - fetchedAt < CACHE_FRESH_MS) return parseEntries(await cached.text());

  try {
    const csv = await fetchSheet(env.SHEET_URL ?? SHEET_URL, fetchImpl);
    const entries = parseEntries(csv);
    await cache.put(
      cacheKey,
      new Response(csv, {
        headers: {
          'Cache-Control': `public, max-age=${CACHE_KEEP_SECONDS}`,
          [FETCHED_AT_HEADER]: String(now()),
        },
      }),
    );
    return entries;
  } catch (error) {
    if (cached) return parseEntries(await cached.text());
    throw error;
  }
}

function xmlResponse(xml, status = 200) {
  const body = new TextEncoder().encode(xml);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    },
  });
}

function errorScreen() {
  return xmlResponse(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<CiscoIPPhoneText>',
      `<Title>${escapeXml(TITLE)}</Title>`,
      '<Text>Puhelinluettelo ei ole juuri nyt saatavilla.</Text>',
      '</CiscoIPPhoneText>',
      '',
    ].join('\n'),
  );
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const file = url.pathname.slice(1);
    if (file === MENU_FILE) return xmlResponse(renderMenu(`${url.origin}/`));
    if (!PAGE_FILE.test(file)) return new Response('Not found', { status: 404 });

    try {
      const pages = buildPages(await loadEntries(request, env), {
        baseUrl: `${url.origin}/`,
        pageSize: env.PAGE_SIZE === undefined ? undefined : Number(env.PAGE_SIZE),
      });
      const page = pages.find((candidate) => candidate.file === file);
      return page ? xmlResponse(page.xml) : new Response('Not found', { status: 404 });
    } catch (error) {
      console.error(error);
      return errorScreen();
    }
  },
};
