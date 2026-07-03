const R2_JSONL_PREFIX = "stats/jsonl/";
const R2_DAILY_KEY_PATTERN = /^stats\/jsonl\/\d{4}-\d{2}-\d{2}\.jsonl$/;
const CLIENT_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=3600";
const INVALID_AFTER = Symbol("invalid_after");

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const afterValue = requestUrl.searchParams.get("after");

  if (afterValue == null) {
    return json({ error: "missing_after" }, 400);
  }

  const after = parseAfter(afterValue);
  if (after === INVALID_AFTER) {
    return json({ error: "invalid_after" }, 400);
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

  const cache = caches.default;
  const cacheKey = new Request(normalizeCacheUrl(requestUrl, after).toString(), {
    method: "GET",
  });
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const response = json({
      source: "R2",
      sourceUrl: null,
      fetchedAt: new Date().toISOString(),
      after,
      completeWindow: true,
      data: await fetchR2Rows(bucket, after),
    });

    context.waitUntil(
      cache.put(cacheKey, response.clone()).catch(() => {
        // Ignore Cache API write failures so a successful R2 response still returns 200.
      }),
    );
    return response;
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch latest stats.",
        data: [],
      },
      502,
    );
  }
}

async function fetchR2Rows(bucket, after) {
  const minimumKey = dailyKeyForTimestamp(after);
  const objects = [];
  let cursor;

  do {
    const listed = await bucket.list({
      prefix: R2_JSONL_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    objects.push(...listed.objects.filter(({ key }) =>
      R2_DAILY_KEY_PATTERN.test(key) && key >= minimumKey));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const files = await Promise.all(objects.map(async ({ key }) => {
    const body = await bucket.get(key);
    if (!body) throw new Error(`R2 object disappeared while reading: ${key}`);
    return parseR2Jsonl(await body.text(), key);
  }));

  const rowsByTimestamp = new Map();
  for (const row of files.flat()) {
    if (row[0] > after) rowsByTimestamp.set(row[0], row);
  }

  return [...rowsByTimestamp.values()].sort((left, right) => right[0] - left[0]);
}

function dailyKeyForTimestamp(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid R2 cutoff timestamp.");
  return `${R2_JSONL_PREFIX}${date.toISOString().slice(0, 10)}.jsonl`;
}

function parseR2Jsonl(text, key) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  return trimmed.split(/\r?\n/).map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid R2 JSONL in ${key} at line ${index + 1}: malformed JSON.`);
    }

    if (!isStatsRow(row)) {
      throw new Error(`Invalid R2 JSONL in ${key} at line ${index + 1}: expected [epochSeconds, usercount].`);
    }
    return row;
  });
}

function isStatsRow(row) {
  return Array.isArray(row)
    && row.length === 2
    && Number.isInteger(row[0])
    && row[0] >= 0
    && Number.isInteger(row[1])
    && row[1] >= 0;
}

function parseAfter(value) {
  if (!/^\d+$/.test(value)) return INVALID_AFTER;

  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return INVALID_AFTER;

  return number;
}

function normalizeCacheUrl(url, after) {
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set("after", String(after));
  return cacheUrl;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? CLIENT_CACHE_CONTROL : "no-store",
    },
  });
}

export const testApi = {
  R2_JSONL_PREFIX,
  CLIENT_CACHE_CONTROL,
  parseAfter,
  normalizeCacheUrl,
  fetchR2Rows,
  dailyKeyForTimestamp,
  parseR2Jsonl,
};
