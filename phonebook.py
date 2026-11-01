#!/usr/bin/env python3
# Paged phonebook for Cisco 7941-style and Polycom VVX 201 phones, built from a public Google Sheet.
#
# The Python version of phonebook.mjs's static files mode, for servers without Node.js. It writes
# byte-identical files. One file, standard library only:
#   python3 phonebook.py --base-url http://host/phonebook/ --out ./public
#
# Limits come from Cisco's CiscoIPPhone.xsd: a CiscoIPPhoneDirectory holds at most
# 32 entries, and each Name holds at most 32 characters.

import argparse
import math
import os
import re
import sys
import urllib.error
import urllib.request

SHEET_URL = 'https://docs.google.com/spreadsheets/d/1-RofQmzz0WvN0BTRmKQFE0E7LXcZdKJMlvmIk9wUoIU/export?format=csv'
TITLE = 'HamPY puhelinluettelo'
PROMPT = 'Valitse numero'
MAX_PAGE_SIZE = 32
MAX_NAME_LENGTH = 32
FETCH_TIMEOUT_SECONDS = 15
MENU_FILE = 'directory.xml'
PAGE_FILE = re.compile(r'directory-[0-9]+\.xml')
POLYCOM_FILE = re.compile(r'polycom-[0-9]+\.html')
POLYCOM_DIRECTORY_FILE = '000000000000-directory.xml'
POLYCOM_MAX_NAME_BYTES = 40

# JavaScript's whitespace. Python's own also includes a few control characters, which would change names.
WHITESPACE = '\t\n\v\f\r                  　﻿'
WHITESPACE_RUN = re.compile('[' + WHITESPACE + ']+')


def parse_csv(text):
    rows = []
    row = []
    cell = []
    quoted = False
    source = text[1:] if text.startswith('﻿') else text

    i = 0
    while i < len(source):
        char = source[i]
        if quoted:
            if char == '"' and source[i + 1:i + 2] == '"':
                cell.append('"')
                i += 1
            elif char == '"':
                quoted = False
            else:
                cell.append(char)
        elif char == '"':
            quoted = True
        elif char == ',':
            row.append(''.join(cell))
            cell = []
        elif char == '\n':
            row.append(''.join(cell))
            rows.append(row)
            row = []
            cell = []
        elif char != '\r':
            cell.append(char)
        i += 1
    row.append(''.join(cell))
    rows.append(row)
    return rows


def clean(value):
    return WHITESPACE_RUN.sub(' ', value).strip(WHITESPACE)


def parse_entries(csv):
    rows = parse_csv(csv)
    header = next((index for index, row in enumerate(rows) if clean(row[0]) == 'Numero'), None)
    if header is None:
        raise ValueError('Sheet has no Numero header row')

    entries = []
    for row in rows[header + 1:]:
        number, owner, details = (row + ['', ''])[:3]
        entry = {'number': clean(number), 'owner': clean(owner), 'details': clean(details)}
        if re.fullmatch(r'[0-9*#]{1,32}', entry['number']):
            entries.append(entry)

    if not entries:
        raise ValueError('Sheet has no entries')
    return entries


def escape_xml(value):
    return (
        value.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&apos;')
    )


def escape_html(value):
    return (
        value.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&#39;')
    )


def full_name(entry):
    if entry['owner'] and entry['details']:
        return '{} ({})'.format(entry['owner'], entry['details'])
    return entry['owner'] or entry['details'] or entry['number']


def display_name(entry):
    return full_name(entry)[:MAX_NAME_LENGTH].rstrip(WHITESPACE)


def soft_key(name, url, position):
    return '<SoftKeyItem><Name>{}</Name><Position>{}</Position><URL>{}</URL></SoftKeyItem>'.format(
        name, position, escape_xml(url)
    )


def page_file(page):
    return 'directory-{}.xml'.format(page)


def normalize_base_url(base_url):
    if not re.match(r'https?://[^/]', base_url, re.IGNORECASE):
        raise ValueError('Base URL must start with http:// or https://: {}'.format(base_url))
    return base_url if base_url.endswith('/') else base_url + '/'


# The phone adds these items to its Directories list, so the directory URL must return a menu.
def render_menu(base_url):
    return '\n'.join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<CiscoIPPhoneMenu>',
        '<Title>{}</Title>'.format(escape_xml(TITLE)),
        '<MenuItem><Name>{}</Name><URL>{}</URL></MenuItem>'.format(
            escape_xml(TITLE), escape_xml(normalize_base_url(base_url) + page_file(1))
        ),
        '</CiscoIPPhoneMenu>',
        '',
    ])


def render_page(entries, page, total, base_url):
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<CiscoIPPhoneDirectory>',
        '<Title>{}</Title>'.format(escape_xml('{} {}/{}'.format(TITLE, page, total))),
        '<Prompt>{}</Prompt>'.format(escape_xml(PROMPT)),
        soft_key('Dial', 'SoftKey:Dial', 1),
    ]
    if page < total:
        lines.append(soft_key('Next', base_url + page_file(page + 1), 2))
    if page > 1:
        lines.append(soft_key('Previous', base_url + page_file(page - 1), 3))
    lines += [
        soft_key('Exit', 'SoftKey:Exit', 4),
        soft_key('EditDial', 'SoftKey:EditDial', 5),
    ]
    lines += [
        '<DirectoryEntry><Name>{}</Name><Telephone>{}</Telephone></DirectoryEntry>'.format(
            escape_xml(display_name(entry)), escape_xml(entry['number'])
        )
        for entry in entries
    ]
    lines += ['</CiscoIPPhoneDirectory>', '']
    return '\n'.join(lines)


