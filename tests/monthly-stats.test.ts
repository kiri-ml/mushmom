import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

type R2BucketStub = {
  list: (options: { prefix: string; cursor?: string }) => Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
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
    async list() {
      return {
        objects: Object.keys(objects).map((key) => ({ key })),
        truncated: false,
      };
    },
    async get(key) {
      const value = objects[key];
      return value === undefined ? null : { async text() { return value; } };
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

  it("concatenates date-ordered daily JSONL without sorting or deduplicating rows", async () => {
    const mod = await loadMonthlyModule();
    const cache = stubCache();
    const list = vi.fn(async () => ({
      objects: [
        { key: "stats/jsonl/2026-07-01.jsonl" },
        { key: "stats/jsonl/2026-07-02.jsonl" },
        { key: "stats/jsonl/2026-07-notes.txt" },
      ],
      truncated: false,
    }));
    const values: Record<string, string> = {
      "stats/jsonl/2026-07-01.jsonl": "[1782864000,1200]\n[1782864300,1250]\n",
      "stats/jsonl/2026-07-02.jsonl": "[1782864300,1250]\n[1782950700,1300]\n",
    };
    const bucket: R2BucketStub = {
      list,
      async get(key) { return { async text() { return values[key]; } }; },
    };

    const response = await mod.onRequestGet(makeContext("2026-07", bucket));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      [1782864000, 1200],
      [1782864300, 1250],
      [1782864300, 1250],
      [1782950700, 1300],
    ]);
    expect(list).toHaveBeenCalledWith({ prefix: "stats/jsonl/2026-07-" });
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("preserves listing order across R2 pagination", async () => {
    const mod = await loadMonthlyModule();
    stubCache();
    const list = vi.fn(async (options: { prefix: string; cursor?: string }) => options.cursor
      ? { objects: [{ key: "stats/jsonl/2026-07-02.jsonl" }], truncated: false }
      : { objects: [{ key: "stats/jsonl/2026-07-01.jsonl" }], truncated: true, cursor: "page-2" });
    const values: Record<string, string> = {
      "stats/jsonl/2026-07-01.jsonl": "[1782864000,1200]\n",
      "stats/jsonl/2026-07-02.jsonl": "[1782950400,1300]\n",
    };
    const bucket: R2BucketStub = {
      list,
      async get(key) { return { async text() { return values[key]; } }; },
    };

    const response = await mod.onRequestGet(makeContext("2026-07", bucket));

    await expect(response.json()).resolves.toEqual([
      [1782864000, 1200],
      [1782950400, 1300],
    ]);
    expect(list).toHaveBeenNthCalledWith(1, { prefix: "stats/jsonl/2026-07-" });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "stats/jsonl/2026-07-", cursor: "page-2" });
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
    const list = vi.spyOn(bucket, "list");

    const response = await mod.onRequestGet(makeContext(
      "2026-07",
      bucket,
      "https://mushmom.test/api/stats/2026-07?ignored=1",
    ));

    expect(await response.json()).toEqual([[1, 2]]);
    expect((cache.match.mock.calls[0]?.[0] as Request).url).toBe("https://mushmom.test/api/stats/2026-07");
    expect(list).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("returns an uncached 502 when a listed object disappears", async () => {
    const mod = await loadMonthlyModule();
    stubCache();
    const bucket: R2BucketStub = {
      async list() {
        return { objects: [{ key: "stats/jsonl/2026-07-01.jsonl" }], truncated: false };
      },
      async get() { return null; },
    };

    const response = await mod.onRequestGet(makeContext("2026-07", bucket));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "R2 object disappeared while reading: stats/jsonl/2026-07-01.jsonl",
      data: [],
    });
  });

  it("returns uncached errors for malformed JSONL and a missing binding", async () => {
    const mod = await loadMonthlyModule();
    stubCache();

    const malformed = await mod.onRequestGet(makeContext(
      "2026-07",
      makeR2Bucket({ "stats/jsonl/2026-07-01.jsonl": "not-json\n" }),
    ));
    const unconfigured = await mod.onRequestGet(makeContext("2026-07", null));

    expect(malformed.status).toBe(502);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    await expect(malformed.json()).resolves.toEqual({
      error: "Invalid R2 JSONL in stats/jsonl/2026-07-01.jsonl at line 1: malformed JSON.",
      data: [],
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("cache-control")).toBe("no-store");
    await expect(unconfigured.json()).resolves.toEqual({
      error: "STATS_BUCKET is not configured.",
      data: [],
    });
  });
});
