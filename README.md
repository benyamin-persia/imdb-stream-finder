# IMDb Stream Finder (Chrome)

Chrome extension that scans the current page for an **IMDb** / **TMDB** id, then fills your own stream-link templates (movie or TV with season/episode). Includes an in-app player, playability checks, toggleable popup/ad locker, and a right-click **Search on IMDb** action for selected text.

## Install (Chrome)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`imdb-stream-finder` after clone)

## How it works

1. Open any page that contains an IMDb id (or paste ids in the panel).
2. The Stream Finder dock appears on the right edge (hover to open).
3. Choose **Movie** or **TV**; for TV set season/episode.
4. Play or open links built from your configured templates.
5. Highlight text anywhere → right-click → **Search on IMDb**.

## Placeholders for custom links

| Token | Example | Meaning |
| --- | --- | --- |
| `{imdb}` | `tt0110357` | Full IMDb id |
| `{imdb_raw}` | `0110357` | Digits only |
| `{tmdb}` | `1084242` | TMDB numeric id |
| `{season}` | `1` | TV season |
| `{episode}` | `1` | TV episode |
| `{type}` | `movie` / `tv` | Media type |

## Provider catalog (private)

Default provider templates are **not** published in this repository. They live in **MongoDB Atlas** and are served by a small **catalog API** you host (credentials never go in the Chrome extension).

1. Copy `catalog-api/.env.example` → `catalog-api/.env` and set your Atlas URI.
2. Keep a private catalog file at `private/providers-catalog.json` (gitignored).
3. Seed Atlas: `cd catalog-api && npm install && npm run seed`
4. Run API: `npm start` → `http://127.0.0.1:8787/providers-catalog.json`
5. In the extension popup, set **Remote catalog URL** to that endpoint (or your deployed HTTPS URL) and sync.

Optional: set `CATALOG_TOKEN` in `.env` and send `Authorization: Bearer …` from your sync client for a locked-down catalog.

### Security model

| Layer | Role |
| --- | --- |
| **MongoDB Atlas** | Stores provider documents only. Use Network Access IP allowlist + least-privilege DB user. |
| **Catalog API** (`catalog-api/`) | Only service that may use `MONGODB_URI`. Deploy on Railway, Render, Fly.io, Cloudflare Workers+proxy, etc. |
| **Chrome extension** | Fetches HTTPS catalog JSON only. **Never** embed Atlas passwords in the extension. |

Atlas is the database, not the “app portal.” The extension stays a Chrome add-on; the API is the only bridge to MongoDB.

## Privacy / secrets

Do not commit:

- `atlas-credentials*.env`, `catalog-api/.env`
- `private/providers-catalog.json`
- any MongoDB passwords

If a password was ever pasted into chat or a public file, **rotate it in Atlas** immediately.