def split_pages(entries, page_size):
    if page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise ValueError('Page size must be between 1 and {}: {}'.format(MAX_PAGE_SIZE, page_size))

    total = math.ceil(len(entries) / page_size)
    return [entries[index * page_size:(index + 1) * page_size] for index in range(total)]


def build_pages(entries, base_url, page_size=MAX_PAGE_SIZE):
    base = normalize_base_url(base_url)
    slices = split_pages(entries, page_size)
    return [
        {'file': page_file(index + 1), 'content': render_page(entries_slice, index + 1, len(slices), base)}
        for index, entries_slice in enumerate(slices)
    ]


def polycom_file(page):
    return 'polycom-{}.html'.format(page)


def render_polycom_document(lines):
    return '\n'.join([
        '<html>',
        '<head>',
        '<title>{}</title>'.format(escape_html(TITLE)),
        '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>',
        '</head>',
        '<body>',
        *lines,
        '</body>',
        '</html>',
        '',
    ])


# VVX browsers ignore Cisco-style softkeys, so paging uses plain links above and below the list.
def render_polycom_page(entries, page, total, base_url):
    paging = []
    if page < total:
        paging.append('<a href="{}">Next</a><br/>'.format(escape_html(base_url + polycom_file(page + 1))))
    if page > 1:
        paging.append('<a href="{}">Previous</a><br/>'.format(escape_html(base_url + polycom_file(page - 1))))

    links = [
        '<a href="tel://{}">{}</a><br/>'.format(escape_html(entry['number']), escape_html(full_name(entry)))
        for entry in entries
    ]
    title = '<p>{}</p>'.format(escape_html('{} {}/{}'.format(TITLE, page, total)))
    return render_polycom_document([title] + paging + links + paging)


def build_polycom_pages(entries, base_url, page_size=MAX_PAGE_SIZE):
    base = normalize_base_url(base_url)
    slices = split_pages(entries, page_size)
    return [
        {'file': polycom_file(index + 1), 'content': render_polycom_page(entries_slice, index + 1, len(slices), base)}
        for index, entries_slice in enumerate(slices)
    ]


def polycom_name(entry):
    name = []
    size = 0
    for char in full_name(entry):
        size += len(char.encode('utf-8'))
        if size > POLYCOM_MAX_NAME_BYTES:
            break
        name.append(char)
    return ''.join(name).rstrip(WHITESPACE)


# The contact directory the phone downloads from its provisioning server. Names go in ln. There is
# deliberately no sd, the speed dial index, because contacts with one can take over unused line keys.
def render_polycom_directory(entries):
    lines = [
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
        '<directory>',
        '  <item_list>',
    ]
    for entry in entries:
        lines += [
            '    <item>',
            '      <ln>{}</ln>'.format(escape_xml(polycom_name(entry))),
            '      <ct>{}</ct>'.format(escape_xml(entry['number'])),
            '    </item>',
        ]
    lines += ['  </item_list>', '</directory>', '']
    return '\n'.join(lines)


def fetch_sheet(url):
    try:
        with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_SECONDS) as response:
            return response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        raise OSError('Sheet download failed: HTTP {}'.format(error.code))
    except urllib.error.URLError as error:
        raise OSError('Sheet download failed: {}'.format(error.reason))


def generate_files(base_url, out, page_size=MAX_PAGE_SIZE, sheet_url=SHEET_URL, fetch=fetch_sheet):
    # Everything that can fail on bad input happens before the first write.
    entries = parse_entries(fetch(sheet_url))
    pages = build_pages(entries, base_url, page_size)
    files = [{'file': MENU_FILE, 'content': render_menu(base_url)}]
    files += pages
    files += build_polycom_pages(entries, base_url, page_size)
    files.append({'file': POLYCOM_DIRECTORY_FILE, 'content': render_polycom_directory(entries)})

    os.makedirs(out, exist_ok=True)
    for item in files:
        temp = os.path.join(out, '.{}.tmp'.format(item['file']))
        with open(temp, 'wb') as file:
            file.write(item['content'].encode('utf-8'))
        os.replace(temp, os.path.join(out, item['file']))

    current = {item['file'] for item in files}
    for name in os.listdir(out):
        if (PAGE_FILE.fullmatch(name) or POLYCOM_FILE.fullmatch(name)) and name not in current:
            os.remove(os.path.join(out, name))
    return pages


def main():
    parser = argparse.ArgumentParser(description='Build the HamPY phonebook files.')
    parser.add_argument('--base-url', required=True, help='the address phones use to reach the output folder')
    parser.add_argument('--out', default='./public', help='output folder (default: ./public)')
    parser.add_argument('--page-size', default=str(MAX_PAGE_SIZE), help='entries per page, 1-32 (default: 32)')
    parser.add_argument('--sheet', default=SHEET_URL, help='CSV URL of the sheet')
    args = parser.parse_args()

    try:
        try:
            page_size = int(args.page_size)
        except ValueError:
            raise ValueError('Page size must be between 1 and {}: {}'.format(MAX_PAGE_SIZE, args.page_size))
        pages = generate_files(args.base_url, args.out, page_size, args.sheet)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    print('Wrote {} page(s) per phone type to {}'.format(len(pages), args.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
