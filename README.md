# Mushmom

Mushmom is a Cloudflare Pages dashboard for MapleLegends server population
statistics. The frontend is built with Vite, Cloudflare Pages Functions live in
`functions/`, and static passthrough assets live in `public/`.

The app fetches:
- recent historical data through `/api/stats/YYYY-MM` plus archived chunks from `public/assets/stats/`
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
monthly `/api/stats/YYYY-MM` requests work during local development.

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

## Deploy

The Pages Function reads monthly stats from the `STATS_BUCKET` R2 binding
declared in `wrangler.toml`. No Pages secrets or environment variables are
required. Build and deploy with Wrangler:

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

## Stats Worker and R2

Monthly R2 stats are available from `GET /api/stats/YYYY-MM`. The month must use
the zero-padded UTC format, for example `/api/stats/2026-07`. Successful
responses are JSON arrays of `[epochSeconds, usercount]` rows in ascending
order. Missing days are omitted and a month with no objects returns `[]`.

Create the R2 bucket and configure the admin secret:

```sh
npx wrangler r2 bucket create mushmom-stats
npx wrangler secret put ADMIN_TOKEN --config workers/stats/wrangler.toml
```

For local manual sync testing, put `ADMIN_TOKEN="your-token"` in
`workers/stats/.dev.vars`, then run:

```sh
npx wrangler dev --config workers/stats/wrangler.toml
curl -X POST -H "Authorization: Bearer your-token" http://127.0.0.1:8787/admin/sync
```

Deploy the Worker (the five-minute cron is defined in its Wrangler config):

```sh
npx wrangler deploy --config workers/stats/wrangler.toml
```

Run the Worker tests and TypeScript checks:

```sh
npm test -- workers/stats
npm run typecheck
```
