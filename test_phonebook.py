import filecmp
import http.server
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

import phonebook

BASE = 'http://example.test/phonebook/'
HERE = os.path.dirname(os.path.abspath(__file__))

# Every awkward thing the two versions must treat alike.
TRICKY_SHEET = (
    '﻿Otsikkorivi,,\r\n'
    ',,\r\n'
    'Numero,Haltija,Lisätietoja\r\n'
    '059,HamPY,Yleinen ryhmäpuhelu\r\n'
    '13333,TESTI3,"Testinén, ""PE"", Järvikylä"\r\n'
    '1, TESTI5  x ,y\n'
    '2,"Line\nbreak",\n'
    '3,<&>"\',\n'
    '4,,Only details\n'
    '5,,\n'
    '*6#,Star,\n'
    '7,' + 'ä' * 50 + ',\n'
    '8,' + 'x' * 31 + ',y\n'
    '9,' + 'a' * 39 + ',é\n'
    '10,😀😀😀😀😀😀😀😀😀😀😀😀,😀\n'
    '11,no break space　,\n'
    '12,control\x1cchar\x85next,\n'
    'not a number,skipped,\n'
    '123456789012345678901234567890123,too long,\n'
    ',,\n'
    + ''.join('{},OH2T{},Koti\n'.format(20000 + i, i) for i in range(70))
)


def sheet(count):
    rows = ['Title row,,', ',,', 'Numero,Haltija,Lisätietoja']
    rows += ['{},OH2T{},Koti'.format(10000 + i, i) for i in range(1, count + 1)]
    return '\n'.join(rows)


def entries_in(xml):
    return xml.count('<DirectoryEntry>')


def soft_keys(xml):
    pattern = r'<SoftKeyItem><Name>(.*?)</Name><Position>(\d+)</Position><URL>(.*?)</URL></SoftKeyItem>'
    return [(name, int(position), url) for name, position, url in re.findall(pattern, xml)]


def soft_key_url(xml, wanted):
    return next((url for name, _, url in soft_keys(xml) if name == wanted), None)


def fetch_text(text):
    return lambda url: text


def read(folder, name):
    with open(os.path.join(folder, name), encoding='utf-8') as file:
        return file.read()


def write(folder, name, text):
    with open(os.path.join(folder, name), 'w', encoding='utf-8') as file:
        file.write(text)


class TempDirTest(unittest.TestCase):
    def temp_dir(self):
        folder = tempfile.mkdtemp(prefix='phonebook-test-')
        self.addCleanup(shutil.rmtree, folder)
        return folder


class ParseEntriesTest(unittest.TestCase):
    def test_reads_rows_below_the_numero_header_and_skips_rows_without_a_number(self):
        csv = 'Otsikkorivi,,\n,,\nNumero,Haltija,Lisätietoja\n11111,TESTI1,Hamshack\n,,\n12222,TESTI2,\n'
        self.assertEqual(phonebook.parse_entries(csv), [
            {'number': '11111', 'owner': 'TESTI1', 'details': 'Hamshack'},
            {'number': '12222', 'owner': 'TESTI2', 'details': ''},
        ])

    def test_keeps_leading_zeros(self):
        self.assertEqual(phonebook.parse_entries('Numero,Haltija,Lisätietoja\n059,HamPY,Ryhmä')[0]['number'], '059')

    def test_handles_quoted_commas_doubled_quotes_and_crlf(self):
        csv = 'Numero,Haltija,Lisätietoja\r\n13333,TESTI3,"Testinén, ""PE"", Järvikylä"\r\n'
        self.assertEqual(phonebook.parse_entries(csv)[0]['details'], 'Testinén, "PE", Järvikylä')

    def test_collapses_stray_whitespace(self):
        self.assertEqual(phonebook.parse_entries('Numero,Haltija,Lisätietoja\n1, TESTI5  x ,y')[0]['owner'], 'TESTI5 x')

    def test_ignores_a_byte_order_mark(self):
        self.assertEqual(phonebook.parse_entries('﻿Numero,Haltija\n1,A')[0]['owner'], 'A')

    def test_rejects_a_response_without_the_numero_header(self):
        with self.assertRaisesRegex(ValueError, 'Numero'):
            phonebook.parse_entries('<!DOCTYPE html><html>Sign in</html>')

    def test_rejects_a_sheet_with_no_entries(self):
        with self.assertRaisesRegex(ValueError, 'no entries'):
            phonebook.parse_entries('Numero,Haltija,Lisätietoja\n,,\n')


