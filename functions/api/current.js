const CURRENT_USERS_URL = "https://legends.ml/api/get_online_users";
const CURRENT_USERS_CACHE_CONTROL =
  "public, max-age=15, s-maxage=60, stale-while-revalidate=30, stale-if-error=300";

export async function onRequestGet() {
  try {
    const upstream = await fetch(CURRENT_USERS_URL, {
      headers: {
        accept: "application/json",
      },
    });

    if (!upstream.ok) {
      return json(
        {
          error: `MapleLegends API returned ${upstream.status}.`,
        },
        502,
      );
    }

    const payload = await upstream.json();
    const usercount = Number(payload?.usercount);

    if (!Number.isFinite(usercount)) {
      return json(
        {
          error: "MapleLegends API response did not include usercount.",
        },
        502,
      );
    }

    return json({
      source: "MapleLegends API",
      fetchedAt: new Date().toISOString(),
      usercount,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch MapleLegends online users.",
      },
      502,
    );
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? CURRENT_USERS_CACHE_CONTROL : "no-store",
    },
  });
}
