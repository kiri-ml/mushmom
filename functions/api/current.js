const CURRENT_USERS_URL = "https://legends.ml/api/get_online_users";
const CURRENT_USERS_CACHE_CONTROL = "public, max-age=15";

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
    const usercount = payload?.usercount;
    const uniquecount = payload?.uniquecount;

    if (!isNonnegativeInteger(usercount) || !isNonnegativeInteger(uniquecount)) {
      return json(
        {
          error: "MapleLegends API response did not include valid usercount and uniquecount values.",
        },
        502,
      );
    }

    return json({
      source: "MapleLegends API",
      fetchedAt: new Date().toISOString(),
      usercount,
      uniquecount,
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

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
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