class BuildPagesTest(unittest.TestCase):
    def test_splits_170_entries_into_six_pages_of_at_most_32(self):
        pages = phonebook.build_pages(phonebook.parse_entries(sheet(170)), BASE)
        self.assertEqual([entries_in(page['content']) for page in pages], [32, 32, 32, 32, 32, 10])

    def test_numbers_every_page_leaving_directory_xml_for_the_menu(self):
        pages = phonebook.build_pages(phonebook.parse_entries(sheet(40)), BASE)
        self.assertEqual([page['file'] for page in pages], ['directory-1.xml', 'directory-2.xml'])

    def test_honours_a_smaller_page_size(self):
        pages = phonebook.build_pages(phonebook.parse_entries(sheet(40)), BASE, 20)
        self.assertEqual([entries_in(page['content']) for page in pages], [20, 20])

    def test_rejects_a_page_size_over_the_limit(self):
        with self.assertRaisesRegex(ValueError, '(?i)page size'):
            phonebook.build_pages(phonebook.parse_entries(sheet(40)), BASE, 33)

    def test_the_title_shows_the_page_position(self):
        pages = phonebook.build_pages(phonebook.parse_entries(sheet(170)), BASE)
        self.assertIn('<Title>HamPY puhelinluettelo 2/6</Title>', pages[1]['content'])

    def test_the_first_page_has_next_but_no_previous(self):
        first = phonebook.build_pages(phonebook.parse_entries(sheet(40)), BASE)[0]['content']
        self.assertEqual(soft_key_url(first, 'Next'), BASE + 'directory-2.xml')
        self.assertIsNone(soft_key_url(first, 'Previous'))

    def test_the_last_page_has_previous_but_no_next(self):
        last = phonebook.build_pages(phonebook.parse_entries(sheet(40)), BASE)[1]['content']
        self.assertEqual(soft_key_url(last, 'Previous'), BASE + 'directory-1.xml')
        self.assertIsNone(soft_key_url(last, 'Next'))

    def test_softkeys_keep_the_same_positions_on_every_page(self):
        middle = phonebook.build_pages(phonebook.parse_entries(sheet(70)), BASE)[1]['content']
        self.assertEqual(soft_keys(middle), [
            ('Dial', 1, 'SoftKey:Dial'),
            ('Next', 2, BASE + 'directory-3.xml'),
            ('Previous', 3, BASE + 'directory-1.xml'),
            ('Exit', 4, 'SoftKey:Exit'),
            ('EditDial', 5, 'SoftKey:EditDial'),
        ])

    def test_softkeys_come_before_the_entries(self):
        page = phonebook.build_pages(phonebook.parse_entries(sheet(1)), BASE)[0]['content']
        self.assertLess(page.rindex('<SoftKeyItem>'), page.index('<DirectoryEntry>'))

    def test_a_base_url_without_a_trailing_slash_still_produces_valid_links(self):
        first = phonebook.build_pages(phonebook.parse_entries(sheet(40)), 'http://example.test/phonebook')[0]['content']
        self.assertEqual(soft_key_url(first, 'Next'), 'http://example.test/phonebook/directory-2.xml')

    def test_rejects_a_base_url_that_is_not_http_or_https(self):
        with self.assertRaisesRegex(ValueError, '(?i)base url'):
            phonebook.build_pages(phonebook.parse_entries(sheet(1)), 'example.test/phonebook')

    def test_names_are_cut_to_32_characters_counting_a_umlaut_as_one(self):
        entry = {'number': '1', 'owner': 'OH', 'details': 'ä' * 50}
        self.assertIn('<Name>OH (' + 'ä' * 28 + '</Name>', phonebook.build_pages([entry], BASE)[0]['content'])

    def test_cutting_a_name_leaves_no_trailing_space(self):
        entry = {'number': '1', 'owner': 'x' * 31, 'details': 'y'}
        self.assertIn('<Name>' + 'x' * 31 + '</Name>', phonebook.build_pages([entry], BASE)[0]['content'])

    def test_special_characters_are_escaped_after_the_name_is_cut(self):
        entry = {'number': '1', 'owner': 'x' * 31 + '&', 'details': ''}
        self.assertIn('<Name>' + 'x' * 31 + '&amp;</Name>', phonebook.build_pages([entry], BASE)[0]['content'])

    def test_all_five_xml_special_characters_are_escaped(self):
        entry = {'number': '1', 'owner': '<&>"\'', 'details': ''}
        self.assertIn('<Name>&lt;&amp;&gt;&quot;&apos;</Name>', phonebook.build_pages([entry], BASE)[0]['content'])


