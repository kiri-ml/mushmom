const R2_JSONL_PREFIX = "stats/jsonl/";
const OPEN_MONTH_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=3600";
const CLOSED_MONTH_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type StatsRow = [epochSeconds: number, usercount: number]
  | [epochSeconds: number, usercount: number, uniquecount: number]
  | [epochSeconds: number, usercount: null, uniquecount: number];

type R2ObjectBodyLike = {
  text(): Promise<string>;
};

type R2BucketLike = {
  get(key: string): Promise<R2ObjectBodyLike | null>;
};

type PagesContext = {
  request: Request;
  params: { month?: string | string[] };
  env: { STATS_BUCKET?: R2BucketLike };
  waitUntil(promise: Promise<unknown>): void;
};

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const month = context.params.month;
  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
    return json({ error: "invalid_month" }, 400);
  }

  const bucket = context.env.STATS_BUCKET;
  if (!bucket) {
    return json(
      {
        error: "STATS_BUCKET is not configured.",
        data: [],
      },
      503,
    );
  }

  const requestUrl = new URL(context.request.url);
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(normalizeCacheUrl(requestUrl).toString(), {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const cacheControl = cacheControlForMonth(month);
    const response = json(await fetchMonthlyRows(bucket, month), 200, cacheControl);

    context.waitUntil(
      cache.put(cacheKey, response.clone()).catch(() => {
        // Ignore Cache API write failures so a successful R2 response still returns 200.
      }),
    );
    return response;
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch monthly stats.",
        data: [],
      },
      502,
    );
  }
}

async function fetchMonthlyRows(bucket: R2BucketLike, month: string): Promise<StatsRow[]> {
  const key = `${R2_JSONL_PREFIX}${month}.jsonl`;
  const body = await bucket.get(key);
  return body ? parseR2Jsonl(await body.text(), key) : [];
}

function parseR2Jsonl(text: string, key: string): StatsRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  return trimmed.split(/\r?\n/).map((line, index) => {
    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid R2 JSONL in ${key} at line ${index + 1}: malformed JSON.`);
    }

    if (!isStatsRow(row)) {
      throw new Error(`Invalid R2 JSONL in ${key} at line ${index + 1}: expected a two- or three-value stats row.`);
    }
    return row;
  });
}

function isStatsRow(row: unknown): row is StatsRow {
  if (!Array.isArray(row) || (row.length !== 2 && row.length !== 3)
    || !isNonnegativeInteger(row[0])) return false;
  if (row[1] === null) {
    return row.length === 3 && isNonnegativeInteger(row[2]) && row[2] > 0;
  }
  return isNonnegativeInteger(row[1])
    && (row.length === 2 || isNonnegativeInteger(row[2]));
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function cacheControlForMonth(month: string, now = new Date()): string {
  const currentMonth = now.toISOString().slice(0, 7);
  return month < currentMonth ? CLOSED_MONTH_CACHE_CONTROL : OPEN_MONTH_CACHE_CONTROL;
}

function normalizeCacheUrl(url: URL): URL {
  return new URL(url.origin + url.pathname);
}

function json(body: unknown, status = 200, cacheControl = OPEN_MONTH_CACHE_CONTROL): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? cacheControl : "no-store",
    },
  });
}

export const testApi = {
  R2_JSONL_PREFIX,
  OPEN_MONTH_CACHE_CONTROL,
  CLOSED_MONTH_CACHE_CONTROL,
  cacheControlForMonth,
  normalizeCacheUrl,
  fetchMonthlyRows,
  parseR2Jsonl,
};
