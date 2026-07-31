import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

type R2BucketStub = {
  get: (key: string) => Promise<{
    body: ReadableStream<Uint8Array>;
  } | null>;
};

type MonthlyContext = {
  request: Request;
  params: { month: string };
  env: { STATS_BUCKET?: R2BucketStub };
  waitUntil: (promise: Promise<unknown>) => void;
};

type MonthlyModule = {
  onRequestGet: (context: MonthlyContext) => Promise<Response>;
  testApi: {
    OPEN_MONTH_CACHE_CONTROL: string;
    CLOSED_MONTH_CACHE_CONTROL: string;
    cacheControlForMonth: (month: string, now?: Date) => string;
  };
};

async function loadMonthlyModule(): Promise<MonthlyModule> {
  const file = path.join(repoRoot, "functions/api/stats/[month].ts");
  return import(pathToFileURL(file).href) as Promise<MonthlyModule>;
}

function makeR2Bucket(objects: Record<string, string> = {}): R2BucketStub {
  return {
    async get(key) {
      const value = objects[key];
      return value === undefined ? null : {
        body: new Response(value).body as ReadableStream<Uint8Array>,
      };
    },
  };
}

function makeContext(
  month: string,
  bucket: R2BucketStub | null = makeR2Bucket(),
  url = `https://mushmom.test/api/stats/${month}`,
): MonthlyContext {
  return {
    request: new Request(url),
    params: { month },
    env: bucket ? { STATS_BUCKET: bucket } : {},
    waitUntil() {},
  };
}

function stubCache(cached?: Response) {
  const match = vi.fn(async (_request: Request) => cached);
  const put = vi.fn(async (_request: Request, _response: Response) => undefined);
  vi.stubGlobal("caches", { default: { match, put } });
  return { match, put };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("monthly stats function", () => {
  it.each(["2026-7", "26-07", "2026-00", "2026-13", "latest.json"]) (
    "rejects non-canonical month %s",
    async (month) => {
      const mod = await loadMonthlyModule();
      const cache = stubCache();

      const response = await mod.onRequestGet(makeContext(month));

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "invalid_month" });
      expect(cache.match).not.toHaveBeenCalled();
    },
  );

  it("streams the migrated July monthly JSON object directly", async () => {
    const mod = await loadMonthlyModule();
    const cache = stubCache();
    const bucket = makeR2Bucket({
      "stats/json/2026-07.json": "[[1782864000,1200],[1782864300,1250,625],[1782864600,null,630]]",
    });
    const get = vi.spyOn(bucket, "get");

    const response = await mod.onRequestGet(makeContext("2026-07", bucket));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      [1782864000, 1200],
      [1782864300, 1250, 625],
      [1782864600, null, 630],
    ]);
    expect(get).toHaveBeenCalledWith("stats/json/2026-07.json");
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("reads row-based JSON objects beginning with August 2026", async () => {
    const mod = await loadMonthlyModule();
    const cache = stubCache();
    const bucket = makeR2Bucket({
      "stats/json/2026-08.json": "[[1785542400,1200],[1785542460,1250,625]]",
    });
    const get = vi.spyOn(bucket, "get");

    const response = await mod.onRequestGet(makeContext("2026-08", bucket));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      [1785542400, 1200],
      [1785542460, 1250, 625],
    ]);
    expect(get).toHaveBeenCalledWith("stats/json/2026-08.json");
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("returns an empty successful response for a future month", async () => {
    const mod = await loadMonthlyModule();
    stubCache();

    const response = await mod.onRequestGet(makeContext("9999-12"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(mod.testApi.OPEN_MONTH_CACHE_CONTROL);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("uses immutable caching only for closed UTC months", async () => {
    const mod = await loadMonthlyModule();
    const now = new Date("2026-07-05T12:00:00.000Z");

    expect(mod.testApi.cacheControlForMonth("2026-06", now)).toBe(mod.testApi.CLOSED_MONTH_CACHE_CONTROL);
    expect(mod.testApi.cacheControlForMonth("2026-07", now)).toBe(mod.testApi.OPEN_MONTH_CACHE_CONTROL);
    expect(mod.testApi.cacheControlForMonth("2026-08", now)).toBe(mod.testApi.OPEN_MONTH_CACHE_CONTROL);
  });

  it("uses a query-free cache key and serves cache hits without reading R2", async () => {
    const mod = await loadMonthlyModule();
    const cached = new Response("[[1,2]]", { headers: { "content-type": "application/json" } });
    const cache = stubCache(cached);
    const bucket = makeR2Bucket();
    const get = vi.spyOn(bucket, "get");

    const response = await mod.onRequestGet(makeContext(
      "2026-07",
      bucket,
      "https://mushmom.test/api/stats/2026-07?ignored=1",
    ));

    expect(await response.json()).toEqual([[1, 2]]);
    expect((cache.match.mock.calls[0]?.[0] as Request).url).toBe("https://mushmom.test/api/stats/2026-07");
    expect(get).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it.each(["2026-07", "2026-08"])("returns an uncached 502 when R2 fails for %s", async (month) => {
    const mod = await loadMonthlyModule();
    stubCache();
    const bucket: R2BucketStub = {
      async get() { throw new Error("R2 unavailable"); },
    };

    const response = await mod.onRequestGet(makeContext(month, bucket));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "R2 unavailable",
      data: [],
    });
  });

  it("returns an uncached error for a missing binding", async () => {
    const mod = await loadMonthlyModule();
    stubCache();

    const unconfigured = await mod.onRequestGet(makeContext("2026-07", null));

    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("cache-control")).toBe("no-store");
    await expect(unconfigured.json()).resolves.toEqual({
      error: "STATS_BUCKET is not configured.",
      data: [],
    });
  });

  it("streams monthly R2 bytes without parsing or rewriting them", async () => {
    const mod = await loadMonthlyModule();
    stubCache();
    const contents = "{not validated or rewritten}\n";

    const response = await mod.onRequestGet(makeContext(
      "2026-08",
      makeR2Bucket({ "stats/json/2026-08.json": contents }),
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe(contents);
  });
});
