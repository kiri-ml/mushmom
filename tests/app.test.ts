import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  schemaVersion: 2;
  archiveThroughPeriod: string;
  chunks: StatsManifestChunk[];
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
  const manifest = makeManifest([]);
  return {
    async loadStatsHistory() {},
    async loadInitialStatsHistory(options: LoadInitialStatsHistoryOptions<StatsPoint>) {
      const recentPayload = [[1776945603, 1459] as [number, number]];
      const result = { points: options.normalizePayload(recentPayload), recentPayload, manifest };
      options.onInitial?.(result);
      return result;
    },
    async loadArchiveStatsHistory(options: LoadArchiveStatsHistoryOptions<StatsPoint>) {
      const result = { points: [] as StatsPoint[], chunks: options.manifest.chunks.slice(1) };
      options.onArchive?.(result);
      return result;
    },
    selectArchiveChunks(manifest: StatsManifest, recentPayload: Array<[number, number] | { timestamp: number }>) {
      const rows = Array.isArray(recentPayload) ? recentPayload : [];
      const oldestLatest = Math.min(...rows.map((row) => Number(Array.isArray(row) ? row[0] : row.timestamp)));
      return manifest.chunks.slice(1).filter((chunk) => chunk.maxTimestamp < oldestLatest);
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

type ArchiveManifest = StatsManifest;
type StatsArchiveGenerator = {
  generateArchive: (payload: unknown, outputDir: string, r2Rows?: Array<[number, number]>) => { manifest: ArchiveManifest };
  readJsonlDirectory: (jsonlDir: string) => Array<[number, number]>;
};

function makeChunk(period: string, minTimestamp: number, maxTimestamp = minTimestamp): StatsManifestChunk {
  return { period, granularity: period.length === 4 ? "year" : "month", file: `${period}.AAAAAAAA.json`, minTimestamp, maxTimestamp, rowCount: 1 };
}

function makeManifest(chunks: StatsManifestChunk[], archiveThroughPeriod = "2026-06"): StatsManifest {
  return {
    schemaVersion: 2,
    dataset: "maplelegends-online-users",
    archiveThroughPeriod,
    format: { rowShape: ["epochSeconds", "usercount"], timestampUnit: "seconds", order: "ascending" },
    chunks,
  };
}

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
  generator.generateArchive({ data: rows }, outputDir, [[1782864000, 1]]);

  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifests.json"), "utf8")) as ArchiveManifest;
  return { outputDir, manifest };
}

afterEach(() => {
  vi.useRealTimers();
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
    expect(wranglerToml).toMatch(/binding = "STATS_BUCKET"/);
    expect(wranglerToml).toMatch(/bucket_name = "mushmom-stats"/);
  });

  it("preloads startup API requests from the HTML transform", () => {
    const tags = buildApiPreloadTags();
    expect(tags).toEqual([
      {
        tag: "link",
        attrs: {
          rel: "preload",
          href: "/api/stats/2026-07",
          as: "fetch",
          crossorigin: "",
        },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: {
          rel: "preload",
          href: `/assets/stats/${statsManifest.chunks[0]?.file}`,
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

  it("omits the archive preload when the v2 manifest has no chunks", () => {
    expect(buildApiPreloadTags(makeManifest([])).map((tag) => tag.attrs?.href)).toEqual([
      "/api/stats/2026-07",
      "/api/current",
    ]);
  });

  it("injects API preloads before the ECharts loader and module startup", () => {
    const script = buildEchartsLoaderScript();
    const transformed = injectStartupHtml(indexHtml);
    const recentPreload = '<link rel="preload" href="/api/stats/2026-07" as="fetch" crossorigin>';
    const initialPreload = `<link rel="preload" href="/assets/stats/${statsManifest.chunks[0]?.file}" as="fetch" crossorigin>`;
    const currentPreload = '<link rel="preload" href="/api/current" as="fetch" crossorigin>';
    expect(script).toContain(GLOBAL_ECHARTS_CDN);
    expect(script).toContain(CHINA_ECHARTS_CDN);
    expect(script).toContain("window.__mushmomEchartsReady");
    expect(script).toContain("document.head.appendChild(script)");
    expect(transformed.indexOf(recentPreload)).toBeLessThan(transformed.indexOf(script));
    expect(transformed.indexOf(initialPreload)).toBeLessThan(transformed.indexOf(script));
    expect(transformed.indexOf(currentPreload)).toBeLessThan(transformed.indexOf(script));
    expect(transformed.indexOf(script)).toBeLessThan(transformed.indexOf('<script type="module" src="/src/main.ts"></script>'));
    expect(indexHtml).not.toContain("echarts@6.1.0");
  });
});

describe("stats archive generator", () => {
  it("generates deterministic legacy-only archives when R2 JSONL is absent", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-legacy-only-"));
    const jsonlDir = path.join(tempDir, "jsonl");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(jsonlDir);
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;

    expect(generator.readJsonlDirectory(jsonlDir)).toEqual([]);
    const { manifest } = generator.generateArchive({ data: [
      { timestamp: "2026-07-01T00:00:00Z", usercount: 99 },
      { timestamp: "2026-06-30T23:45:04Z", usercount: 12 },
    ] }, outputDir);

    expect(manifest.archiveThroughPeriod).toBe("2026-06");
    expect(manifest.chunks.map((chunk) => chunk.period)).toEqual(["2026-06"]);
  });

  it("enforces cutover ownership, excludes the open month, and resolves duplicates last", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-v2-"));
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    const result = generator.generateArchive({ data: [
      { timestamp: 1782864000, usercount: 999 },
      { timestamp: 1782863104, usercount: 10 },
      { timestamp: 1782863104, usercount: 11 },
      { timestamp: "2025-01-01T00:00:00Z", usercount: 5 },
    ] }, tempDir, [[1782863104, 888], [1782864000, 20], [1782864000, 21]]);

    expect(result.manifest.archiveThroughPeriod).toBe("2026-06");
    const june = result.manifest.chunks.find((chunk) => chunk.period === "2026-06")!;
    const payload = JSON.parse(fs.readFileSync(path.join(tempDir, june.file), "utf8"));
    expect(payload.data).toEqual([[1782863104, 11]]);
    expect(result.manifest.chunks.some((chunk) => chunk.period === "2026-07")).toBe(false);
  });

  it("emits deterministic hashed bytes, monthly/annual partitions, and removes stale JSON", () => {
    const { outputDir, manifest } = generateStatsArchive([
      { timestamp: "2026-06-30T23:45:04Z", usercount: 12 },
      { timestamp: "2025-01-01T00:00:00Z", usercount: 8 },
      { timestamp: "2024-12-31T00:00:00Z", usercount: 7 },
    ]);
    fs.writeFileSync(path.join(outputDir, "stale-v1.json"), "{}\n");
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    generator.generateArchive({ data: [
      { timestamp: "2026-06-30T23:45:04Z", usercount: 12 },
      { timestamp: "2025-01-01T00:00:00Z", usercount: 8 },
      { timestamp: "2024-12-31T00:00:00Z", usercount: 7 },
    ] }, outputDir, [[1782864000, 1]]);
    const first = fs.readFileSync(path.join(outputDir, "manifests.json"));
    generator.generateArchive({ data: [
      { timestamp: "2026-06-30T23:45:04Z", usercount: 12 },
      { timestamp: "2025-01-01T00:00:00Z", usercount: 8 },
      { timestamp: "2024-12-31T00:00:00Z", usercount: 7 },
    ] }, outputDir, [[1782864000, 1]]);
    expect(fs.readFileSync(path.join(outputDir, "manifests.json"))).toEqual(first);
    expect(fs.existsSync(path.join(outputDir, "stale-v1.json"))).toBe(false);
    expect(manifest.chunks.map((chunk) => [chunk.period, chunk.granularity])).toEqual([
      ["2026-06", "month"], ["2025", "year"], ["2024", "year"],
    ]);
    expect(manifest.chunks.every((chunk) => /^\d{4}(?:-\d{2})?\.[A-Za-z0-9_-]{8}\.json$/.test(chunk.file))).toBe(true);
  });

  it("keeps the previous year monthly only through a January archive horizon", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-yearly-february-"));
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    const legacyPayload = { data: [
      { timestamp: "2025-12-31T00:00:00Z", usercount: 9 },
    ] };
    const previousYearRows: Array<[number, number]> = [[1782864000, 1], [1798675200, 2]];

    const january = generator.generateArchive(legacyPayload, path.join(tempDir, "jan"), [...previousYearRows, [1798761600, 3], [1801440000, 4]]).manifest;
    expect(january.archiveThroughPeriod).toBe("2027-01");
    expect(january.chunks.map((chunk) => [chunk.period, chunk.granularity])).toEqual([
      ["2027-01", "month"], ["2026-12", "month"], ["2026-07", "month"], ["2025", "year"],
    ]);

    const february = generator.generateArchive(legacyPayload, path.join(tempDir, "feb"), [...previousYearRows, [1798761600, 3], [1803859200, 4]]).manifest;
    expect(february.archiveThroughPeriod).toBe("2027-02");
    expect(february.chunks.map((chunk) => [chunk.period, chunk.granularity])).toEqual([
      ["2027-01", "month"], ["2026", "year"], ["2025", "year"],
    ]);
  });

  it("validates monthly filenames, month agreement, and ascending rows", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-invalid-jsonl-"));
    const jsonlPath = path.join(tempDir, "2026-07.jsonl");
    fs.writeFileSync(jsonlPath, "[1783037100,1]\n[1783036800,2]\n");
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    expect(() => generator.readJsonlDirectory(tempDir)).toThrow("timestamps must be ascending");

    fs.writeFileSync(jsonlPath, "[1785542400,1]\n");
    expect(() => generator.readJsonlDirectory(tempDir)).toThrow("timestamp does not match filename month");
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
    const rawSeries = module.buildTimelineOptions(points).series as Array<{ smooth?: boolean; type?: string }>;
    expect(rawSeries[0]?.type).toBe("line");
    expect(rawSeries[0]?.smooth).toBe(false);
    module.testApi.setCurrentRangeForTest("28d");
    const bucketedOptions = module.buildTimelineOptions(points);
    const bucketedSeries = bucketedOptions.series as Array<{ id?: string; smooth?: boolean; type?: string }>;
    expect(bucketedSeries.map((series) => series.type)).toEqual(["line", "line", "line"]);
    expect(bucketedSeries[0]?.id).toBe("range-base");
    expect(bucketedSeries[1]?.id).toBe("range-spread");
    expect(bucketedSeries[2]?.id).toBe("bucket-average");
    expect(bucketedSeries[2]?.smooth).toBe(true);
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

  it("accepts compact rows and non-negative counts while removing configured bad samples", async () => {
    const { module } = await loadAppModule();
    const points = module.normalizePayload([
      { timestamp: "2020-06-15 15:30:55.663+00", usercount: 1832 },
      { timestamp: "2020-06-15 15:30:55.664+00", usercount: 1832 },
      { timestamp: "2020-06-22 00:19:46.558+00", usercount: 2045 },
      { timestamp: "2020-06-22 01:00:00.528+00", usercount: 2125 },
      { timestamp: "2020-06-24 17:15:04.320+00", usercount: 0 },
      { timestamp: "2020-06-24 17:30:04.320+00", usercount: 1 },
      { timestamp: "2020-06-24 17:45:04.796+00", usercount: 991 },
      { timestamp: "2020-06-24 18:00:04.796+00", usercount: -1 },
      [1776945603, 1459],
    ]);
    expect(points.map((point) => point.count)).toEqual([1832, 2125, 0, 1, 991, 1459]);
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

  it("spreads heatmap colors across high-population averages", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    module.testApi.setCurrentRangeForTest("7d");
    const options = module.buildHeatmapOptions([
      { date: new Date(2026, 0, 1, 0), count: 2000 },
      { date: new Date(2026, 0, 1, 1), count: 2200 },
      { date: new Date(2026, 0, 1, 2), count: 2400 },
      { date: new Date(2026, 0, 1, 3), count: 2600 },
    ]);
    const heatmapData = (options.series[0]?.data || []) as Array<[number, number, number | null, number, Record<string, number>, number]>;
    const scoresByCount = new Map(heatmapData.map(([, , score, count]) => [count, score]));

    expect(scoresByCount.get(2000)).toBe(82);
    expect(scoresByCount.get(2200)).toBe(88);
    expect(scoresByCount.get(2400)).toBe(94);
    expect(scoresByCount.get(2600)).toBe(98);
  });

  it("waits for ECharts before loading archive stats", async () => {
    let resolveEcharts!: () => void;
    const echartsReady = new Promise<void>((resolve) => {
      resolveEcharts = resolve;
    });
    const calls: string[] = [];
    const renderedOptions: unknown[] = [];
    const recentPayload = [[1777594504, 1700] as [number, number], [1775001608, 1317] as [number, number]];
    const archivePayload = { data: [[1767224706, 1200] as [number, number]] };
    const manifest = makeManifest([
      makeChunk("2026-06", 1782863104),
      makeChunk("2025", 1767224706),
    ]);
    const translate = buildTranslator("en-US");
    const loader = {
      async loadStatsHistory() {},
      async loadInitialStatsHistory(options: LoadInitialStatsHistoryOptions<StatsPoint>) {
        calls.push("initial");
        const result = { points: options.normalizePayload(recentPayload), recentPayload, manifest };
        options.onInitial?.(result);
        return result;
      },
      async loadArchiveStatsHistory(options: LoadArchiveStatsHistoryOptions<StatsPoint>) {
        calls.push("archive");
        const result = { points: options.normalizePayload(archivePayload), chunks: manifest.chunks.slice(1) };
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

describe("stats loader schema v2", () => {
  const normalize = (payload: StatsPayload) => Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data) ? payload.data : [];

  it("loads all recent API months and the newest chunk at startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
    const { module } = await loadStatsModule();
    const newest = makeChunk("2026-06", 1782863104);
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/stats/2026-07") return [[1782864000, 20]];
      if (url === "/api/stats/2026-08") return [[1785542400, 30]];
      if (url === `/assets/stats/${newest.file}`) return { schemaVersion: 2, period: newest.period, data: [[1782863104, 10]] };
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await module.loadInitialStatsHistory({ manifest: makeManifest([newest]), fetcher, normalizePayload: normalize });
    expect(result.points).toEqual([[1782863104, 10], [1782864000, 20], [1785542400, 30]]);
  });

  it("loads only remaining non-overlapping chunks in manifest order", async () => {
    const { module } = await loadStatsModule();
    const newest = makeChunk("2026-06", 1782863104);
    const overlap = makeChunk("2026-05", 1777593612, 1780271104);
    const older = makeChunk("2024", 1704067200);
    const fetcher = vi.fn(async (url: string) => {
      if (url === `/assets/stats/${older.file}`) return { schemaVersion: 2, period: older.period, data: [[1704067200, 1]] };
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await module.loadArchiveStatsHistory({
      manifest: makeManifest([newest, overlap, older]),
      recentPayload: [[1778000000, 9]],
      fetcher,
      normalizePayload: normalize,
    });
    expect(result.chunks).toEqual([older]);
    expect(result.points).toEqual([[1704067200, 1]]);
  });

  it("supports an empty archive and rejects v1 manifests and chunks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00Z"));
    const { module } = await loadStatsModule();
    const empty = await module.loadInitialStatsHistory({
      manifest: makeManifest([]),
      fetcher: async () => [[1782864000, 20]],
      normalizePayload: normalize,
    });
    expect(empty.points).toEqual([[1782864000, 20]]);
    await expect(module.loadInitialStatsHistory({
      manifest: { initial: {}, backfill: [] } as never,
      fetcher: async () => [],
      normalizePayload: normalize,
    })).rejects.toThrow("schemaVersion 2");

    const newest = makeChunk("2026-06", 1782863104);
    await expect(module.loadInitialStatsHistory({
      manifest: makeManifest([newest]),
      fetcher: async (url: string) => url.startsWith("/api/") ? [] : { period: newest.period, data: [[1782863104, 10]] },
      normalizePayload: normalize,
    })).rejects.toThrow("schemaVersion 2");
  });

  it("enforces yearly-in-February archive partitioning outside runtime manifest validation", async () => {
    const { module } = await loadStatsModule();
    const januaryPreviousYearMonth = makeChunk("2025-12", 1767139200);
    const februaryPreviousYear = makeChunk("2025", 1735689600);
    const staleFebruaryMonth = makeChunk("2025-12", 1767139200);

    expect(module.validateManifestPartition(makeManifest([januaryPreviousYearMonth], "2026-01")).chunks[0]?.period).toBe("2025-12");
    expect(module.validateManifestPartition(makeManifest([februaryPreviousYear], "2026-02")).chunks[0]?.period).toBe("2025");
    expect(module.validateManifest(makeManifest([staleFebruaryMonth], "2026-02")).chunks[0]?.period).toBe("2025-12");
    expect(() => module.validateManifestPartition(makeManifest([staleFebruaryMonth], "2026-02"))).toThrow("invalid partitioning");
  });

  it("validates checked-in stats archive manifests before deploy", async () => {
    const { module } = await loadStatsModule();
    const publicManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "public/assets/stats/manifests.json"), "utf8"));
    const bundledManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "src/assets/stats/manifests.json"), "utf8"));

    expect(module.validateManifestPartition(publicManifest).chunks.map((chunk) => chunk.period)).toEqual(statsManifest.chunks.map((chunk) => chunk.period));
    expect(module.validateManifestPartition(bundledManifest).chunks.map((chunk) => chunk.period)).toEqual(statsManifest.chunks.map((chunk) => chunk.period));
  });
});
