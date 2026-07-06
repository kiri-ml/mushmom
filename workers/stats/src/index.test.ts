import { describe, expect, it, vi } from "vitest";
import {
  bucketTimestamp,
  isStatsRow,
  monthlyKey,
  parseJsonl,
  serializeJsonl,
  syncStats,
  upsertRow,
  type Env,
  type StatsRow,
} from "./index";

class FakeBucket {
  readonly objects = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string }> = [];
  readonly gets: string[] = [];

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    this.gets.push(key);
    const value = this.objects.get(key);
    return value === undefined ? null : { async text() { return value; } };
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push({ key, value });
    this.objects.set(key, value);
  }
}

function createEnv(bucket = new FakeBucket()): Env {
  return {
    STATS_BUCKET: bucket,
    CURRENT_USERS_URL: "https://example.test/current",
    SAMPLE_INTERVAL_SECONDS: 300,
    ADMIN_TOKEN: "secret",
  };
}

function responseWith(payload: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

describe("stats rows", () => {
  it("buckets timestamps into five-minute intervals", () => {
    expect(bucketTimestamp(1_783_036_979, 300)).toBe(1_783_036_800);
  });

  it("generates UTC monthly keys from bucketed timestamps", () => {
    expect(monthlyKey(1_783_036_800)).toBe("stats/jsonl/2026-07.jsonl");
    expect(monthlyKey(Date.parse("2026-06-30T23:55:00.000Z") / 1000))
      .toBe("stats/jsonl/2026-06.jsonl");
  });

  it("parses and serializes compact JSONL tuples", () => {
    const rows: StatsRow[] = [[300, 0], [600, 1234]];
    expect(parseJsonl("[300,0]\n[600,1234]\n")).toEqual(rows);
    expect(serializeJsonl(rows)).toBe("[300,0]\n[600,1234]\n");
    expect(parseJsonl("  \n")).toEqual([]);
  });

  it("validates tuple rows, including zero user counts", () => {
    expect(isStatsRow([300, 0])).toBe(true);
    expect(isStatsRow([300, 12])).toBe(true);
    expect(isStatsRow([300, -1])).toBe(false);
    expect(isStatsRow([300, 1.5])).toBe(false);
    expect(isStatsRow([300, "12"])).toBe(false);
    expect(isStatsRow([300])).toBe(false);
  });

  it("upserts, deduplicates, and sorts rows oldest-first", () => {
    expect(upsertRow([[900, 9], [300, 3], [600, 6], [600, 7]], [600, 8])).toEqual([
      [300, 3],
      [600, 8],
      [900, 9],
    ]);
  });
});

describe("stats sync validation", () => {
  it.each([
    undefined,
    null,
    -1,
    1.5,
    "1234",
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid upstream usercount %p without writing", async (usercount) => {
    const bucket = new FakeBucket();
    await expect(syncStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount }),
    })).rejects.toThrow("finite non-negative integer");
    expect(bucket.puts).toEqual([]);
  });

  it("upserts an existing monthly object", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/jsonl/2026-07.jsonl", "[1783037100,12]\n[1783036500,8]\n");

    const result = await syncStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 0 }),
    });

    expect(bucket.objects.get("stats/jsonl/2026-07.jsonl")).toBe(
      "[1783036500,8]\n[1783036800,0]\n[1783037100,12]\n",
    );
    expect(bucket.gets).toEqual(["stats/jsonl/2026-07.jsonl"]);
    expect(result).toEqual({
      fetchedAt: "2026-07-03T00:01:00.000Z",
      bucket: 1_783_036_800,
      data: [1_783_036_800, 0],
    });
    expect(bucket.puts).toHaveLength(1);
  });

  it("creates a monthly object from the latest observation when none exists", async () => {
    const bucket = new FakeBucket();

    await syncStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 5 }),
    });

    expect(bucket.gets).toEqual(["stats/jsonl/2026-07.jsonl"]);
    expect(bucket.objects.get("stats/jsonl/2026-07.jsonl")).toBe("[1783036800,5]\n");
  });

  it.each([
    "not-json\n",
    "[1783036800,-1]\n",
    "{\"timestamp\":1783036800,\"usercount\":1}\n",
  ])("rejects invalid existing JSONL without writing", async (existing) => {
    const bucket = new FakeBucket();
    bucket.objects.set("stats/jsonl/2026-07.jsonl", existing);

    await expect(syncStats(createEnv(bucket), {
      now: new Date("2026-07-03T00:01:00.000Z"),
      fetcher: responseWith({ usercount: 12 }),
    })).rejects.toThrow("Failed to parse existing");
    expect(bucket.puts).toEqual([]);
  });
});
