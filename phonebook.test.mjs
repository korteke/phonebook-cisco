import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import worker, {
  buildPages,
  buildPolycomPages,
  generateFiles,
  parseEntries,
  renderMenu,
  renderPolycomDirectory,
} from './phonebook.mjs';

const BASE = 'http://example.test/phonebook/';

function sheet(count) {
  const rows = ['Title row,,', ',,', 'Numero,Haltija,Lisätietoja'];
  for (let i = 1; i <= count; i++) rows.push(`${10000 + i},OH2T${i},Koti`);
  return rows.join('\n');
}

function entriesIn(xml) {
  return [...xml.matchAll(/<DirectoryEntry>/g)].length;
}

function softKeys(xml) {
  return [...xml.matchAll(/<SoftKeyItem><Name>(.*?)<\/Name><Position>(\d+)<\/Position><URL>(.*?)<\/URL><\/SoftKeyItem>/g)]
    .map(([, name, position, url]) => ({ name, url, position: Number(position) }));
}

function softKey(xml, name) {
  return softKeys(xml).find((key) => key.name === name);
}

// parseEntries

test('parseEntries reads rows below the Numero header and skips rows without a number', () => {
  const csv = 'Otsikkorivi,,\n,,\nNumero,Haltija,Lisätietoja\n11111,TESTI1,Hamshack\n,,\n12222,TESTI2,\n';
  assert.deepEqual(parseEntries(csv), [
    { number: '11111', owner: 'TESTI1', details: 'Hamshack' },
    { number: '12222', owner: 'TESTI2', details: '' },
  ]);
});

test('parseEntries keeps leading zeros in numbers', () => {
  assert.equal(parseEntries('Numero,Haltija,Lisätietoja\n059,HamPY,Ryhmä')[0].number, '059');
});

test('parseEntries handles quoted commas, doubled quotes and CRLF line endings', () => {
  const csv = 'Numero,Haltija,Lisätietoja\r\n13333,TESTI3,"Testinén, ""PE"", Järvikylä"\r\n';
  assert.equal(parseEntries(csv)[0].details, 'Testinén, "PE", Järvikylä');
});

test('parseEntries collapses stray whitespace in names', () => {
  assert.equal(parseEntries('Numero,Haltija,Lisätietoja\n1, TESTI5  x ,y')[0].owner, 'TESTI5 x');
});

test('parseEntries rejects a response without the Numero header', () => {
  assert.throws(() => parseEntries('<!DOCTYPE html><html>Sign in</html>'), /Numero/);
});

test('parseEntries rejects a sheet with no entries', () => {
  assert.throws(() => parseEntries('Numero,Haltija,Lisätietoja\n,,\n'), /no entries/);
});

// buildPages

test('buildPages splits 170 entries into six pages of at most 32', () => {
  const pages = buildPages(parseEntries(sheet(170)), { baseUrl: BASE });
  assert.deepEqual(pages.map((page) => entriesIn(page.xml)), [32, 32, 32, 32, 32, 10]);
});

test('buildPages numbers every page, leaving directory.xml for the menu', () => {
  const pages = buildPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.deepEqual(pages.map((page) => page.file), ['directory-1.xml', 'directory-2.xml']);
});

test('buildPages honours a smaller page size', () => {
  const pages = buildPages(parseEntries(sheet(40)), { baseUrl: BASE, pageSize: 20 });
  assert.deepEqual(pages.map((page) => entriesIn(page.xml)), [20, 20]);
});

test('buildPages rejects a page size over the 32 entry limit', () => {
  assert.throws(() => buildPages(parseEntries(sheet(40)), { baseUrl: BASE, pageSize: 33 }), /page size/i);
});

test('the title shows the page position', () => {
  const pages = buildPages(parseEntries(sheet(170)), { baseUrl: BASE });
  assert.match(pages[1].xml, /<Title>HamPY puhelinluettelo 2\/6<\/Title>/);
});

test('the first page has Next but no Previous', () => {
  const [first] = buildPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.equal(softKey(first.xml, 'Next').url, `${BASE}directory-2.xml`);
  assert.equal(softKey(first.xml, 'Previous'), undefined);
});

test('the last page has Previous but no Next', () => {
  const [, last] = buildPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.equal(softKey(last.xml, 'Previous').url, `${BASE}directory-1.xml`);
  assert.equal(softKey(last.xml, 'Next'), undefined);
});

