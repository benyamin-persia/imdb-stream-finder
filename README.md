# IMDb Stream Finder (Chrome)

Chrome extension that finds **IMDb** / **TMDB** ids on the current page and builds configurable stream link templates. Supports movies and TV (season + episode), an in-app player, popup/ad locker, and a right-click **Search on IMDb** action.

## Install (Chrome)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## How it works

1. Visit a page with an IMDb id (or paste ids in the panel).
2. Hover the right edge to open the stream dock.
3. Choose **Movie** or **TV**; for TV set season/episode.
4. Play or open a source. Add custom templates in the popup anytime.
5. Highlight text → right-click → **Search on IMDb**.

## Placeholders

| Token | Example | Meaning |
| --- | --- | --- |
| `{imdb}` | `tt0110357` | Full IMDb id |
| `{imdb_raw}` | `0110357` | Digits only |
| `{tmdb}` | `1084242` | TMDB numeric id |
| `{season}` | `1` | TV season |
| `{episode}` | `1` | TV episode |
| `{type}` | `movie` | Media type |

Custom template examples use `https://example.com/...` only in docs — add your own hosts in the popup.

## Provider list (not on GitHub)

Provider URLs are kept in **local-only** files that are gitignored (not published):

- `shared/providers.local.js`
- `providers.private.json`

The extension loads those on your machine. GitHub only has an empty catalog stub.
