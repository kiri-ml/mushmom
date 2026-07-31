const R2_JSON_PREFIX = "stats/json/";
const OPEN_MONTH_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const CLOSED_MONTH_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

type R2ObjectBodyLike = {
  body: ReadableStream<Uint8Array>;
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
    const response = await fetchMonthlyJsonResponse(bucket, month, cacheControl);

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

async function fetchMonthlyJsonResponse(
  bucket: R2BucketLike,
  month: string,
  cacheControl: string,
): Promise<Response> {
  const object = await bucket.get(`${R2_JSON_PREFIX}${month}.json`);
  return new Response(object?.body ?? "[]", {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
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
  OPEN_MONTH_CACHE_CONTROL,
  CLOSED_MONTH_CACHE_CONTROL,
  cacheControlForMonth,
  normalizeCacheUrl,
};
