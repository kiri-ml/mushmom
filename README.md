# Mushmom

Mushmom is a Cloudflare Pages dashboard for MapleLegends server population
statistics. The frontend is built with Vite, Cloudflare Pages Functions live in
`functions/`, and static passthrough assets live in `public/`.

The app fetches:
- historical data through `/api/stats/latest` plus archived chunks from `public/assets/stats/`
- current online users through `/api/current`
- bundled translations from `src/i18n/*.json`

It visualizes the time series with Apache ECharts.

## Data Shape

The dashboard accepts a long list of points. Each point can be an object:

```json
{ "timestamp": "2026-04-23 12:00:03.581+00", "usercount": 1459 }
```

It also accepts compact array rows such as:

```json
["2026-04-23 12:00:03.581+00", 1459]
```

Epoch-second rows are also supported.

## Project Layout

- `index.html` - Vite HTML entry
- `src/main.ts` - single frontend bootstrap entrypoint
- `src/app.ts` - charting and app runtime logic
- `src/i18n.ts` - i18n loading and language handling
- `src/load.ts` - stats/archive loading helpers
- `src/styles.css` - app styles
- `public/` - static files copied as-is to the build output
- `src/i18n/*.json` - bundled locale data split by language
- `functions/` - Cloudflare Pages Functions
- `dist/` - Vite production build output

## Local Development

Install dependencies:

```sh
npm install
```

Start the local Cloudflare Pages preview:

```sh
npm run dev
```

Open `http://127.0.0.1:8788`. Wrangler serves the Pages Functions in
`functions/` and proxies frontend requests to Vite, so `/api/current` and
`/api/stats/latest` work during local development.

To use different ports:

```sh
WRANGLER_PORT=8790 VITE_PORT=5174 npm run dev
```

To preview the production bundle locally after building:

```sh
npm run preview
```

Type-check and run tests:

```sh
npm run typecheck
npm test
```

Create a production build:

```sh
npm run build
```

## Cloudflare local/dev notes

For local Google API testing, create `.dev.vars`:

```sh
GOOGLE_API_URL="https://example.googleapis.com/your-json-endpoint"
GOOGLE_API_CACHE_TTL="3600"
```

If `GOOGLE_API_URL` is not set, the stats function can return an unavailable
state and the frontend will reflect that.

## Deploy

Set `GOOGLE_API_URL` as a Cloudflare Pages secret or environment variable, then
build and deploy with Wrangler:

```sh
npm run build
npm run deploy
```

The deploy script publishes `dist/`:

```sh
wrangler pages deploy dist --project-name mushmom
```

Cloudflare Pages should use:
- output directory: `dist`
- Pages Functions directory: `functions/`
