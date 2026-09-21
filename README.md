# IMDb Stream Finder (Chrome)

Chrome extension that finds **IMDb** / **TMDB** ids on the current page and builds configurable stream link templates. Supports movies and TV (season + episode), an in-app player, popup/ad locker, and a right-click **Search on IMDb** action.

## Install (Chrome)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder

Sources are included — open any IMDb title page and use the **SF** tab in the **top-left** corner.

## How it works

1. Visit a page with an IMDb / TMDB id, **or highlight a movie/TV title** on any page.
2. Stream Finder appears as the **SF** button in the **top-left** (it stays hidden on unrelated pages).
3. Choose **Movie** or **TV**; for TV set season/episode. For a highlighted title, tap **Lookup**.
4. Play or open a source. Add custom templates in the popup anytime.
5. Highlight text → right-click → **Search on IMDb** (also works).

## Placeholders

| Token | Example | Meaning |
| --- | --- | --- |
| `{imdb}` | `tt0110357` | Full IMDb id |
| `{imdb_raw}` | `0110357` | Digits only |
| `{tmdb}` | `1084242` | TMDB numeric id |
| `{season}` | `1` | TV season |
| `{episode}` | `1` | TV episode |
| `{type}` | `movie` | Media type |

## Updates for users

When you ship a new build:

1. Bump `manifest.json` **and** `version.json` to the same version.
2. Push to GitHub.
3. Friends’ extensions check `version.json` every few hours — they get a **NEW** badge on the toolbar icon, a banner in the popup, and a tip in the Stream Finder panel.

## Latest releases panel

The popup can list recent titles from the configured releases feed (see `releasesFeed` in `version.json`). Because that site uses a bot check, click **Refresh list** once, pass the check in the opened tab, then reopen the popup — titles are saved automatically.
