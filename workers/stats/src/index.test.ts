import { describe, expect, it, vi } from "vitest";
import {
  appendRowJson,
  appendStats,
  default as worker,
  isStatsRow,
  monthlyKey,
  type Env,
  type StatsRow,
} from "./index";

class FakeBucket {
  readonly objects = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; contentType?: string }> = [];
  readonly gets: string[] = [];

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    this.gets.push(key);
    const value = this.objects.get(key);
    return value === undefined ? null : { async text() { return value; } };
  }

  async put(key: string, value: string, options?: { httpMetadata?: { contentType: string } }): Promise<void> {
    this.puts.push({ key, value, contentType: options?.httpMetadata?.contentType });
    this.objects.set(key, value);
  }
}

function createEnv(bucket = new FakeBucket()): Env {
  return {
    STATS_BUCKET: bucket,
    CURRENT_USERS_URL: "https://example.test/current",
  };
}

function responseWith(payload: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function errorResponse(status = 502): Response {
  return new Response(JSON.stringify({ error: "upstream failed" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function responsesWith(...payloads: unknown[]): typeof fetch {
  const responses = payloads.map((payload) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call.");
    return response;
  });
}

describe("stats rows", () => {
  it("generates JSON keys for every UTC month", () => {
    expect(monthlyKey(1_783_036_800)).toBe("stats/json/2026-07.json");
    expect(monthlyKey(Date.parse("2026-06-30T23:55:00.000Z") / 1000))
      .toBe("stats/json/2026-06.json");
    expect(monthlyKey(1_785_542_400)).toBe("stats/json/2026-08.json");
  });

  it("creates and appends compact row-based JSON without parsing", () => {
    const first = appendRowJson("", [1_785_542_400, 12, 7]);
    expect(first).toBe("[[1785542400,12,7]]");
    expect(appendRowJson(first, [1_785_542_460, null, 8])).toBe(
      "[[1785542400,12,7],[1785542460,null,8]]",
    );
    expect(JSON.parse(appendRowJson(first, [1_785_542_460, 14]))).toEqual([
      [1_785_542_400, 12, 7],
      [1_785_542_460, 14],
    ]);
    expect(() => appendRowJson("not-json", [1_785_542_400, 1]))
      .toThrow("closing bracket");
  });

  it("validates tuple rows, including zero user counts", () => {
    expect(isStatsRow([300, 0])).toBe(true);
    expect(isStatsRow([300, 12])).toBe(true);
    expect(isStatsRow([300, 12, 6])).toBe(true);
    expect(isStatsRow([300, null, 6])).toBe(true);
    expect(isStatsRow([300, null, 0])).toBe(false);
    expect(isStatsRow([300, null])).toBe(false);
    expect(isStatsRow([300, 12, -1])).toBe(false);
    expect(isStatsRow([300, 12, 1.5])).toBe(false);
    expect(isStatsRow([300, -1])).toBe(false);
    expect(isStatsRow([300, 1.5])).toBe(false);
    expect(isStatsRow([300, "12"])).toBe(false);
    expect(isStatsRow([300])).toBe(false);
  });
});

describe("scheduled stats append", () => {
  it("returns immediately and records the actual observation time when both counts are positive", async () => {
    const bucket = new FakeBucket();
    const fetcher = responseWith({ usercount: 12, uniquecount: 7 });

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([1_783_036_860, 12, 7]);
  });

  it("rejects repeated invalid upstream usercounts without writing", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: "1234" },
      { usercount: Number.POSITIVE_INFINITY },
      { usercount: -1 },
    );

    await expect(appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    })).rejects.toThrow("finite non-negative integer");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.puts).toEqual([]);
  });

  it("rejects repeated invalid upstream unique counts without writing", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: 1234 },
      { usercount: 1234, uniquecount: -1 },
      { usercount: 1234, uniquecount: 1.5 },
    );

    await expect(appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    })).rejects.toThrow("uniquecount must be a finite non-negative integer");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.puts).toEqual([]);
  });

  it("appends to an existing monthly object without sorting it", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/json/2026-07.json", "[[1783037100,12],[1783036500,8]]");
    const fetcher = responsesWith(
      { usercount: 0, uniquecount: 0 },
      { usercount: 0, uniquecount: 0 },
      { usercount: 0, uniquecount: 0 },
    );

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(bucket.objects.get("stats/json/2026-07.json")).toBe(
      "[[1783037100,12],[1783036500,8],[1783036860,0,0]]",
    );
    expect(bucket.gets).toEqual(["stats/json/2026-07.json"]);
    expect(result).toEqual({
      fetchedAt: "2026-07-03T00:01:00.000Z",
      timestamp: 1_783_036_860,
      data: [1_783_036_860, 0, 0],
    });
    expect(bucket.puts).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("writes the common-case response after an initial zero pair", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith({ usercount: 0, uniquecount: 0 }, { usercount: 12, uniquecount: 7 });

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,12,7]]");
    expect(result.data).toEqual([1_783_036_860, 12, 7]);
  });

  it("retries a zero unique count and writes a later common-case response", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: 1617, uniquecount: 0 },
      { usercount: 1600, uniquecount: 818 },
    );

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual([1_783_036_860, 1600, 818]);
  });

  it("retries a zero user count even when the unique count is positive", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: 0, uniquecount: 7 },
      { usercount: 12, uniquecount: 7 },
    );

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual([1_783_036_860, 12, 7]);
  });

  it("writes the latest character-only response as a two-value tuple", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: 1617, uniquecount: 0 },
      { usercount: 0, uniquecount: 818 },
      { usercount: 1597, uniquecount: 0 },
    );

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,1597]]");
    expect(result.data).toEqual([1_783_036_860, 1597]);
  });

  it("prefers a character-only response over a later zero pair", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: 0, uniquecount: 818 },
      { usercount: 5, uniquecount: 0 },
      { usercount: 0, uniquecount: 0 },
    );

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,5]]");
    expect(result.data).toEqual([1_783_036_860, 5]);
  });

  it("writes the latest character-only response when later attempts fail", async () => {
    const bucket = new FakeBucket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ usercount: 0, uniquecount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ usercount: 5, uniquecount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockRejectedValueOnce(new Error("retry unavailable"));

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,5]]");
    expect(result.data).toEqual([1_783_036_860, 5]);
  });

  it("keeps the latest valid response when no character-only response exists", async () => {
    const bucket = new FakeBucket();
    const fetcher = responsesWith(
      { usercount: 0, uniquecount: 8 },
      { usercount: 0, uniquecount: 0 },
      { usercount: 0, uniquecount: 7 },
    );

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,null,7]]");
    expect(result.data).toEqual([1_783_036_860, null, 7]);
  });

  it("writes the retried value when the initial fetch fails", async () => {
    const bucket = new FakeBucket();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("temporary upstream failure"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ usercount: 12, uniquecount: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,12,7]]");
    expect(result.data).toEqual([1_783_036_860, 12, 7]);
  });

  it("writes zero when failures surround a valid zero response", async () => {
    const bucket = new FakeBucket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(new Response(JSON.stringify({ usercount: 0, uniquecount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockRejectedValueOnce(new Error("temporary upstream failure"));

    const result = await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,0,0]]");
    expect(result.data).toEqual([1_783_036_860, 0, 0]);
  });

  it("rejects three fetch failures without writing", async () => {
    const bucket = new FakeBucket();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("temporary upstream failure"))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(504));

    await expect(appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher,
      retryDelayMs: 0,
    })).rejects.toThrow("Current-users API returned HTTP 504");

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bucket.gets).toEqual([]);
    expect(bucket.puts).toEqual([]);
  });

  it("creates a monthly object from the latest observation when none exists", async () => {
    const bucket = new FakeBucket();

    await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 5, uniquecount: 3 }),
      retryDelayMs: 0,
    });

    expect(bucket.gets).toEqual(["stats/json/2026-07.json"]);
    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,5,3]]");
  });

  it("creates row-based JSON in a later month", async () => {
    const bucket = new FakeBucket();

    await appendStats(createEnv(bucket), {
      now: new Date("2026-08-01T00:00:00.000Z"),
      fetcher: responseWith({ usercount: 5, uniquecount: 3 }),
      retryDelayMs: 0,
    });

    expect(bucket.gets).toEqual(["stats/json/2026-08.json"]);
    expect(bucket.objects.get("stats/json/2026-08.json")).toBe("[[1785542400,5,3]]");
    expect(bucket.puts[0]?.contentType).toBe("application/json; charset=utf-8");
  });

  it("appends row-based JSON by replacing only its final bracket", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/json/2026-08.json", "[[1785542400,5,3]]");

    await appendStats(createEnv(bucket), {
      now: new Date("2026-08-01T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 7, uniquecount: 4 }),
      retryDelayMs: 0,
    });

    const stored = bucket.objects.get("stats/json/2026-08.json");
    expect(stored).toBe("[[1785542400,5,3],[1785542460,7,4]]");
    expect(JSON.parse(stored ?? "")).toEqual([
      [1785542400, 5, 3],
      [1785542460, 7, 4],
    ]);
  });

  it("rejects monthly objects without a final closing bracket", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/json/2026-08.json", "[[1785542400,5,3");

    await expect(appendStats(createEnv(bucket), {
      now: new Date("2026-08-01T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 7, uniquecount: 4 }),
      retryDelayMs: 0,
    })).rejects.toThrow("closing bracket");
    expect(bucket.puts).toEqual([]);
  });

  it("appends the first row directly to an empty monthly object", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/json/2026-07.json", "");

    await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 5, uniquecount: 3 }),
      retryDelayMs: 0,
    });

    expect(bucket.objects.get("stats/json/2026-07.json")).toBe("[[1783036860,5,3]]");
  });

  it("appends duplicate timestamps instead of replacing them", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/json/2026-07.json", "[[1783036860,5,3]]");

    await appendStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 12, uniquecount: 7 }),
      retryDelayMs: 0,
    });

    expect(bucket.objects.get("stats/json/2026-07.json"))
      .toBe("[[1783036860,5,3],[1783036860,12,7]]");
  });
});

describe("scheduled error logging", () => {
  it("logs the underlying error message and stack", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(worker.scheduled(undefined, {
      ...createEnv(new FakeBucket()),
      CURRENT_USERS_URL: "",
    })).rejects.toThrow("CURRENT_USERS_URL is not configured");

    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]?.[0]).toContain(
      "Scheduled stats append failed: CURRENT_USERS_URL is not configured.",
    );
    expect(errorLog.mock.calls[0]?.[0]).toContain("at appendStats");
    errorLog.mockRestore();
  });
});

describe("worker HTTP handler", () => {
  it("does not expose manual update endpoints", async () => {
    const bucket = new FakeBucket();
    const response = await worker.fetch();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(bucket.puts).toEqual([]);
  });
});
