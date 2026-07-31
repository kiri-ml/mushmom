export type StatsRow = [epochSeconds: number, usercount: number]
  | [epochSeconds: number, usercount: number, uniquecount: number]
  | [epochSeconds: number, usercount: null, uniquecount: number];

const POLL_RETRY_DELAY_MS = 1_000;
const MAX_POLL_ATTEMPTS = 3;

type R2ObjectBodyLike = {
  text(): Promise<string>;
};

type R2BucketLike = {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType: string } },
  ): Promise<unknown>;
};

export type Env = {
  STATS_BUCKET: R2BucketLike;
  CURRENT_USERS_URL: string;
};

type AppendOptions = {
  now?: Date;
  fetcher?: typeof fetch;
  retryDelayMs?: number;
};

type AppendResult = {
  fetchedAt: string;
  timestamp: number;
  data: StatsRow;
};

export function monthlyKey(epochSeconds: number): string {
  if (!Number.isInteger(epochSeconds) || epochSeconds < 0) {
    throw new Error("Timestamp must be a non-negative integer.");
  }

  const iso = new Date(epochSeconds * 1000).toISOString();
  const month = iso.slice(0, 7);
  return `stats/json/${month}.json`;
}

export function isStatsRow(value: unknown): value is StatsRow {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)
    || !isNonnegativeInteger(value[0])) return false;
  if (value[1] === null) {
    return value.length === 3 && isNonnegativeInteger(value[2]) && value[2] > 0;
  }
  return isNonnegativeInteger(value[1])
    && (value.length === 2 || isNonnegativeInteger(value[2]));
}

export function appendRowJson(existingText: string, row: StatsRow): string {
  if (!isStatsRow(row)) throw new Error("Cannot append an invalid stats row.");
  if (existingText === "") return `[${JSON.stringify(row)}]`;
  if (!existingText.endsWith("]")) {
    throw new Error("Existing row-based JSON must end with a closing bracket.");
  }
  return existingText.replace(/\]$/, `,${JSON.stringify(row)}]`);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

type UserCounts = { usercount: number; uniquecount: number };

function createStatsRow(timestamp: number, usercount: number, uniquecount?: number): StatsRow {
  if (uniquecount === undefined) return [timestamp, usercount];
  return usercount === 0 && uniquecount > 0
    ? [timestamp, null, uniquecount]
    : [timestamp, usercount, uniquecount];
}

function hasCommonCounts(counts: UserCounts): boolean {
  return counts.usercount > 0 && counts.uniquecount > 0;
}

function hasCharacterCountOnly(counts: UserCounts): boolean {
  return counts.usercount > 0 && counts.uniquecount === 0;
}

function validateUsercounts(payload: unknown): UserCounts {
  const usercount = payload && typeof payload === "object"
    ? (payload as { usercount?: unknown }).usercount
    : undefined;
  const uniquecount = payload && typeof payload === "object"
    ? (payload as { uniquecount?: unknown }).uniquecount
    : undefined;

  if (!isNonnegativeInteger(usercount)) {
    throw new Error("Upstream response usercount must be a finite non-negative integer.");
  }
  if (!isNonnegativeInteger(uniquecount)) {
    throw new Error("Upstream response uniquecount must be a finite non-negative integer.");
  }
  return { usercount, uniquecount };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentUsercounts(url: string, fetcher: typeof fetch): Promise<UserCounts> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown fetch error";
    throw new Error(`Failed to fetch current users: ${detail}`);
  }

  if (!response.ok) {
    throw new Error(`Current-users API returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error("Current-users API returned invalid JSON.");
  }

  return validateUsercounts(payload);
}

async function readCurrentUsercounts(url: string, fetcher: typeof fetch, retryDelayMs: number): Promise<UserCounts> {
  let latestCounts: UserCounts | undefined;
  let latestCharacterCountOnly: UserCounts | undefined;
  let latestError: unknown;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    try {
      const counts = await fetchCurrentUsercounts(url, fetcher);
      latestCounts = counts;
      if (hasCommonCounts(counts)) return counts;
      if (hasCharacterCountOnly(counts)) latestCharacterCountOnly = counts;
    } catch (error) {
      latestError = error;
    }

    if (attempt < MAX_POLL_ATTEMPTS - 1 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  if (latestCharacterCountOnly) return latestCharacterCountOnly;
  if (latestCounts) return latestCounts;
  if (latestError === undefined) {
    throw new Error("Failed to fetch current users.");
  }
  throw latestError;
}

export async function appendStats(env: Env, options: AppendOptions = {}): Promise<AppendResult> {
  if (!env.CURRENT_USERS_URL) {
    throw new Error("CURRENT_USERS_URL is not configured.");
  }

  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const timestamp = Math.floor(now.getTime() / 1000);
  const fetcher = options.fetcher ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? POLL_RETRY_DELAY_MS;

  const { usercount, uniquecount } = await readCurrentUsercounts(env.CURRENT_USERS_URL, fetcher, retryDelayMs);
  const data = hasCharacterCountOnly({ usercount, uniquecount })
    ? createStatsRow(timestamp, usercount)
    : createStatsRow(timestamp, usercount, uniquecount);

  const key = monthlyKey(timestamp);
  let existingText: string;
  try {
    const existing = await env.STATS_BUCKET.get(key);
    existingText = existing ? await existing.text() : "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown R2 error";
    throw new Error(`Failed to read ${key}: ${detail}`);
  }

  const updatedText = appendRowJson(existingText, data);
  const result: AppendResult = { fetchedAt, timestamp, data };

  try {
    await env.STATS_BUCKET.put(key, updatedText, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown R2 error";
    throw new Error(`Failed to write stats to R2: ${detail}`);
  }

  return result;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(): Promise<Response> {
    return json({ error: "Not found." }, 404);
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    try {
      await appendStats(env);
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error);
      console.error(`Scheduled stats append failed: ${detail}`);
      throw error;
    }
  },
};
