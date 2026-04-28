const DEFAULT_LATEST_STATS_RANGE_BYTES = 256 * 1024;
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
const ESTIMATED_BYTES_PER_SAMPLE = 64;
const RANGE_SAFETY_BYTES = 4096;
const RANGE_SAFETY_SAMPLES = 8;
const MAX_RANGE_BYTES = 1024 * 1024;
const CLIENT_CACHE_CONTROL =
  "public, max-age=300, s-maxage=1800, stale-while-revalidate=600, stale-if-error=3600";
const UPSTREAM_DATA_CACHE_TTL_SECONDS = 0;
const INVALID_AFTER = Symbol("invalid_after");

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const upstreamUrl = context.env.GOOGLE_API_URL;
  const after = parseAfter(requestUrl.searchParams.get("after"));

  if (after === INVALID_AFTER) {
    return json({ error: "invalid_after" }, 400);
  }

  if (!upstreamUrl) {
    return json(
      {
        error: "GOOGLE_API_URL is not configured.",
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
    const latest = after == null
      ? await fetchLatestWindow(upstreamUrl)
      : await fetchRowsAfter(upstreamUrl, after);

    if (latest.errorResponse) {
      return latest.errorResponse;
    }

    const response = json(latest.body);
    context.waitUntil(
      cache.put(cacheKey, response.clone()).catch(() => {
        // Ignore Cache API write failures so a successful upstream response still returns 200.
      }),
    );
    return response;
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch Google API data.",
        data: [],
      },
      502,
    );
  }
}

async function fetchLatestWindow(url) {
  const parsed = await fetchRangeRows(url, DEFAULT_LATEST_STATS_RANGE_BYTES);

  if (parsed.errorResponse) return parsed;

  const { rows } = parsed;
  const latestDate = truncateDateToSecond(parseTimestamp(rows[0]?.timestamp));

  if (!latestDate) {
    return {
      errorResponse: json(
        {
          error: "Latest Google API row did not include a valid timestamp.",
          data: [],
        },
        502,
      ),
    };
  }

  const cutoffSec = Math.floor(latestWindowStart(latestDate) / 1000);
  const data = [];
  let reachedOlderRow = false;

  for (const row of rows) {
    const timestampSec = parseRowTimestampSec(row);
    const count = Number(row.usercount);

    if (!Number.isFinite(timestampSec) || !Number.isFinite(count)) continue;
    if (timestampSec < cutoffSec) {
      reachedOlderRow = true;
      break;
    }

    data.push([timestampSec, count]);
  }

  return {
    body: {
      source: "Google API",
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      rangeBytes: DEFAULT_LATEST_STATS_RANGE_BYTES,
      windowStart: new Date(cutoffSec * 1000).toISOString(),
      completeWindow: reachedOlderRow || !parsed.wasPartial,
      data,
    },
  };
}

async function fetchRowsAfter(url, after) {
  const initialRangeBytes = estimateRangeBytes(after);
  if (initialRangeBytes > MAX_RANGE_BYTES) {
    return { errorResponse: json({ error: "after_too_old" }, 413) };
  }

  let rangeBytes = initialRangeBytes;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = await fetchRangeRows(url, rangeBytes);
    if (parsed.errorResponse) return parsed;

    const selectedRows = [];
    let reachedBoundary = false;

    for (const row of parsed.rows) {
      const timestampSec = parseRowTimestampSec(row);
      const count = Number(row.usercount);

      if (!Number.isFinite(timestampSec) || !Number.isFinite(count)) continue;
      if (timestampSec <= after) {
        reachedBoundary = true;
        break;
      }

      selectedRows.push([timestampSec, count]);
    }

    if (reachedBoundary || !parsed.wasPartial) {
      return {
        body: {
          source: "Google API",
          sourceUrl: url,
          fetchedAt: new Date().toISOString(),
          rangeBytes,
          after,
          completeWindow: reachedBoundary || !parsed.wasPartial,
          data: selectedRows,
        },
      };
    }

    if (rangeBytes >= MAX_RANGE_BYTES) {
      break;
    }

    rangeBytes = Math.min(rangeBytes * 2, MAX_RANGE_BYTES);
  }

  return { errorResponse: json({ error: "after_too_old" }, 413) };
}

async function fetchRangeRows(url, rangeBytes) {
  const upstream = await fetch(url, {
    headers: {
      accept: "application/json",
      range: `bytes=0-${rangeBytes - 1}`,
    },
    cf: {
      cacheTtl: UPSTREAM_DATA_CACHE_TTL_SECONDS,
    },
  });

  if (!upstream.ok) {
    return {
      errorResponse: json(
        {
          error: `Google API returned ${upstream.status}.`,
          data: [],
        },
        502,
      ),
    };
  }

  const text = await upstream.text();
  const rows = parseCompletePrefixRows(text);

  if (rows.length === 0) {
    return {
      errorResponse: json(
        {
          error: "Google API range response contained no complete rows.",
          data: [],
        },
        502,
      ),
    };
  }

  return {
    rows,
    wasPartial: text.trimEnd().slice(-1) !== "]",
  };
}

function parseAfter(value) {
  if (value == null) return null;
  if (!/^\d+$/.test(value)) return INVALID_AFTER;

  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return INVALID_AFTER;

  return number;
}

function estimateRangeBytes(after) {
  const estimatedSampleCount =
    Math.ceil(Math.max(0, Math.floor(Date.now() / 1000) - after) / (SAMPLE_INTERVAL_MS / 1000)) + RANGE_SAFETY_SAMPLES;

  return 1 + estimatedSampleCount * ESTIMATED_BYTES_PER_SAMPLE + RANGE_SAFETY_BYTES;
}

function normalizeCacheUrl(url, after) {
  const cacheUrl = new URL(url.origin + url.pathname);
  if (after != null) cacheUrl.searchParams.set("after", String(after));
  return cacheUrl;
}

function parseCompletePrefixRows(text) {
  const lastBraceIndex = text.lastIndexOf("}");
  if (lastBraceIndex === -1) return [];

  const prefix = `${text.slice(0, lastBraceIndex + 1)}]`;
  const parsed = JSON.parse(prefix);

  return Array.isArray(parsed) ? parsed : [];
}

function parseTimestamp(value) {
  if (!value) return null;

  const normalized = String(value)
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRowTimestampSec(row) {
  const date = parseTimestamp(row?.timestamp);
  return date ? Math.floor(date.getTime() / 1000) : Number.NaN;
}

function truncateDateToSecond(date) {
  return date ? new Date(Math.floor(date.getTime() / 1000) * 1000) : null;
}

function latestWindowStart(latestDate) {
  const monthOffset = latestDate.getUTCDate() === 1 ? -1 : 0;

  return Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth() + monthOffset, 1);
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
  DEFAULT_LATEST_STATS_RANGE_BYTES,
  SAMPLE_INTERVAL_MS,
  ESTIMATED_BYTES_PER_SAMPLE,
  RANGE_SAFETY_BYTES,
  RANGE_SAFETY_SAMPLES,
  MAX_RANGE_BYTES,
  CLIENT_CACHE_CONTROL,
  UPSTREAM_DATA_CACHE_TTL_SECONDS,
  parseAfter,
  estimateRangeBytes,
  parseCompletePrefixRows,
  parseTimestamp,
  truncateDateToSecond,
  latestWindowStart,
  parseRowTimestampSec,
  normalizeCacheUrl,
  fetchRowsAfter,
};
