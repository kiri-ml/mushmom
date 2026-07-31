import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = require(path.join(repoRoot, "scripts/migrate_2026_07_stats_json.cjs")) as {
  MONTH: string;
  SOURCE_OBJECT: string;
  DESTINATION_OBJECT: string;
  parseArgs(args: string[]): { apply: boolean; force: boolean };
  parseJsonl(text: string): Array<[number, number | null] | [number, number | null, number]>;
  serializeRowJson(rows: Array<[number, number | null] | [number, number | null, number]>): string;
};

describe("July stats JSON migration", () => {
  it("uses fixed source and destination objects without deleting the source", () => {
    expect(migration.MONTH).toBe("2026-07");
    expect(migration.SOURCE_OBJECT).toBe("mushmom-stats/stats/jsonl/2026-07.jsonl");
    expect(migration.DESTINATION_OBJECT).toBe("mushmom-stats/stats/json/2026-07.json");
  });

  it("converts LF and CRLF JSONL to exact cron-style JSON bytes", () => {
    const rows = migration.parseJsonl(
      "[1782864000,1200]\r\n[1782864300,1250,625]\r\n[1782864600,null,630]\r\n",
    );
    expect(migration.serializeRowJson(rows)).toBe(
      "[[1782864000,1200],[1782864300,1250,625],[1782864600,null,630]]",
    );
  });

  it("requires apply for explicit destination overwrites", () => {
    expect(migration.parseArgs([])).toEqual({ apply: false, force: false });
    expect(migration.parseArgs(["--apply"])).toEqual({ apply: true, force: false });
    expect(migration.parseArgs(["--force", "--apply"])).toEqual({ apply: true, force: true });
    expect(() => migration.parseArgs(["--force"])).toThrow("--force requires --apply");
    expect(() => migration.parseArgs(["--apply", "--apply"])).toThrow("Usage:");
    expect(() => migration.parseArgs(["--unknown"])).toThrow("Usage:");
  });

  it.each([
    ["", "contains no rows"],
    ["not-json\n", "line 1: malformed JSON"],
    ["[1782864000,-1]\n", "line 1: expected a compact stats tuple"],
    ["[1785542400,1]\n", "timestamp is outside 2026-07"],
    ["[1782864300,1]\n[1782864000,2]\n", "timestamps must be ascending"],
  ])("rejects invalid source JSONL", (contents, message) => {
    expect(() => migration.parseJsonl(contents)).toThrow(message);
  });
});
