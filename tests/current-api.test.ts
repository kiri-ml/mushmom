import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The Pages Function is intentionally authored as JavaScript.
import { onRequestGet } from "../functions/api/current.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("current users function", () => {
  it("preserves character and estimated-player counts in the compatibility payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      usercount: 2054,
      uniquecount: 1031,
    }), { status: 200 })));

    const response = await onRequestGet();
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ usercount: 2054, uniquecount: 1031 });
  });

  it.each([
    { usercount: 2054 },
    { usercount: 2054, uniquecount: -1 },
    { usercount: 2054, uniquecount: 1.5 },
    { usercount: 2054, uniquecount: "1031" },
  ])("rejects missing or invalid unique counts", async (upstreamPayload) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstreamPayload), { status: 200 })));

    const response = await onRequestGet();

    expect(response.status).toBe(502);
  });
});
