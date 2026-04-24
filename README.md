# Mushmom

Mushmom is a frontend-only Cloudflare Pages dashboard for MapleLegends server
population statistics. It fetches historical data through a Pages Function at
`/api/stats`, fetches current online users through `/api/current`, and
visualizes the time series with Apache ECharts.

## Data Shape

The dashboard expects a long list of points. Each point can be an object:

```json
{ "timestamp": "2026-04-23 12:00:03.581+00", "usercount": 1459 }
```

It also accepts array rows such as:

```json
["2026-04-23 12:00:03.581+00", 1459]
```

## Local Development

```sh
npm run dev -- --ip 127.0.0.1
```

Open `http://127.0.0.1:8788`.

For local Google API testing, create `.dev.vars`:

```sh
GOOGLE_API_URL="https://example.googleapis.com/your-json-endpoint"
GOOGLE_API_CACHE_TTL="3600"
```

If `GOOGLE_API_URL` is not set, `/api/stats` returns `503` and the frontend
shows an unavailable state.

The dashboard loads data on page load.
`/api/stats` caches the Google API response for 60 minutes by default to reduce
upstream requests.

## Deploy

Set `GOOGLE_API_URL` as a Cloudflare Pages secret or environment variable, then
deploy from the `main` branch for production:

```sh
npm run deploy
```

The deploy script runs `wrangler pages deploy public --project-name mushmom`.
Cloudflare Pages treats deployments on the configured production branch as
`Production`; deployments from other branches show up as `Preview`.

The Pages output directory is `public/`, and Pages Functions live under
`functions/`.
