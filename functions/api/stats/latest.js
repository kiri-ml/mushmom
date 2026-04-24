const LATEST_STATS_RANGE_BYTES = 256 * 1024;

export async function onRequestGet(context) {
  const url = context.env.GOOGLE_API_URL;
  const cacheTtl = getCacheTtl(context.env.GOOGLE_API_CACHE_TTL);

  if (!url) {
    return json(
      {
        error: "GOOGLE_API_URL is not configured.",
        data: [],
      },
      503,
    );
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        accept: "application/json",
        range: `bytes=0-${LATEST_STATS_RANGE_BYTES - 1}`,
      },
      cf: {
        cacheTtl,
        cacheEverything: true,
      },
    });

    if (!upstream.ok) {
      return json(
        {
          error: `Google API returned ${upstream.status}.`,
          data: [],
        },
        502,
      );
    }

    const text = await upstream.text();
    const rows = parseCompletePrefixRows(text);

    if (rows.length === 0) {
      return json(
        {
          error: "Google API range response contained no complete rows.",
          data: [],
        },
        502,
      );
    }

    const latestDate = truncateDateToSecond(parseTimestamp(rows[0]?.timestamp));

    if (!latestDate) {
      return json(
        {
          error: "Latest Google API row did not include a valid timestamp.",
          data: [],
        },
        502,
      );
    }

    const cutoffMs = latestWindowStart(latestDate);
    const data = [];
    let reachedOlderRow = false;

    for (const row of rows) {
      const date = truncateDateToSecond(parseTimestamp(row.timestamp));
      const count = Number(row.usercount);

      if (!date || !Number.isFinite(count)) continue;
      if (date.getTime() < cutoffMs) {
        reachedOlderRow = true;
        break;
      }

      data.push([Math.floor(date.getTime() / 1000), count]);
    }

    return json(
      {
        source: "Google API",
        sourceUrl: url,
        fetchedAt: new Date().toISOString(),
        rangeBytes: LATEST_STATS_RANGE_BYTES,
        windowStart: new Date(cutoffMs).toISOString(),
        completeWindow: reachedOlderRow,
        data,
      },
      200,
      cacheTtl,
    );
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

function getCacheTtl(value) {
  const seconds = Number(value || 3600);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
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

function truncateDateToSecond(date) {
  return date ? new Date(Math.floor(date.getTime() / 1000) * 1000) : null;
}

function latestWindowStart(latestDate) {
  const monthOffset = latestDate.getUTCDate() === 1 ? -1 : 0;

  return Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth() + monthOffset, 1);
}

function json(body, status = 200, maxAge = 3600) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}
