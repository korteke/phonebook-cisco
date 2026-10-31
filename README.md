# HamPY phonebook for Cisco IP phones

Turns the HamPY Google Sheet into paged `CiscoIPPhoneDirectory` XML for Cisco 7941-style phones.
It is one JavaScript file with no dependencies and no database. The sheet must stay publicly readable.

`directory.xml` is a one-item menu, which the phone adds to its Directories list. The item opens
`directory-1.xml`, and each page links to its neighbours with the Next and Previous softkeys.

## Run as static files

Requires Node.js 18 or newer.

```sh
node phonebook.mjs --base-url http://your-server/phonebook/ --out ./public
```

Serve the output folder with any web server, as `text/xml; charset=UTF-8`. `--base-url` must be the
address phones use to reach the folder, because each page links to the next with a full address.
Run the command on a schedule to pick up sheet changes. If the sheet can't be read, the existing
files are left alone and the command exits with an error.

Options: `--page-size` (1-32, default 32) and `--sheet` (a CSV URL).

## Run as a Cloudflare Worker

```sh
npx wrangler login
npx wrangler deploy
```

Point the phone's `directoryURL` at `http://<worker-address>/directory.xml`. Use `http://`, and turn
off "Always Use HTTPS" if the Worker is on a custom domain.

The Worker rereads the sheet at most every five minutes per Cloudflare location. If the sheet can't
be read, it serves the last cached copy, or a short error screen if it has none. Set the optional
`PAGE_SIZE` and `SHEET_URL` variables to override the defaults.

## Phone limits

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
```