class RenderMenuTest(unittest.TestCase):
    def test_the_menu_opens_the_first_page(self):
        xml = phonebook.render_menu(BASE)
        self.assertIn('<CiscoIPPhoneMenu>', xml)
        self.assertIn('<MenuItem><Name>HamPY puhelinluettelo</Name><URL>' + BASE + 'directory-1.xml</URL></MenuItem>', xml)


class PolycomTest(unittest.TestCase):
    def test_pages_are_split_like_the_cisco_pages(self):
        pages = phonebook.build_polycom_pages(phonebook.parse_entries(sheet(40)), BASE, 20)
        self.assertEqual([page['file'] for page in pages], ['polycom-1.html', 'polycom-2.html'])

    def test_entries_dial_with_tel_links_keeping_leading_zeros(self):
        entry = {'number': '059', 'owner': 'HamPY', 'details': 'Ryhmä'}
        self.assertIn('<a href="tel://059">HamPY (Ryhmä)</a><br/>', phonebook.build_polycom_pages([entry], BASE)[0]['content'])

    def test_html_escapes_quotes_differently_from_xml(self):
        entry = {'number': '1', 'owner': '<&>"\'', 'details': ''}
        self.assertIn('&lt;&amp;&gt;&quot;&#39;', phonebook.build_polycom_pages([entry], BASE)[0]['content'])

    def test_directory_matches_the_format_the_phone_expects(self):
        xml = phonebook.render_polycom_directory([
            {'number': '101', 'owner': 'TESTI4', 'details': 'Matti'},
            {'number': '600', 'owner': 'HamPY Testinumero', 'details': ''},
        ])
        self.assertEqual(xml, '\n'.join([
            '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
            '<directory>',
            '  <item_list>',
            '    <item>',
            '      <ln>TESTI4 (Matti)</ln>',
            '      <ct>101</ct>',
            '    </item>',
            '    <item>',
            '      <ln>HamPY Testinumero</ln>',
            '      <ct>600</ct>',
            '    </item>',
            '  </item_list>',
            '</directory>',
            '',
        ]))

    def test_directory_names_stop_at_40_bytes_without_splitting_a_character(self):
        xml = phonebook.render_polycom_directory([{'number': '1', 'owner': 'ä' * 25, 'details': ''}])
        self.assertIn('<ln>' + 'ä' * 20 + '</ln>', xml)


class GenerateFilesTest(TempDirTest):
    def test_writes_one_file_per_page(self):
        out = self.temp_dir()
        phonebook.generate_files(BASE, out, fetch=fetch_text(sheet(40)))
        self.assertEqual(sorted(os.listdir(out)), [
            '000000000000-directory.xml',
            'directory-1.xml',
            'directory-2.xml',
            'directory.xml',
            'polycom-1.html',
            'polycom-2.html',
        ])

    def test_creates_the_output_folder(self):
        out = os.path.join(self.temp_dir(), 'a', 'b')
        phonebook.generate_files(BASE, out, fetch=fetch_text(sheet(1)))
        self.assertIn('<CiscoIPPhoneMenu>', read(out, 'directory.xml'))

    def test_removes_page_files_left_over_from_a_longer_list(self):
        out = self.temp_dir()
        write(out, 'directory-9.xml', 'old')
        write(out, 'polycom-9.html', 'old')
        phonebook.generate_files(BASE, out, fetch=fetch_text(sheet(1)))
        self.assertEqual(sorted(os.listdir(out)), [
            '000000000000-directory.xml',
            'directory-1.xml',
            'directory.xml',
            'polycom-1.html',
        ])

    def test_leaves_unrelated_files_alone(self):
        out = self.temp_dir()
        write(out, 'index.html', 'keep')
        phonebook.generate_files(BASE, out, fetch=fetch_text(sheet(1)))
        self.assertEqual(read(out, 'index.html'), 'keep')

    def test_keeps_existing_files_when_the_download_fails(self):
        out = self.temp_dir()
        write(out, 'directory.xml', 'previous')

        def fail(url):
            raise OSError('Sheet download failed: HTTP 500')

        with self.assertRaisesRegex(OSError, '500'):
            phonebook.generate_files(BASE, out, fetch=fail)
        self.assertEqual(read(out, 'directory.xml'), 'previous')

    def test_keeps_existing_files_when_the_sheet_is_not_a_phonebook(self):
        out = self.temp_dir()
        write(out, 'directory.xml', 'previous')
        with self.assertRaises(ValueError):
            phonebook.generate_files(BASE, out, fetch=fetch_text('<html>Sign in</html>'))
        self.assertEqual(read(out, 'directory.xml'), 'previous')

    def test_keeps_existing_files_when_the_page_size_is_invalid(self):
        out = self.temp_dir()
        write(out, 'directory.xml', 'previous')
        with self.assertRaises(ValueError):
            phonebook.generate_files(BASE, out, page_size=33, fetch=fetch_text(sheet(1)))
        self.assertEqual(read(out, 'directory.xml'), 'previous')