test('a middle page links to both neighbours', () => {
  const [, middle] = buildPages(parseEntries(sheet(70)), { baseUrl: BASE });
  assert.equal(softKey(middle.xml, 'Previous').url, `${BASE}directory-1.xml`);
  assert.equal(softKey(middle.xml, 'Next').url, `${BASE}directory-3.xml`);
});

test('a single page has neither Next nor Previous', () => {
  const [only] = buildPages(parseEntries(sheet(5)), { baseUrl: BASE });
  assert.deepEqual(softKeys(only.xml).map((key) => key.name), ['Dial', 'Exit', 'EditDial']);
});

test('softkeys keep the same positions on every page', () => {
  const [, middle] = buildPages(parseEntries(sheet(70)), { baseUrl: BASE });
  assert.deepEqual(softKeys(middle.xml), [
    { name: 'Dial', url: 'SoftKey:Dial', position: 1 },
    { name: 'Next', url: `${BASE}directory-3.xml`, position: 2 },
    { name: 'Previous', url: `${BASE}directory-1.xml`, position: 3 },
    { name: 'Exit', url: 'SoftKey:Exit', position: 4 },
    { name: 'EditDial', url: 'SoftKey:EditDial', position: 5 },
  ]);
});

test('softkeys come before the entries, as the Cisco schema requires', () => {
  const [page] = buildPages(parseEntries(sheet(1)), { baseUrl: BASE });
  assert.ok(page.xml.lastIndexOf('<SoftKeyItem>') < page.xml.indexOf('<DirectoryEntry>'));
});

test('a base URL without a trailing slash still produces valid links', () => {
  const [first] = buildPages(parseEntries(sheet(40)), { baseUrl: 'http://example.test/phonebook' });
  assert.equal(softKey(first.xml, 'Next').url, 'http://example.test/phonebook/directory-2.xml');
});

test('buildPages rejects a base URL that is not http or https', () => {
  assert.throws(() => buildPages(parseEntries(sheet(1)), { baseUrl: 'example.test/phonebook' }), /base URL/i);
});

test('names combine the owner and details', () => {
  const [page] = buildPages([{ number: '1', owner: 'TESTI1', details: 'Hamshack' }], { baseUrl: BASE });
  assert.match(page.xml, /<Name>TESTI1 \(Hamshack\)<\/Name><Telephone>1<\/Telephone>/);
});

test('a name without details is just the owner', () => {
  const [page] = buildPages([{ number: '1', owner: 'TESTI2', details: '' }], { baseUrl: BASE });
  assert.match(page.xml, /<Name>TESTI2<\/Name>/);
});

test('names are cut to 32 characters, counting ä as one character', () => {
  const details = 'ä'.repeat(50);
  const [page] = buildPages([{ number: '1', owner: 'OH', details }], { baseUrl: BASE });
  assert.match(page.xml, new RegExp(`<Name>OH \\(${'ä'.repeat(28)}</Name>`));
});

test('cutting a name leaves no trailing space', () => {
  const [page] = buildPages([{ number: '1', owner: 'x'.repeat(31), details: 'y' }], { baseUrl: BASE });
  assert.match(page.xml, new RegExp(`<Name>${'x'.repeat(31)}</Name>`));
});

test('special characters are escaped after the name is cut', () => {
  const owner = `${'x'.repeat(31)}&`;
  const [page] = buildPages([{ number: '1', owner, details: '' }], { baseUrl: BASE });
  assert.match(page.xml, new RegExp(`<Name>${'x'.repeat(31)}&amp;</Name>`));
});

test('all five XML special characters are escaped', () => {
  const [page] = buildPages([{ number: '1', owner: `<&>"'`, details: '' }], { baseUrl: BASE });
  assert.match(page.xml, /<Name>&lt;&amp;&gt;&quot;&apos;<\/Name>/);
});

