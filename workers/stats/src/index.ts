export type StatsRow = [epochSeconds: number, usercount: number];

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
  SAMPLE_INTERVAL_SECONDS: number | string;
  ADMIN_TOKEN?: string;
};

type SyncOptions = {
  now?: Date;
  fetcher?: typeof fetch;
};

type SyncResult = {
  fetchedAt: string;
  bucket: number;
  data: StatsRow;
};

class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function bucketTimestamp(epochSeconds: number, intervalSeconds: number): number {
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) {
    throw new Error("Timestamp must be a finite non-negative number.");
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("Sample interval must be a positive integer.");
  }

  return Math.floor(epochSeconds / intervalSeconds) * intervalSeconds;
}

export function dailyKey(bucket: number): string {
  if (!Number.isInteger(bucket) || bucket < 0) {
    throw new Error("Bucket timestamp must be a non-negative integer.");
  }

  const iso = new Date(bucket * 1000).toISOString();
  return `stats/jsonl/${iso.slice(0, 10)}.jsonl`;
}

export function isStatsRow(value: unknown): value is StatsRow {
  return Array.isArray(value)
    && value.length === 2
    && Number.isFinite(value[0])
    && Number.isInteger(value[0])
    && value[0] >= 0
    && Number.isFinite(value[1])
    && Number.isInteger(value[1])
    && value[1] >= 0;
}

export function parseJsonl(text: string): StatsRow[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  return trimmed.split(/\r?\n/).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid stats JSONL at line ${index + 1}: malformed JSON.`);
    }

    if (!isStatsRow(value)) {
      throw new Error(`Invalid stats JSONL at line ${index + 1}: expected [epochSeconds, usercount].`);
    }
    return value;
  });
}

export function serializeJsonl(rows: StatsRow[]): string {
  for (const row of rows) {
    if (!isStatsRow(row)) {
      throw new Error("Cannot serialize an invalid stats row.");
    }
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

export function upsertRow(rows: StatsRow[], next: StatsRow): StatsRow[] {
  if (!isStatsRow(next)) throw new Error("Cannot upsert an invalid stats row.");

  const byTimestamp = new Map<number, StatsRow>();
  for (const row of rows) {
    if (!isStatsRow(row)) throw new Error("Cannot upsert into invalid stats rows.");
    byTimestamp.set(row[0], row);
  }
  byTimestamp.set(next[0], next);

  return [...byTimestamp.values()].sort((left, right) => left[0] - right[0]);
}

function readInterval(env: Env): number {
  const interval = Number(env.SAMPLE_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new SyncError("SAMPLE_INTERVAL_SECONDS must be a positive integer.", 500);
  }
  return interval;
}

function validateUsercount(payload: unknown): number {
  const usercount = payload && typeof payload === "object"
    ? (payload as { usercount?: unknown }).usercount
    : undefined;

  if (typeof usercount !== "number"
    || !Number.isFinite(usercount)
    || !Number.isInteger(usercount)
    || usercount < 0) {
    throw new SyncError("Upstream response usercount must be a finite non-negative integer.", 502);
  }
  return usercount;
}

export async function syncStats(env: Env, options: SyncOptions = {}): Promise<SyncResult> {
  if (!env.CURRENT_USERS_URL) {
    throw new SyncError("CURRENT_USERS_URL is not configured.", 500);
  }

  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const interval = readInterval(env);
  const bucket = bucketTimestamp(Math.floor(now.getTime() / 1000), interval);
  const fetcher = options.fetcher ?? fetch;

  let response: Response;
  try {
    response = await fetcher(env.CURRENT_USERS_URL, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown fetch error";
    throw new SyncError(`Failed to fetch current users: ${detail}`, 502);
  }

  if (!response.ok) {
    throw new SyncError(`Current-users API returned HTTP ${response.status}.`, 502);
  }

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new SyncError("Current-users API returned invalid JSON.", 502);
  }
  const data: StatsRow = [bucket, validateUsercount(payload)];

  const key = dailyKey(bucket);
  let existing: R2ObjectBodyLike | null;
  try {
    existing = await env.STATS_BUCKET.get(key);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown R2 error";
    throw new SyncError(`Failed to read ${key}: ${detail}`, 500);
  }

  let rows: StatsRow[];
  try {
    rows = parseJsonl(existing ? await existing.text() : "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSONL";
    throw new SyncError(`Failed to parse existing ${key}: ${detail}`, 500);
  }

  const updatedRows = upsertRow(rows, data);
  const result: SyncResult = { fetchedAt, bucket, data };

  try {
    await env.STATS_BUCKET.put(key, serializeJsonl(updatedRows), {
      httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown R2 error";
    throw new SyncError(`Failed to write stats to R2: ${detail}`, 500);
  }

  return result;
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/admin/sync") return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });

    if (!env.ADMIN_TOKEN) {
      return json({ error: "ADMIN_TOKEN is not configured." }, 500);
    }
    if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: "Unauthorized." }, 401, { "www-authenticate": "Bearer" });
    }

    try {
      return json(await syncStats(env));
    } catch (error) {
      if (error instanceof SyncError) return json({ error: error.message }, error.status);
      return json({ error: error instanceof Error ? error.message : "Stats sync failed." }, 500);
    }
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await syncStats(env);
  },
};
