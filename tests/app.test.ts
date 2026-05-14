import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledLocaleRegistry as localeRegistry, bundledMessages as i18nMessages } from "../src/i18n/data";
import { buildApiPreloadTags, buildEchartsLoaderScript, CHINA_ECHARTS_CDN, GLOBAL_ECHARTS_CDN, injectStartupHtml } from "../vite.config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const repoRoot = path.join(__dirname, "..");

type StubElement = {
  textContent: string;
  disabled: boolean;
  dataset: Record<string, string>;
  classList: { toggle: () => void };
  append: () => void;
  addEventListener: () => void;
  replaceChildren: () => void;
  setAttribute: (name: string, value: string) => void;
  attrs?: Record<string, string>;
};

type GlobalOverrides = Record<string, unknown>;

type AppModule = typeof import("../src/app");
type I18nModule = typeof import("../src/i18n/index");
type StatsModule = typeof import("../src/load");

const indexHtml = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
const stylesCss = fs.readFileSync(path.join(repoRoot, "src/styles.css"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
const devScript = fs.readFileSync(path.join(repoRoot, "scripts/dev.cjs"), "utf8");
const viteConfigSource = fs.readFileSync(path.join(repoRoot, "vite.config.ts"), "utf8");
const statsManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "public/assets/stats/manifests.json"), "utf8")) as {
  initial: { end: number; file: string };
  backfill?: Array<{ end: number | string; file: string }>;
};
const wranglerToml = fs.readFileSync(path.join(repoRoot, "wrangler.toml"), "utf8");

function createStubElement(overrides: Partial<StubElement> = {}): StubElement {
  return {
    textContent: "",
    disabled: false,
    dataset: {},
    classList: { toggle() {} },
    append() {},
    addEventListener() {},
    replaceChildren() {},
    setAttribute(name: string, value: string) {
      this.attrs ??= {};
      this.attrs[name] = value;
    },
    ...overrides,
  };
}

function mockFetch<T>(payload: T): typeof fetch {
  return (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
}

function createStubDocument(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    documentElement: { lang: "" },
    visibilityState: "visible",
    querySelector: () => createStubElement(),
    querySelectorAll: () => [],
    createElement: () => createStubElement(),
    createDocumentFragment: () => ({ append() {} }),
    addEventListener() {},
    ...overrides,
  };
}

function createBaseGlobals(overrides: GlobalOverrides = {}) {
  const globals: GlobalOverrides = {
    localStorage: { getItem: () => null, setItem() {} },
    fetch: vi.fn(),
    CustomEvent: function CustomEvent(type: string, init: Record<string, unknown> = {}) {
      return { type, ...init };
    },
    navigator: { languages: ["en-US"], language: "en-US" },
    ...overrides,
  };
  globals.window = { ...globals, location: { origin: "https://mushmom.test" }, addEventListener() {}, setInterval() {}, dispatchEvent() {} };
  return globals;
}

function stubGlobals(globals: GlobalOverrides) {
  for (const [key, value] of Object.entries(globals)) {
    vi.stubGlobal(key, value);
  }
}