test('pages declare UTF-8', () => {
  const [page] = buildPages(parseEntries(sheet(1)), { baseUrl: BASE });
  assert.ok(page.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});

// renderMenu

test('the menu is a CiscoIPPhoneMenu that opens the first page', () => {
  const xml = renderMenu(BASE);
  assert.match(xml, /<CiscoIPPhoneMenu>/);
  assert.match(xml, new RegExp(`<MenuItem><Name>HamPY puhelinluettelo</Name><URL>${BASE}directory-1.xml</URL></MenuItem>`));
});

// buildPolycomPages

test('Polycom pages are split like the Cisco pages', () => {
  const pages = buildPolycomPages(parseEntries(sheet(40)), { baseUrl: BASE, pageSize: 20 });
  assert.deepEqual(pages.map((page) => page.file), ['polycom-1.html', 'polycom-2.html']);
});

test('Polycom entries are links that dial with tel://, keeping leading zeros', () => {
  const [page] = buildPolycomPages([{ number: '059', owner: 'HamPY', details: 'Ryhmä' }], { baseUrl: BASE });
  assert.match(page.html, /<a href="tel:\/\/059">HamPY \(Ryhmä\)<\/a>/);
});

test('Polycom names are not cut, because the phone wraps long lines', () => {
  const details = 'x'.repeat(50);
  const [page] = buildPolycomPages([{ number: '1', owner: 'OH', details }], { baseUrl: BASE });
  assert.match(page.html, new RegExp(`>OH \\(${details}\\)</a>`));
});

test('Polycom pages show the position', () => {
  const [, page] = buildPolycomPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.match(page.html, /<p>HamPY puhelinluettelo 2\/2<\/p>/);
});

test('the first Polycom page links to Next only', () => {
  const [first] = buildPolycomPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.match(first.html, new RegExp(`<a href="${BASE}polycom-2.html">Next</a>`));
  assert.doesNotMatch(first.html, />Previous</);
});

test('the last Polycom page links to Previous only', () => {
  const [, last] = buildPolycomPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.match(last.html, new RegExp(`<a href="${BASE}polycom-1.html">Previous</a>`));
  assert.doesNotMatch(last.html, />Next</);
});

test('Polycom paging links appear above and below the entries', () => {
  const [first] = buildPolycomPages(parseEntries(sheet(40)), { baseUrl: BASE });
  assert.equal([...first.html.matchAll(/>Next</g)].length, 2);
  assert.ok(first.html.indexOf('>Next<') < first.html.indexOf('tel://'));
  assert.ok(first.html.lastIndexOf('>Next<') > first.html.lastIndexOf('tel://'));
});

test('Polycom names escape special characters for HTML', () => {
  const [page] = buildPolycomPages([{ number: '1', owner: `<&>"'`, details: '' }], { baseUrl: BASE });
  assert.match(page.html, />&lt;&amp;&gt;&quot;&#39;<\/a>/);
});

test('Polycom pages declare UTF-8', () => {
  const [page] = buildPolycomPages(parseEntries(sheet(1)), { baseUrl: BASE });
  assert.match(page.html, /<meta http-equiv="Content-Type" content="text\/html; charset=UTF-8"\/>/);
});

// renderPolycomDirectory

test('the Polycom directory matches the format the phone expects', () => {
  const xml = renderPolycomDirectory([
    { number: '101', owner: 'TESTI4', details: 'Matti' },
    { number: '600', owner: 'HamPY Testinumero', details: '' },
  ]);
  assert.equal(
    xml,
    [
      '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
      '<directory>',
      '  <item_list>',
      '    <item>',
      '      <ln>TESTI4 (Matti)</ln>',
      '      <ct>101</ct>',
      '      <sd>1</sd>',
      '    </item>',
      '    <item>',
      '      <ln>HamPY Testinumero</ln>',
      '      <ct>600</ct>',
      '      <sd>2</sd>',
      '    </item>',
      '  </item_list>',
      '</directory>',
      '',
    ].join('\n'),
  );
});

test('the Polycom directory lists every entry, keeping leading zeros', () => {
  const entries = [...parseEntries(sheet(171)), { number: '059', owner: 'HamPY', details: '' }];
  const xml = renderPolycomDirectory(entries);
  assert.equal([...xml.matchAll(/<item>/g)].length, 172);
  assert.match(xml, /<ct>059<\/ct>\n      <sd>172<\/sd>/);
});

test('Polycom directory names stop at 40 bytes without splitting a character', () => {
  const xml = renderPolycomDirectory([{ number: '1', owner: 'ä'.repeat(25), details: '' }]);
  assert.match(xml, new RegExp(`<ln>${'ä'.repeat(20)}</ln>`));
});

test('Polycom directory names are escaped after they are cut', () => {
  const xml = renderPolycomDirectory([{ number: '1', owner: `${'a'.repeat(39)}&b`, details: '' }]);
  assert.match(xml, new RegExp(`<ln>${'a'.repeat(39)}&amp;</ln>`));
});

// generateFiles

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'phonebook-test-'));
}

