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
  SAMPLE_INTERVAL_SECONDS: number | string;
  ADMIN_TOKEN?: string;
};

type SyncOptions = {
  now?: Date;
  fetcher?: typeof fetch;
  retryDelayMs?: number;
};

type SyncResult = {
  fetchedAt: string;
  bucket: number;
  data: StatsRow;
};

type UpdatePointResult = {
  bucket: number;
  key: string;
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

export function monthlyKey(bucket: number): string {
  if (!Number.isInteger(bucket) || bucket < 0) {
    throw new Error("Bucket timestamp must be a non-negative integer.");
  }

  const iso = new Date(bucket * 1000).toISOString();
  return `stats/jsonl/${iso.slice(0, 7)}.jsonl`;
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
      throw new Error(`Invalid stats JSONL at line ${index + 1}: expected a compact stats tuple, with null usercount allowed only when uniquecount is positive.`);
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
    throw new SyncError("Upstream response usercount must be a finite non-negative integer.", 502);
  }
  if (!isNonnegativeInteger(uniquecount)) {
    throw new SyncError("Upstream response uniquecount must be a finite non-negative integer.", 502);
  }
  return { usercount, uniquecount };
}

function validateUpdatePointPayload(payload: unknown): { timestamp: number; usercount: number; uniquecount?: number } {
  const timestamp = payload && typeof payload === "object"
    ? (payload as { timestamp?: unknown }).timestamp
    : undefined;
  const usercount = payload && typeof payload === "object"
    ? (payload as { usercount?: unknown }).usercount
    : undefined;
  const uniquecount = payload && typeof payload === "object"
    ? (payload as { uniquecount?: unknown }).uniquecount
    : undefined;

  if (!isNonnegativeInteger(timestamp)) {
    throw new SyncError("Request timestamp must be a finite non-negative integer UTC epoch second.", 400);
  }
  if (!isNonnegativeInteger(usercount)) {
    throw new SyncError("Request usercount must be a finite non-negative integer.", 400);
  }
  if (uniquecount !== undefined && !isNonnegativeInteger(uniquecount)) {
    throw new SyncError("Request uniquecount must be a finite non-negative integer when provided.", 400);
  }

  return { timestamp, usercount, uniquecount };
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
    throw new SyncError("Failed to fetch current users.", 502);
  }
  throw latestError;
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
  const retryDelayMs = options.retryDelayMs ?? POLL_RETRY_DELAY_MS;

  const { usercount, uniquecount } = await readCurrentUsercounts(env.CURRENT_USERS_URL, fetcher, retryDelayMs);
  const data = hasCharacterCountOnly({ usercount, uniquecount })
    ? createStatsRow(bucket, usercount)
    : createStatsRow(bucket, usercount, uniquecount);

  const key = monthlyKey(bucket);
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

export async function updateStatsPoint(env: Env, timestamp: number, usercount: number, uniquecount?: number): Promise<UpdatePointResult> {
  const interval = readInterval(env);
  const bucket = bucketTimestamp(timestamp, interval);
  const data = createStatsRow(bucket, usercount, uniquecount);
  if (!isStatsRow(data)) throw new SyncError("Request counts must be finite non-negative integers.", 400);

  const key = monthlyKey(bucket);
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
  try {
    await env.STATS_BUCKET.put(key, serializeJsonl(updatedRows), {
      httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown R2 error";
    throw new SyncError(`Failed to write stats to R2: ${detail}`, 500);
  }

  return { bucket, key, data };
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

async function readJsonRequest(request: Request): Promise<unknown> {
  try {
    return await request.json() as unknown;
  } catch {
    throw new SyncError("Request body must be valid JSON.", 400);
  }
}

function requireAdmin(env: Env, request: Request): Response | null {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured." }, 500);
  }
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "Unauthorized." }, 401, { "www-authenticate": "Bearer" });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/admin/sync" && url.pathname !== "/admin/point") return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "POST" });

    const authError = requireAdmin(env, request);
    if (authError) return authError;

    try {
      if (url.pathname === "/admin/point") {
        const payload = validateUpdatePointPayload(await readJsonRequest(request));
        return json(await updateStatsPoint(env, payload.timestamp, payload.usercount, payload.uniquecount));
      }
      return json(await syncStats(env));
    } catch (error) {
      if (error instanceof SyncError) return json({ error: error.message }, error.status);
      return json({ error: error instanceof Error ? error.message : "Stats sync failed." }, 500);
    }
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    try {
      await syncStats(env);
    } catch (error) {
      console.error("Scheduled stats sync failed.", error);
      throw error;
    }
  },
};