function buildTranslator(currentLang: string) {
  return (key: string, params: Record<string, string | number> = {}) => {
    const template = i18nMessages[currentLang]?.[key] ?? i18nMessages["en-US"]?.[key] ?? key;
    return String(template).replace(/\{([^{}]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
}

function buildStatsLoader() {
  return {
    async loadStatsHistory() {},
    async loadInitialStatsHistory(options: LoadInitialStatsHistoryOptions<StatsPoint>) {
      const latestPayload = { data: [[1776945603, 1459] as [number, number]] };
      const manifest = { initial: { file: "", end: 1775000707 }, backfill: [] };
      const result = { points: options.normalizePayload(latestPayload), latestPayload, manifest };
      options.onInitial?.(result);
      return result;
    },
    async loadArchiveStatsHistory(options: LoadArchiveStatsHistoryOptions<StatsPoint>) {
      const result = { points: [] as StatsPoint[], chunks: options.manifest.backfill || [] };
      options.onArchive?.(result);
      return result;
    },
    selectArchiveChunks(manifest: { backfill?: Array<{ end: number; file: string }> }, latestPayload: { data?: Array<[number, number] | { timestamp: number }> }) {
      const rows = Array.isArray(latestPayload?.data) ? latestPayload.data : [];
      const oldestLatest = Math.min(...rows.map((row) => Number(Array.isArray(row) ? row[0] : row.timestamp)));
      return (manifest?.backfill || []).filter((chunk) => Number(chunk.end) < oldestLatest);
    },
    oldestPayloadTimestamp(payload: { data?: Array<[number, number] | { timestamp: number }> }) {
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return Math.min(...rows.map((row) => Number(Array.isArray(row) ? row[0] : row.timestamp)));
    },
  };
}

async function loadI18nModule() {
  const globals = createBaseGlobals({
    document: createStubDocument(),
  });
  stubGlobals(globals);
  return { module: await import("../src/i18n/index") as I18nModule, globals };
}

async function loadAppModule(currentLang = "en-US") {
  const renderedOptions: unknown[] = [];
  const translate = buildTranslator(currentLang);
  const globals = createBaseGlobals({
    document: createStubDocument(),
    navigator: { languages: [currentLang], language: currentLang },
    fetch: mockFetch({ usercount: 0, data: [[1776945603, 1459]], chunks: [] }),
    echarts: {
      init: () => ({
        setOption(option: unknown) { renderedOptions.push(option); },
        resize() {},
      }),
    },
    __mushmomEchartsReady: Promise.resolve(),
    MushmomI18n: {
      ready: Promise.resolve(),
      t: translate,
      getCurrentLang: () => currentLang,
      setLang: (lang: string) => lang,
    },
    MushmomStatsLoader: buildStatsLoader(),
  });

  (globals.window as Record<string, unknown>).MushmomI18n = globals.MushmomI18n;
  (globals.window as Record<string, unknown>).MushmomStatsLoader = globals.MushmomStatsLoader;
  (globals.window as Record<string, unknown>).echarts = globals.echarts;
  (globals.window as Record<string, unknown>).fetch = globals.fetch;
  (globals.window as Record<string, unknown>).__mushmomEchartsReady = globals.__mushmomEchartsReady;

  stubGlobals(globals);
  return { module: await import("../src/app") as AppModule, globals, renderedOptions };
}

async function loadStatsModule() {
  const globals = createBaseGlobals({
    fetch: mockFetch({}),
  });
  stubGlobals(globals);
  return { module: await import("../src/load") as StatsModule, globals };
}

type LatestFunctionModule = {
  onRequestGet: (context: WaitUntilContext) => Promise<Response>;
  testApi: {
    parseCompletePrefixRows: (text: string) => LatestRow[];
  };
};
type LatestRow = { timestamp: string; usercount: number };
type LatestEnv = { GOOGLE_API_URL: string };
type WaitUntilContext = { request: Request; env: LatestEnv; waitUntil: (promise: Promise<unknown>) => void };
type FetchInitWithHeaders = { headers?: { range?: string }; cf?: { cacheTtl?: number } };
type CacheRequestLike = { url: string };
type ArchiveManifest = {
  initial?: { file: string; period: string; rows: number; start: number | null; end: number | null };
  backfill: Array<{ file: string; period: string; rows: number }>;
};
type StatsArchiveGenerator = {
  generateArchive: (payload: unknown, outputDir: string) => { manifest: ArchiveManifest };
};

function useWindow(globals: GlobalOverrides): void {
  globalThis.window = globals.window as Window & typeof globalThis;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function generateStatsArchive(rows: Array<{ timestamp: string; usercount: number }>): { outputDir: string; manifest: ArchiveManifest } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-stats-archive-"));
  const outputDir = path.join(tempDir, "out");
  const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
  generator.generateArchive({ data: rows }, outputDir);

  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifests.json"), "utf8")) as ArchiveManifest;
  return { outputDir, manifest };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("vite migration", () => {
  it("uses a single module bootstrap and source-owned styles", () => {
    expect(indexHtml).toMatch(/<script type="module" src="\/src\/main\.ts"><\/script>/);
    expect(indexHtml).not.toMatch(/<script src="\/i18n\.js" defer><\/script>/);
    expect(indexHtml).not.toMatch(/<script src="\/load\.js" defer><\/script>/);
    expect(indexHtml).not.toMatch(/<script src="\/app\.js" defer><\/script>/);
    expect(indexHtml).not.toMatch(/i18n\.json/);
    expect(stylesCss).toMatch(/\.app-shell/);
  });

  it("uses Vite as the dev origin and Pages Functions as the API backend", () => {
    expect(packageJson.scripts.dev).toBe("node scripts/dev.cjs");
    expect(packageJson.scripts["dev:vite"]).toBe("vite");
    expect(devScript).toMatch(/\.dev-pages/);
    expect(devScript).not.toMatch(/--proxy/);
    expect(viteConfigSource).toMatch(/proxy/);
    expect(viteConfigSource).toMatch(/"\/api"/);
    expect(devScript).toMatch(/WRANGLER_PORT/);
    expect(devScript).toMatch(/VITE_PORT/);
    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts.build).toBe("vite build");
    expect(packageJson.scripts.check).toBe("npm run test && npm run typecheck && npm run build");
    expect(wranglerToml).toMatch(/pages_build_output_dir = "dist"/);
  });

  it("preloads startup API requests from the HTML transform", () => {
    const tags = buildApiPreloadTags();
    expect(tags).toEqual([
      {
        tag: "link",
        attrs: {
          rel: "preload",
          href: `/api/stats/latest?after=${statsManifest.initial.end}`,
          as: "fetch",
          crossorigin: "",
        },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: {
          rel: "preload",
          href: `/assets/stats/${statsManifest.initial.file}`,
          as: "fetch",
          crossorigin: "",
        },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: {
          rel: "preload",
          href: "/api/current",
          as: "fetch",
          crossorigin: "",
        },
        injectTo: "head",
      },
    ]);
  });

  it("injects API preloads before the ECharts loader and module startup", () => {
    const script = buildEchartsLoaderScript();
    const transformed = injectStartupHtml(indexHtml);
    const latestPreload = `<link rel="preload" href="/api/stats/latest?after=${statsManifest.initial.end}" as="fetch" crossorigin>`;
    const initialPreload = `<link rel="preload" href="/assets/stats/${statsManifest.initial.file}" as="fetch" crossorigin>`;
    const currentPreload = '<link rel="preload" href="/api/current" as="fetch" crossorigin>';
    expect(script).toContain(GLOBAL_ECHARTS_CDN);
    expect(script).toContain(CHINA_ECHARTS_CDN);
    expect(script).toContain("window.__mushmomEchartsReady");
    expect(script).toContain("document.head.appendChild(script)");
    expect(transformed.indexOf(latestPreload)).toBeLessThan(transformed.indexOf(script));
    expect(transformed.indexOf(initialPreload)).toBeLessThan(transformed.indexOf(script));
    expect(transformed.indexOf(currentPreload)).toBeLessThan(transformed.indexOf(script));
    expect(transformed.indexOf(script)).toBeLessThan(transformed.indexOf('<script type="module" src="/src/main.ts"></script>'));
    expect(indexHtml).not.toContain("echarts@5.6.0");
  });
});

describe("stats archive generator", () => {
  it("generates and indexes the previous December when latest stats are in January", () => {
    const { outputDir, manifest } = generateStatsArchive([
      { timestamp: "2026-01-02T00:00:00Z", usercount: 1300 },
      { timestamp: "2025-12-31T23:00:00Z", usercount: 1200 },
      { timestamp: "2025-06-01T00:00:00Z", usercount: 1100 },
    ]);

    expect(fs.existsSync(path.join(outputDir, "2025.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "2025-12.json"))).toBe(true);
    expect(manifest.initial).toMatchObject({ file: "2025-12.json", period: "2025-12", rows: 1 });
    expect(manifest.backfill.map((chunk) => chunk.file)).toContain("2025.json");
    expect(manifest.backfill.map((chunk) => chunk.file)).not.toContain("2025-12.json");
  });

  it("reuses the normal monthly chunk when latest stats are after January", () => {
    const { outputDir, manifest } = generateStatsArchive([
      { timestamp: "2026-02-02T00:00:00Z", usercount: 1400 },
      { timestamp: "2026-01-31T23:00:00Z", usercount: 1300 },
      { timestamp: "2025-12-31T23:00:00Z", usercount: 1200 },
    ]);

    expect(fs.existsSync(path.join(outputDir, "2026-01.json"))).toBe(true);
    expect(manifest.initial).toMatchObject({ file: "2026-01.json", period: "2026-01", rows: 1 });
    expect(manifest.backfill.filter((chunk) => chunk.file === "2026-01.json")).toHaveLength(0);
  });

  it("orders manifest backfill from newest to oldest", () => {
    const { manifest } = generateStatsArchive([
      { timestamp: "2026-04-02T00:00:00Z", usercount: 1400 },
      { timestamp: "2026-03-31T23:00:00Z", usercount: 1300 },
      { timestamp: "2026-02-28T23:00:00Z", usercount: 1200 },
      { timestamp: "2026-01-31T23:00:00Z", usercount: 1100 },
      { timestamp: "2025-12-31T23:00:00Z", usercount: 1000 },
    ]);

    expect(manifest.initial?.file).toBe("2026-03.json");
    expect(manifest.backfill.map((chunk) => chunk.file)).toEqual([
      "2026-02.json",
      "2026-01.json",
      "2025.json",
    ]);
  });
});

describe("bundled i18n", () => {
  it("keeps locale registry and message coverage", () => {
    expect(Array.isArray(localeRegistry)).toBe(true);
    expect(localeRegistry.length).toBeGreaterThan(5);
    expect(localeRegistry[0]?.code).toBe("en-US");
    expect(i18nMessages["en-US"]?.["status.loading"]).toBe("LOADING");
    expect(i18nMessages["zh-Hans"]?.["chartView.heatmap"].length).toBeGreaterThan(0);
  });

  it("uses bundled locale data", async () => {
    const { module } = await loadI18nModule();
    const data = await module.loadI18nData();
    expect(data.localeRegistry?.length).toBe(localeRegistry.length);
    expect(data.messages?.["en-US"]?.["status.loading"]).toBe("LOADING");
    expect(module.bundledMessages["ja-JP"]?.["chartView.timeline"]).toBe(i18nMessages["ja-JP"]?.["chartView.timeline"]);
  });

  it("normalizes aliases and falls back to English strings", async () => {
    const { module } = await loadI18nModule();
    module.setI18nData({ localeRegistry, messages: i18nMessages });
    expect(module.MushmomI18n.normalizeLang("zh-SG")).toBe("zh-Hans");
    expect(module.MushmomI18n.normalizeLang("zh-HK")).toBe("zh-Hant");
    expect(module.MushmomI18n.normalizeLang("es-MX")).toBe("es-ES");
    expect(module.MushmomI18n.normalizeLang("it-IT")).toBe("en-US");
    expect(module.MushmomI18n.t("status.loading", {}, "en-US")).toBe("LOADING");
    expect(module.MushmomI18n.t("chartView.heatmap", {}, "xx-YY")).toBe(i18nMessages["en-US"]?.["chartView.heatmap"]);
  });

  it("returns localized timezone names", async () => {
    const { module } = await loadI18nModule();
    module.setI18nData({ localeRegistry, messages: i18nMessages });
    expect(module.MushmomI18n.formatTimeZoneName("en-US").length).toBeGreaterThan(0);
    expect(module.MushmomI18n.formatTimeZoneName("zh-Hans").length).toBeGreaterThan(0);
  });
});

describe("app behavior", () => {
  it("uses line for 7d and range band for longer bucketed ranges", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    const points = [
      { date: new Date(Date.UTC(2026, 3, 24, 12, 0, 0)), count: 1200 },
      { date: new Date(Date.UTC(2026, 3, 24, 13, 0, 0)), count: 1250 },
    ];
    module.testApi.setCurrentRangeForTest("7d");
    expect(module.buildTimelineOptions(points).series[0]?.type).toBe("line");
    module.testApi.setCurrentRangeForTest("28d");
    const bucketedOptions = module.buildTimelineOptions(points);
    const bucketedSeries = bucketedOptions.series as Array<{ id?: string; type?: string }>;
    expect(bucketedSeries.map((series) => series.type)).toEqual(["line", "line", "line"]);
    expect(bucketedSeries[0]?.id).toBe("range-base");
    expect(bucketedSeries[1]?.id).toBe("range-spread");
    expect(bucketedSeries[2]?.id).toBe("bucket-average");
  });

  it("uses compact bucket ranges in bucket tooltips", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    const sameDay = module.formatBucketRange(new Date(2026, 3, 24, 12).getTime(), { unit: "hour", size: 4 });
    const multiDay = module.formatBucketRange(new Date(2026, 3, 24).getTime(), { unit: "day", size: 2 });
    expect(sameDay).toMatch(/12:00 - 15:59/);
    expect(multiDay).toMatch(/Apr 24 - Apr 25/);
  });

  it("aligns weekly bucket summaries to local calendar week boundaries", async () => {
    const { module } = await loadAppModule();
    const buckets = module.buildBucketSummaries([
      { date: new Date(2024, 11, 29, 12), count: 1200 },
      { date: new Date(2024, 11, 30, 12), count: 1300 },
      { date: new Date(2025, 0, 4, 12), count: 1100 },
      { date: new Date(2025, 0, 5, 12), count: 1400 },
      { date: new Date(2025, 0, 6, 12), count: 1500 },
    ], { unit: "week", size: 1 });
    expect(buckets.length).toBe(2);
    expect(buckets[0]).toMatchObject({ min: 1100, max: 1300, samples: 3 });
    expect(buckets[1]).toMatchObject({ min: 1400, max: 1500, samples: 2 });
  });

  it("accepts compact epoch-second rows and removes only configured bad samples", async () => {
    const { module } = await loadAppModule();
    const points = module.normalizePayload([
      { timestamp: "2020-06-15 15:30:55.663+00", usercount: 1832 },
      { timestamp: "2020-06-15 15:30:55.664+00", usercount: 1832 },
      { timestamp: "2020-06-22 00:19:46.558+00", usercount: 2045 },
      { timestamp: "2020-06-22 01:00:00.528+00", usercount: 2125 },
      { timestamp: "2020-06-24 17:30:04.320+00", usercount: 1 },
      { timestamp: "2020-06-24 17:45:04.796+00", usercount: 991 },
      [1776945603, 1459],
    ]);
    expect(points.length).toBe(4);
  });

  it("rerenders timeline axis labels with the selected locale", async () => {
    const english = await loadAppModule("en-US");
    const chinese = await loadAppModule("zh-Hans");
    const timestamp = new Date(2026, 3, 24, 12, 0, 0).getTime();
    useWindow(english.globals);
    english.module.testApi.setCurrentRangeForTest("7d");
    expect(english.module.formatTimelineAxisLabel(timestamp)).toMatch(/^Apr 24\n12:00$/);
    useWindow(chinese.globals);
    chinese.module.testApi.setCurrentRangeForTest("7d");
    expect(chinese.module.formatTimelineAxisLabel(timestamp)).toMatch(/^4月24日\n12:00$/);
  });

  it("uses 24-hour format for last sample time and keeps heatmap bounds fixed", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    const formatted = module.formatTime(new Date(2026, 0, 1, 23, 5, 0));
    const bounds = module.getHeatmapVisualBounds();
    expect(formatted).toMatch(/23/);
    expect(formatted).not.toMatch(/AM|PM/i);
    expect(bounds.min).toBe(0);
    expect(bounds.max).toBe(100);
  });

  it("waits for ECharts before loading archive stats", async () => {
    let resolveEcharts!: () => void;
    const echartsReady = new Promise<void>((resolve) => {
      resolveEcharts = resolve;
    });
    const calls: string[] = [];
    const renderedOptions: unknown[] = [];
    const latestPayload = { data: [[1777594504, 1700] as [number, number], [1775001608, 1317] as [number, number]] };
    const archivePayload = { data: [[1767224706, 1200] as [number, number]] };
    const manifest = {
      initial: { file: "", end: 1775000707 },
        backfill: [{ file: "2025.json", period: "2025", end: 1767224706 }],
    };
    const translate = buildTranslator("en-US");
    const loader = {
      async loadStatsHistory() {},
      async loadInitialStatsHistory(options: LoadInitialStatsHistoryOptions<StatsPoint>) {
        calls.push("initial");
        const result = { points: options.normalizePayload(latestPayload), latestPayload, manifest };
        options.onInitial?.(result);
        return result;
      },
      async loadArchiveStatsHistory(options: LoadArchiveStatsHistoryOptions<StatsPoint>) {
        calls.push("archive");
        const result = { points: options.normalizePayload(archivePayload), chunks: manifest.backfill };
        options.onArchive?.(result);
        return result;
      },
      selectArchiveChunks: buildStatsLoader().selectArchiveChunks,
      oldestPayloadTimestamp: buildStatsLoader().oldestPayloadTimestamp,
    };
    const globals = createBaseGlobals({
      document: createStubDocument(),
      fetch: mockFetch({ usercount: 1700 }),
      echarts: {
        init: () => ({
          setOption(option: unknown) { renderedOptions.push(option); },
          resize() {},
        }),
      },
      __mushmomEchartsReady: echartsReady,
      MushmomI18n: {
        ready: Promise.resolve(),
        t: translate,
        getCurrentLang: () => "en-US",
        setLang: (lang: string) => lang,
      },
      MushmomStatsLoader: loader,
    });
    (globals.window as Record<string, unknown>).MushmomI18n = globals.MushmomI18n;
    (globals.window as Record<string, unknown>).MushmomStatsLoader = globals.MushmomStatsLoader;
    (globals.window as Record<string, unknown>).echarts = globals.echarts;
    (globals.window as Record<string, unknown>).fetch = globals.fetch;
    (globals.window as Record<string, unknown>).__mushmomEchartsReady = echartsReady;
    stubGlobals(globals);
    const module = await import("../src/app") as AppModule;
    useWindow(globals);

    module.initApp();
    await flushPromises();

    expect(calls).toEqual(["initial"]);
    expect(renderedOptions).toHaveLength(0);

    resolveEcharts();
    await flushPromises();

    expect(calls).toEqual(["initial", "archive"]);
    expect(renderedOptions.length).toBeGreaterThan(0);
  });
});

describe("stats loader", () => {
  it("loads initial stats without fetching archive chunks", async () => {
    const { module } = await loadStatsModule();
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/stats/latest?after=1775000707") {
        return { data: [[1777594504, 1700], [1775001608, 1317]] };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const onInitial = vi.fn();

    const result = await module.loadInitialStatsHistory({
      manifest: {
        initial: { file: "", end: 1775000707 },
        backfill: [{ file: "2025.json", end: 1767224706 }],
      },
      fetcher,
      normalizePayload: (payload) => Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [],
      onInitial,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/stats/latest?after=1775000707");
    expect(result.points).toHaveLength(2);
    expect(onInitial).toHaveBeenCalledWith(result);
  });

  it("loads manifest initial with the initial stats payload", async () => {
    const { module } = await loadStatsModule();
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/stats/latest?after=1775000707") {
        return { data: [[1777594504, 1700], [1775001608, 1317]] };
      }
      if (url === "/assets/stats/2026-03.json") {
        return { data: [[1775000707, 1300]] };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const onInitial = vi.fn();

    const result = await module.loadInitialStatsHistory({
      manifest: {
        initial: { file: "2026-03.json", end: 1775000707 },
        backfill: [{ file: "2025.json", end: 1767224706 }],
      },
      fetcher,
      normalizePayload: (payload) => Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [],
      onInitial,
    });

    expect(fetcher).toHaveBeenCalledWith("/api/stats/latest?after=1775000707");
    expect(fetcher).toHaveBeenCalledWith("/assets/stats/2026-03.json");
    expect(result.points).toEqual([[1775000707, 1300], [1777594504, 1700], [1775001608, 1317]]);
    expect(onInitial).toHaveBeenCalledWith(result);
  });

  it("loads archive chunks separately from the initial payload", async () => {
    const { module } = await loadStatsModule();
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/assets/stats/2025.json") {
        return { data: [[1767224706, 1200]] };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const onArchive = vi.fn();

    const result = await module.loadArchiveStatsHistory({
      manifest: {
        initial: { file: "", end: 1775000707 },
        backfill: [
          { file: "2025.json", end: 1767224706 },
          { file: "2026-04.json", end: 1777592707 },
        ],
      },
      latestPayload: { data: [[1777594504, 1700], [1775001608, 1317]] },
      fetcher,
      normalizePayload: (payload) => Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [],
      onArchive,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/assets/stats/2025.json");
    expect(result.points).toEqual([[1767224706, 1200]]);
    expect(result.chunks.map((chunk: { file: string }) => chunk.file)).toEqual(["2025.json"]);
    expect(onArchive).toHaveBeenCalledWith(result);
  });

  it("uses the bundled manifest without fetching manifests.json", async () => {
    const { module } = await loadStatsModule();
    const manifestAfter = Number(statsManifest.initial.end);
    const oldestLatest = manifestAfter + 1;
    const latestPayload = { data: [[oldestLatest + 3600, 1700], [oldestLatest, 1317]] };
    const expectedArchiveChunks = (statsManifest.backfill ?? []).filter((chunk) => Number(chunk.end) < oldestLatest);
    const fetcher = vi.fn(async (url: string) => {
      if (url === `/api/stats/latest?after=${manifestAfter}`) {
        return latestPayload;
      }
      if (url.startsWith("/assets/stats/")) {
        return { data: [] };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const onInitial = vi.fn();
    const onArchive = vi.fn();

    await module.loadStatsHistory({
      fetcher,
      normalizePayload: (payload) => Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [],
      onInitial,
      onArchive,
    });

    expect(fetcher).toHaveBeenCalledWith(`/api/stats/latest?after=${manifestAfter}`);
    expect(fetcher).not.toHaveBeenCalledWith("/assets/stats/manifests.json");
    expect(onInitial).toHaveBeenCalledTimes(1);
    expect(onInitial.mock.calls[0]?.[0]?.manifest?.backfill?.length).toBeGreaterThan(0);
    expect(onArchive).toHaveBeenCalledTimes(1);
    const archiveCall = onArchive.mock.calls[0]?.[0];
    const selectedChunks = archiveCall?.chunks ?? [];
    expect(selectedChunks.map((chunk: { file: string }) => chunk.file)).toEqual(expectedArchiveChunks.map((chunk) => chunk.file));
    expect(selectedChunks.every((chunk: { end?: number | string }) => Number(chunk.end) < oldestLatest)).toBe(true);
  });

  it("skips archive chunks overlapping latest payload", async () => {
    const { module } = await loadStatsModule();
    const chunks = module.selectArchiveChunks(
      { backfill: [{ file: "2025.json", end: 1767224700 }, { file: "2026-03.json", end: 1775000707 }, { file: "2026-04.json", end: 1777592707 }] },
      { data: [[1777594504, 1700], [1775001608, 1317]] },
    );
    expect(chunks.map((chunk) => chunk.file)).toEqual(["2025.json", "2026-03.json"]);
  });

  it("does not select the separate initial manifest entry for archive loading", async () => {
    const { module } = await loadStatsModule();
    const chunks = module.selectArchiveChunks(
      {
        initial: { file: "2026-03.json", end: 1775000707 },
        backfill: [{ file: "2025.json", end: 1767224700 }],
      },
      { data: [[1777594504, 1700], [1775001608, 1317]] },
    );
    expect(chunks.map((chunk) => chunk.file)).toEqual(["2025.json"]);
  });

  it("uses manifest initial.end for latest fetch", async () => {
    const { module } = await loadStatsModule();
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/stats/latest?after=1775000707") {
        return { data: [[1777594504, 1700]] };
      }
      return { data: [] };
    });

    await module.loadStatsHistory({
      manifest: { initial: { file: "", end: 1775000707 }, backfill: [] },
      fetcher,
      normalizePayload: (payload) => Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [],
    });

    expect(fetcher).toHaveBeenCalledWith("/api/stats/latest?after=1775000707");
  });

  it("throws when bundled manifest is missing a valid initial.end", async () => {
    const { module } = await loadStatsModule();
    const fetcher = vi.fn(async () => ({ data: [[1777594504, 1700]] }));

    await expect(module.loadStatsHistory({
      manifest: { backfill: [] },
      fetcher,
      normalizePayload: (payload) => Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [],
    })).rejects.toThrow("Bundled stats manifest is missing a valid initial.end value.");

    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe("stats latest function", () => {
  async function loadLatestModule(): Promise<LatestFunctionModule> {
    return import(pathToFileURL(path.join(repoRoot, "functions/api/stats/latest.js")).href + `?t=${Date.now()}-${Math.random()}`) as Promise<LatestFunctionModule>;
  }

  function makeRows(rows: LatestRow[]): string {
    return JSON.stringify(rows);
  }

  function makeContext(url: string, env: LatestEnv): WaitUntilContext {
    return {
      request: new Request(url),
      env,
      waitUntil() {},
    };
  }

  it("keeps existing no-arg behavior with the fixed range", async () => {
    const mod = await loadLatestModule();
    const rows = makeRows([
      { timestamp: "2026-04-28 00:15:00+00", usercount: 1500 },
      { timestamp: "2026-04-01 00:00:00+00", usercount: 1400 },
      { timestamp: "2026-03-31 23:45:00+00", usercount: 1300 },
    ]);
    const fetchMock = vi.fn(async () => new Response(rows, { status: 206 }));
    const cacheMatch = vi.fn(async () => undefined);
    const cachePut = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });

    const response = await mod.onRequestGet(makeContext("https://mushmom.test/api/stats/latest", {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    const firstFetchCall = fetchMock.mock.calls[0] as unknown as [unknown, FetchInitWithHeaders?] | undefined;
    const firstFetchInit = firstFetchCall?.[1];
    expect(firstFetchInit?.headers?.range).toBe("bytes=0-262143");
    expect(firstFetchInit?.cf?.cacheTtl).toBe(0);
    expect(body.data).toEqual([[1777335300, 1500], [1743465600 + 31536000, 1400]]);
    expect(body.completeWindow).toBe(true);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=1800, stale-while-revalidate=600, stale-if-error=3600");
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("returns only rows newer than after and excludes equal timestamps", async () => {
    const mod = await loadLatestModule();
    const rows = makeRows([
      { timestamp: "2026-04-28 00:30:00+00", usercount: 1600 },
      { timestamp: "2026-04-28 00:15:00+00", usercount: 1500 },
      { timestamp: "2026-04-28 00:00:00+00", usercount: 1400 },
    ]);
    const fetchMock = vi.fn(async () => new Response(rows, { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } });

    const after = Math.floor(Date.UTC(2026, 3, 28, 0, 15, 0) / 1000);
    const response = await mod.onRequestGet(makeContext(`https://mushmom.test/api/stats/latest?after=${after}`, {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.after).toBe(after);
    expect(body.data).toEqual([[1777336200, 1600]]);
    expect(body.data[0][0]).toBe(Math.floor(Date.UTC(2026, 3, 28, 0, 30, 0) / 1000));
    expect(body.completeWindow).toBe(true);
  });

  it("returns 400 for invalid after", async () => {
    const mod = await loadLatestModule();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } });

    const response = await mod.onRequestGet(makeContext("https://mushmom.test/api/stats/latest?after=1.5", {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_after" });
  });

  it("repairs partial JSON cut mid-object", async () => {
    const mod = await loadLatestModule();
    const partial = makeRows([
      { timestamp: "2026-04-28 00:30:00+00", usercount: 1600 },
      { timestamp: "2026-04-28 00:15:00+00", usercount: 1500 },
      { timestamp: "2026-04-27 23:30:00+00", usercount: 1400 },
    ]).slice(0, -20);

    expect(mod.testApi.parseCompletePrefixRows(partial)).toEqual([
      { timestamp: "2026-04-28 00:30:00+00", usercount: 1600 },
      { timestamp: "2026-04-28 00:15:00+00", usercount: 1500 },
    ]);
  });

  it("retries with a larger dynamic range when the first partial response does not reach the boundary", async () => {
    const mod = await loadLatestModule();
    const now = Date.UTC(2026, 3, 29, 0, 15, 0);
    vi.setSystemTime(new Date(now));
    const after = Math.floor(now / 1000) - (24 * 60 * 60);
    const first = '[{"timestamp":"2026-04-28 00:30:00+00","usercount":1600},{"timestamp":"2026-04-28 00:15:00+00","usercount":1500';
    const format = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00').slice(0, 19) + '+00';
    const second = makeRows([
      { timestamp: format(now), usercount: 1700 },
      { timestamp: format(now - 15 * 60 * 1000), usercount: 1600 },
      { timestamp: format(after * 1000), usercount: 1500 },
    ]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(first, { status: 206 }))
      .mockResolvedValueOnce(new Response(second, { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } });

    const response = await mod.onRequestGet(makeContext(`https://mushmom.test/api/stats/latest?after=${after}`, {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstFetchCall = fetchMock.mock.calls[0] as unknown as [unknown, FetchInitWithHeaders?] | undefined;
    const secondFetchCall = fetchMock.mock.calls[1] as unknown as [unknown, FetchInitWithHeaders?] | undefined;
    const firstRange = firstFetchCall?.[1]?.headers?.range;
    const secondRange = secondFetchCall?.[1]?.headers?.range;
    expect(firstRange).not.toBe(secondRange);
    expect(body.data.length).toBe(2);
  });

  it("returns 413 when after is too old", async () => {
    const mod = await loadLatestModule();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } });

    const response = await mod.onRequestGet(makeContext("https://mushmom.test/api/stats/latest?after=0", {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "after_too_old" });
  });

  it("normalizes the cache key to ignore unrelated query params", async () => {
    const mod = await loadLatestModule();
    const rows = makeRows([
      { timestamp: "2026-04-28 00:30:00+00", usercount: 1600 },
      { timestamp: "2026-04-28 00:15:00+00", usercount: 1500 },
      { timestamp: "2026-04-28 00:00:00+00", usercount: 1400 },
    ]);
    const fetchMock = vi.fn(async () => new Response(rows, { status: 206 }));
    const cacheMatch = vi.fn(async () => undefined);
    const cachePut = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });

    const after = Math.floor(Date.UTC(2026, 3, 28, 0, 15, 0) / 1000);
    await mod.onRequestGet(makeContext(`https://mushmom.test/api/stats/latest?foo=1&after=${after}&bar=2`, {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));
    await mod.onRequestGet(makeContext("https://mushmom.test/api/stats/latest?foo=1", {
      GOOGLE_API_URL: "https://example.test/stats.json",
    }));

    const firstCacheMatchCall = cacheMatch.mock.calls[0] as unknown as [CacheRequestLike?] | undefined;
    const firstCachePutCall = cachePut.mock.calls[0] as unknown as [CacheRequestLike?] | undefined;
    const secondCacheMatchCall = cacheMatch.mock.calls[1] as unknown as [CacheRequestLike?] | undefined;
    expect(firstCacheMatchCall?.[0]?.url).toBe(`https://mushmom.test/api/stats/latest?after=${after}`);
    expect(firstCachePutCall?.[0]?.url).toBe(`https://mushmom.test/api/stats/latest?after=${after}`);
    expect(secondCacheMatchCall?.[0]?.url).toBe("https://mushmom.test/api/stats/latest");
  });
});