const fetchText = (text) => async () => new Response(text);

test('generateFiles writes one file per page', async () => {
  const out = await tempDir();
  await generateFiles({ baseUrl: BASE, out, fetchImpl: fetchText(sheet(40)) });
  assert.deepEqual((await readdir(out)).sort(), [
    '000000000000-directory.xml',
    'directory-1.xml',
    'directory-2.xml',
    'directory.xml',
    'polycom-1.html',
    'polycom-2.html',
  ]);
});

test('generateFiles writes the menu as directory.xml', async () => {
  const out = await tempDir();
  await generateFiles({ baseUrl: BASE, out, fetchImpl: fetchText(sheet(1)) });
  assert.match(await readFile(join(out, 'directory.xml'), 'utf8'), /<CiscoIPPhoneMenu>/);
});

test('generateFiles removes page files left over from a longer list', async () => {
  const out = await tempDir();
  await writeFile(join(out, 'directory-9.xml'), 'old');
  await writeFile(join(out, 'polycom-9.html'), 'old');
  await generateFiles({ baseUrl: BASE, out, fetchImpl: fetchText(sheet(1)) });
  assert.deepEqual((await readdir(out)).sort(), [
    '000000000000-directory.xml',
    'directory-1.xml',
    'directory.xml',
    'polycom-1.html',
  ]);
});

test('generateFiles leaves unrelated files alone', async () => {
  const out = await tempDir();
  await writeFile(join(out, 'index.html'), 'keep');
  await generateFiles({ baseUrl: BASE, out, fetchImpl: fetchText(sheet(1)) });
  assert.equal(await readFile(join(out, 'index.html'), 'utf8'), 'keep');
});

test('generateFiles keeps existing files when the sheet download fails', async () => {
  const out = await tempDir();
  await writeFile(join(out, 'directory.xml'), 'previous');
  const fetchImpl = async () => new Response('nope', { status: 500 });
  await assert.rejects(generateFiles({ baseUrl: BASE, out, fetchImpl }), /500/);
  assert.equal(await readFile(join(out, 'directory.xml'), 'utf8'), 'previous');
});

test('generateFiles keeps existing files when the sheet is not a phonebook', async () => {
  const out = await tempDir();
  await writeFile(join(out, 'directory.xml'), 'previous');
  await assert.rejects(generateFiles({ baseUrl: BASE, out, fetchImpl: fetchText('<html>Sign in</html>') }));
  assert.equal(await readFile(join(out, 'directory.xml'), 'utf8'), 'previous');
});

// Worker

class MemoryCache {
  store = new Map();
  async match(key) {
    return this.store.get(String(key.url ?? key))?.clone();
  }
  async put(key, response) {
    this.store.set(String(key.url ?? key), response.clone());
  }
}

function workerEnv({ fetchImpl, cache = new MemoryCache(), now = () => 0, PAGE_SIZE }) {
  return { fetchImpl, cache, now, PAGE_SIZE };
}

function get(path) {
  return new Request(`http://phonebook.example.test${path}`);
}

test('the worker serves the first page with explicit type and length', async () => {
  const response = await worker.fetch(get('/directory-1.xml'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/xml; charset=UTF-8');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
});

test('the worker serves the menu at directory.xml without fetching the sheet', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return new Response(sheet(1)); };
  const response = await worker.fetch(get('/directory.xml'), workerEnv({ fetchImpl }));
  const xml = await response.text();
  assert.equal(response.headers.get('content-type'), 'text/xml; charset=UTF-8');
  assert.match(xml, /<URL>http:\/\/phonebook\.example\.test\/directory-1\.xml<\/URL>/);
  assert.equal(fetches, 0);
});

