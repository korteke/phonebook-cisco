# HamPY phonebook for Cisco and Polycom IP phones

Turns the HamPY Google Sheet into paged phonebooks for Cisco 7941-style phones and the Polycom VVX 201.
It is one file with no dependencies and no database, in JavaScript (`phonebook.mjs`) or Python
(`phonebook.py`). The sheet must stay publicly readable.

`directory.xml` is a one-item menu, which the phone adds to its Directories list. The item opens
`directory-1.xml`, and each page links to its neighbours with the Next and Previous softkeys.

Polycom phones get `000000000000-directory.xml`, a contact directory they download from their
provisioning server. The browser pages `polycom-1.html`, `polycom-2.html` and so on are a second way
to reach the list: selecting an entry dials it, and Next and Previous are links above and below it.

## Set up a phone

Cisco, in the phone's config file:

```xml
<directoryURL>http://<address>/directory.xml</directoryURL>
```

Polycom contact directory: copy `000000000000-directory.xml` to the phone's provisioning server. The
phone has no setting for a directory URL, so it needs a provisioning server. An older Polycom guide
says the server's copy replaces the phone's at boot, but forum reports say a phone may download it
only once, so check that sheet changes arrive.

Polycom browser pages (UC Software 5.5.0 or newer), in the phone's config file. Open the phonebook from
Home > Applications. `mb.main.reloadPage` opens page 1 each time, and `mb.main.idleTimeout` gives
five minutes before the phone leaves the browser, instead of the default 40 seconds:

```xml
<polycomConfig>
  <mb mb.main.home="http://<address>/polycom-1.html" mb.main.reloadPage="1" mb.main.idleTimeout="300"/>
</polycomConfig>
```

## Run as static files

Use either version, which write identical files: Node.js 18 or newer, or Python 3.6 or newer. Node
or Python only builds the files, and your web server serves them.

```sh
node phonebook.mjs --base-url http://your-server/phonebook/ --out ./public
python3 phonebook.py --base-url http://your-server/phonebook/ --out ./public
```

Serve the output folder with any web server, with `.xml` as `text/xml; charset=UTF-8` and `.html` as
`text/html; charset=UTF-8`. `--base-url` must be the
address phones use to reach the folder, because each page links to the next with a full address.
Run the command on a schedule to pick up sheet changes. If the sheet can't be read, the existing
files are left alone and the command exits with an error.

Options: `--page-size` (1-32, default 32) and `--sheet` (a CSV URL).

## Run as a Cloudflare Worker

```sh
npx wrangler login
npx wrangler deploy
```

Use `http://` in phone configs, and turn off "Always Use HTTPS" if the Worker is on a custom domain.

The Worker rereads the sheet at most every five minutes per Cloudflare location. If the sheet can't
be read, it serves the last cached copy, or a short error screen if it has none. Set the optional
`PAGE_SIZE` and `SHEET_URL` variables to override the defaults.

## Phone limits

From Poly's and 8x8's published tables, a VVX 201 directory file holds 99 contacts. The file lists
every entry anyway, and they don't say what the phone does with the rest. The browser pages have no
such limit. Names are cut to 40 bytes, the limit in Poly's admin guide.

From Cisco's `CiscoIPPhone.xsd`, which the 7941 parser enforces:

| Limit | Value |
|---|---|
| Entries in a `CiscoIPPhoneDirectory` | 32 |
| Characters in an entry name | 32 (longer names are cut) |
| Items in a `CiscoIPPhoneMenu` | 100 |

Softkeys must come before the entries, with `Position` before `URL`. The examples in Cisco's guide
show a different order, but the schema doesn't allow it.

## Test

```sh
npm test
python3 -m unittest test_phonebook
```

The Python tests also check that both versions write identical files, and skip that without Node.js.
A change to the generated files needs making in both versions.