class SheetServer:
    """Serves one body over HTTP, so both versions download the sheet the way they do for real."""

    def __init__(self, body, status=200):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(status)
                self.send_header('Content-Type', 'text/csv; charset=utf-8')
                self.end_headers()
                self.wfile.write(body.encode('utf-8'))

            def log_message(self, format, *args):
                pass

        self.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:{}/sheet.csv'.format(self.server.server_address[1])

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()


def run_cli(*args):
    return subprocess.run(
        [sys.executable, os.path.join(HERE, 'phonebook.py')] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        encoding='utf-8',
        timeout=60,
    )


class CliTest(TempDirTest):
    def test_downloads_the_sheet_and_writes_the_files(self):
        out = self.temp_dir()
        with SheetServer(sheet(40)) as server:
            result = run_cli('--base-url', BASE, '--out', out, '--sheet', server.url)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Wrote 2 page(s) per phone type', result.stdout)
        self.assertIn('<Telephone>10001</Telephone>', read(out, 'directory-1.xml'))

    def test_honours_the_page_size_option(self):
        out = self.temp_dir()
        with SheetServer(sheet(40)) as server:
            result = run_cli('--base-url', BASE, '--out', out, '--sheet', server.url, '--page-size', '20')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(entries_in(read(out, 'directory-1.xml')), 20)

    def test_exits_with_an_error_and_keeps_files_when_the_download_fails(self):
        out = self.temp_dir()
        write(out, 'directory.xml', 'previous')
        with SheetServer('nope', status=500) as server:
            result = run_cli('--base-url', BASE, '--out', out, '--sheet', server.url)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('500', result.stderr)
        self.assertEqual(read(out, 'directory.xml'), 'previous')

    def test_exits_with_an_error_for_a_page_size_that_is_not_a_number(self):
        result = run_cli('--base-url', BASE, '--out', self.temp_dir(), '--page-size', 'lots')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('lots', result.stderr)

    def test_requires_a_base_url(self):
        self.assertNotEqual(run_cli().returncode, 0)


@unittest.skipUnless(shutil.which('node'), 'Node.js is needed to compare with the JavaScript version')
class MatchesJavaScriptTest(TempDirTest):
    def compare(self, body, *options):
        python_out = self.temp_dir()
        node_out = self.temp_dir()
        with SheetServer(body) as server:
            common = ['--base-url', BASE, '--sheet', server.url] + list(options)
            result = run_cli('--out', python_out, *common)
            self.assertEqual(result.returncode, 0, result.stderr)
            subprocess.run(['node', os.path.join(HERE, 'phonebook.mjs'), '--out', node_out] + common, check=True, stdout=subprocess.DEVNULL, timeout=60)

        files = sorted(os.listdir(node_out))
        self.assertGreater(len(files), 3)
        self.assertEqual(sorted(os.listdir(python_out)), files)
        _, mismatch, errors = filecmp.cmpfiles(python_out, node_out, files, shallow=False)
        self.assertEqual((mismatch, errors), ([], []))

    def test_tricky_sheet_produces_identical_files(self):
        self.compare(TRICKY_SHEET)

    def test_smaller_pages_produce_identical_files(self):
        self.compare(TRICKY_SHEET, '--page-size', '7')


if __name__ == '__main__':
    unittest.main()