test('the worker builds links from the address the phone used, including plain HTTP', async () => {
  const response = await worker.fetch(get('/directory-1.xml'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  assert.equal(softKey(await response.text(), 'Next').url, 'http://phonebook.example.test/directory-2.xml');
});

test('the worker serves later pages', async () => {
  const response = await worker.fetch(get('/directory-2.xml'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  assert.match(await response.text(), /<Title>HamPY puhelinluettelo 2\/2<\/Title>/);
});

test('the worker returns 404 for a page past the end', async () => {
  const response = await worker.fetch(get('/directory-3.xml'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  assert.equal(response.status, 404);
});

test('the worker returns 404 for unknown paths without fetching the sheet', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return new Response(sheet(1)); };
  const response = await worker.fetch(get('/favicon.ico'), workerEnv({ fetchImpl }));
  assert.equal(response.status, 404);
  assert.equal(fetches, 0);
});

test('the worker reuses a recently fetched sheet', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return new Response(sheet(1)); };
  const env = workerEnv({ fetchImpl, now: () => 1000 });
  await worker.fetch(get('/directory-1.xml'), env);
  await worker.fetch(get('/directory-1.xml'), env);
  assert.equal(fetches, 1);
});

test('the worker fetches again once the cached sheet is over five minutes old', async () => {
  let time = 0;
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return new Response(sheet(fetches)); };
  const env = workerEnv({ fetchImpl, now: () => time });
  await worker.fetch(get('/directory-1.xml'), env);
  time = 5 * 60 * 1000 + 1;
  const response = await worker.fetch(get('/directory-1.xml'), env);
  assert.equal(fetches, 2);
  assert.equal(entriesIn(await response.text()), 2);
});

test('the worker serves the stale copy when a refresh fails', async () => {
  let time = 0;
  let healthy = true;
  const fetchImpl = async () => healthy ? new Response(sheet(3)) : new Response('down', { status: 503 });
  const env = workerEnv({ fetchImpl, now: () => time });
  await worker.fetch(get('/directory-1.xml'), env);
  time = 60 * 60 * 1000;
  healthy = false;
  const response = await worker.fetch(get('/directory-1.xml'), env);
  assert.equal(response.status, 200);
  assert.equal(entriesIn(await response.text()), 3);
});

test('the worker does not replace the cached copy with a non-phonebook response', async () => {
  let time = 0;
  let body = sheet(3);
  const fetchImpl = async () => new Response(body);
  const env = workerEnv({ fetchImpl, now: () => time });
  await worker.fetch(get('/directory-1.xml'), env);
  time = 60 * 60 * 1000;
  body = '<html>Sign in</html>';
  const response = await worker.fetch(get('/directory-1.xml'), env);
  assert.equal(entriesIn(await response.text()), 3);
});

test('the worker shows an error screen when the sheet fails and nothing is cached', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fetchImpl = async () => { throw new Error('offline'); };
  const response = await worker.fetch(get('/directory-1.xml'), workerEnv({ fetchImpl }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<CiscoIPPhoneText>/);
});

test('the worker serves Polycom pages as UTF-8 HTML', async () => {
  const response = await worker.fetch(get('/polycom-1.html'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
});

test('the worker builds Polycom links from the address the phone used', async () => {
  const response = await worker.fetch(get('/polycom-1.html'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  assert.match(await response.text(), /<a href="http:\/\/phonebook\.example\.test\/polycom-2\.html">Next<\/a>/);
});

test('the worker returns 404 for a Polycom page past the end', async () => {
  const response = await worker.fetch(get('/polycom-3.html'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  assert.equal(response.status, 404);
});

test('a Polycom phone gets an HTML error screen when the sheet fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fetchImpl = async () => { throw new Error('offline'); };
  const response = await worker.fetch(get('/polycom-1.html'), workerEnv({ fetchImpl }));
  assert.equal(response.headers.get('content-type'), 'text/html; charset=UTF-8');
  assert.doesNotMatch(await response.text(), /CiscoIPPhone/);
});

test('the worker serves the whole Polycom directory as UTF-8 XML', async () => {
  const response = await worker.fetch(get('/000000000000-directory.xml'), workerEnv({ fetchImpl: fetchText(sheet(40)) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/xml; charset=UTF-8');
  assert.equal([...(await response.text()).matchAll(/<item>/g)].length, 40);
});

test('the worker has no per-phone directory, so the phone falls back to the shared one', async () => {
  const response = await worker.fetch(get('/0004f2123456-directory.xml'), workerEnv({ fetchImpl: fetchText(sheet(1)) }));
  assert.equal(response.status, 404);
});

test('the Polycom directory is a 503 when the sheet fails, so no error screen reaches the phone as contacts', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fetchImpl = async () => { throw new Error('offline'); };
  const response = await worker.fetch(get('/000000000000-directory.xml'), workerEnv({ fetchImpl }));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /<directory>/);
});

test('the worker honours PAGE_SIZE', async () => {
  const env = workerEnv({ fetchImpl: fetchText(sheet(40)), PAGE_SIZE: '20' });
  const response = await worker.fetch(get('/directory-1.xml'), env);
  assert.equal(entriesIn(await response.text()), 20);
});
