# Catalog API

Small Express service that reads provider templates from **MongoDB Atlas** and exposes them as JSON for the Chrome extension.

## Setup

1. Copy `.env.example` to `.env` and set `MONGODB_URI`.
2. Place your private catalog at `../private/providers-catalog.json`.
3. `npm install`
4. `npm run seed` — writes providers into Atlas DB `imdb_stream_finder`
5. `npm start` — serves `GET /providers-catalog.json`

Point the extension popup **Remote catalog URL** at this endpoint (local or your deployed HTTPS URL).

**Do not** put the Atlas connection string in the Chrome extension.
