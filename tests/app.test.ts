import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledLocaleRegistry as localeRegistry, bundledMessages as i18nMessages } from "../src/i18n/data";
import { nextMonthKey } from "../src/stats-months";
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
  schemaVersion: 3;
  archiveThroughPeriod: string;
  chunks: StatsManifestChunk[];
};
const firstRecentMonth = nextMonthKey(statsManifest.archiveThroughPeriod);
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
    fetch: mockFetch({ usercount: 0, uniquecount: 0, data: [[1776945603, 1459]], chunks: [] }),
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
type ArchiveRow = [number, number | null] | [number, number | null, number | null];
type StatsArchiveGenerator = {
  generateArchive: (payload: unknown, outputDir: string, r2Rows?: ArchiveRow[], archiveThroughPeriod?: string) => { manifest: ArchiveManifest };
  parseArgs: (args: string[]) => { output?: string; jsonDir?: string; legacyOnly?: boolean };
  readJsonDirectory: (jsonDir: string) => ArchiveRow[];
  validateJsonPeriods: (periods: string[], requiredThroughPeriod?: string) => string;
};

function makeChunk(period: string, minTimestamp: number, maxTimestamp = minTimestamp): StatsManifestChunk {
  return { period, granularity: period.length === 4 ? "year" : "month", file: `${period}.AAAAAAAA.json`, minTimestamp, maxTimestamp, rowCount: 1 };
}

function makeManifest(chunks: StatsManifestChunk[], archiveThroughPeriod = "2026-06"): StatsManifest {
  return {
    schemaVersion: 3,
    dataset: "maplelegends-online-users",
    archiveThroughPeriod,
    format: { rowShape: ["timestampDeltaSeconds", "usercountDelta"], timestampUnit: "seconds", order: "ascending" },
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
          href: `/api/stats/${firstRecentMonth}`,
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

  it("omits the archive preload when the manifest has no chunks", () => {
    expect(buildApiPreloadTags(makeManifest([])).map((tag) => tag.attrs?.href)).toEqual([
      "/api/stats/2026-07",
      "/api/current",
    ]);
  });

  it("injects API preloads before the ECharts loader and module startup", () => {
    const script = buildEchartsLoaderScript();
    const transformed = injectStartupHtml(indexHtml);
    const recentPreload = `<link rel="preload" href="/api/stats/${firstRecentMonth}" as="fetch" crossorigin>`;
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
    expect(indexHtml).toContain('id="current-character-count"');
    expect(indexHtml).toContain('id="current-player-count"');
    expect(indexHtml).toContain('id="peak-player-count"');
    expect(indexHtml).toContain('id="average-player-count"');
    expect(indexHtml.match(/data-metric-board/g)).toHaveLength(2);
    expect(indexHtml).toContain('class="metric-card__content"');
    expect(indexHtml.match(/class="metric-card__range-ticks"/g)).toHaveLength(2);
    expect(indexHtml).not.toMatch(/metric-card__range-ticks[^>]*><i>/);
    expect(stylesCss).toContain("@keyframes metric-card-reel");
    expect(stylesCss).toContain("@keyframes metric-card-countdown");
    expect(stylesCss).toContain(".metric-card--cycling.is-counting::before");
    expect(indexHtml).toContain('data-metric="characters" aria-pressed="true"');
    expect(indexHtml).toContain('data-metric="players" aria-pressed="false"');
  });
});

describe("stats archive generator", () => {
  it("generates deterministic legacy-only archives when R2 JSON is absent", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-legacy-only-"));
    const jsonDir = path.join(tempDir, "json");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(jsonDir);
    fs.writeFileSync(path.join(jsonDir, "2026-07.jsonl"), "[1782864000,999]\n");
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;

    expect(generator.readJsonDirectory(jsonDir)).toEqual([]);
    const { manifest } = generator.generateArchive({ data: [
      { timestamp: "2026-07-01T00:00:00Z", usercount: 99 },
      { timestamp: "2026-06-30T23:45:04Z", usercount: 12 },
    ] }, outputDir);

    expect(manifest.archiveThroughPeriod).toBe("2026-06");
    expect(manifest.chunks.map((chunk) => chunk.period)).toEqual(["2026-06"]);
  });

  it("uses migrated July JSON as the first R2-owned month", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-json-cutover-"));
    const jsonDir = path.join(tempDir, "json");
    const outputDir = path.join(tempDir, "out");
    fs.mkdirSync(jsonDir);
    fs.writeFileSync(path.join(jsonDir, "2026-07.json"), "[[1782864000,20]]");
    fs.writeFileSync(path.join(jsonDir, "2026-08.json"), "[[1785542400,30]]");
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;

    const rows = generator.readJsonDirectory(jsonDir);
    const { manifest } = generator.generateArchive({ data: [
      { timestamp: "2026-06-30T23:45:04Z", usercount: 10 },
      { timestamp: "2026-07-01T00:00:00Z", usercount: 999 },
    ] }, outputDir, rows);

    expect(manifest.archiveThroughPeriod).toBe("2026-07");
    const july = manifest.chunks.find((chunk) => chunk.period === "2026-07")!;
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, july.file), "utf8"))).toEqual({
      schemaVersion: 3,
      period: "2026-07",
      timestampBase: 1782864000,
      data: [[0, 20]],
    });
  });

  it("requires contiguous R2 month files through the required month", () => {
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;

    expect(generator.validateJsonPeriods(["2026-07", "2026-08"], "2026-08")).toBe("2026-08");
    expect(() => generator.validateJsonPeriods(["2026-07"], "2026-08")).toThrow("missing monthly files: 2026-08");
    expect(() => generator.validateJsonPeriods(["2026-08"], "2026-08")).toThrow("missing monthly files: 2026-07");
    expect(() => generator.validateJsonPeriods([], "2026-08")).toThrow("contains no monthly files");
    expect(() => generator.validateJsonPeriods(["2026-07", "2026-09"], "2026-08")).toThrow("future monthly file: 2026-09");
  });

  it("advances through an explicitly empty archived month", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-empty-archive-month-"));
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    const { manifest } = generator.generateArchive({ data: [
      { timestamp: "2026-06-30T23:45:04Z", usercount: 10 },
    ] }, tempDir, [[1785542400, 30]], "2026-07");

    expect(manifest.archiveThroughPeriod).toBe("2026-07");
    expect(manifest.chunks.some((chunk) => chunk.period === "2026-07")).toBe(false);
  });

  it("requires an explicit CLI input mode", () => {
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;

    expect(() => generator.parseArgs([])).toThrow("Specify --json-dir");
    expect(generator.parseArgs(["--json-dir", "stats"])).toEqual({ jsonDir: "stats" });
    expect(generator.parseArgs(["--legacy-only"])).toEqual({ legacyOnly: true });
    expect(() => generator.parseArgs(["--json-dir", "stats", "--legacy-only"])).toThrow("either --json-dir or --legacy-only");
  });

  it("enforces cutover ownership, excludes the open month, and resolves duplicates last", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-v3-"));
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
    expect(payload).toEqual({ schemaVersion: 3, period: "2026-06", timestampBase: 1782863104, data: [[0, 11]] });
    expect(result.manifest.chunks.some((chunk) => chunk.period === "2026-07")).toBe(false);
  });

  it("preserves mixed legacy and unique-count R2 tuples", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-mixed-tuples-"));
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    const result = generator.generateArchive({ data: [
      { timestamp: "2026-06-30T23:45:04Z", usercount: 11 },
    ] }, tempDir, [[1782864000, 20], [1782864300, 21, 10], [1785542400, 22, 11]]);

    expect(result.manifest.format.rowShape).toEqual(["timestampDeltaSeconds", "usercountDelta", "uniquecountDelta?"]);
    const july = result.manifest.chunks.find((chunk) => chunk.period === "2026-07")!;
    const payload = JSON.parse(fs.readFileSync(path.join(tempDir, july.file), "utf8"));
    expect(payload).toEqual({
      schemaVersion: 3,
      period: "2026-07",
      timestampBase: 1782864000,
      data: [[0, 20], [300, 1, 10]],
    });
  });

  it("encodes nullable count fields with independent zero-based state", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-null-counts-"));
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    const result = generator.generateArchive({ data: [
      { timestamp: "2026-06-30T23:45:04Z", usercount: null, users: 99, uniquecount: 7 },
    ] }, tempDir, [
      [1782864000, null, 5],
      [1782864300, 10, null],
      [1782864600, null, 8],
      [1785542400, 1],
    ]);
    const july = result.manifest.chunks.find((chunk) => chunk.period === "2026-07")!;
    const payload = JSON.parse(fs.readFileSync(path.join(tempDir, july.file), "utf8"));
    expect(payload.data).toEqual([[0, null, 5], [300, 10], [300, null, 3]]);
    const june = result.manifest.chunks.find((chunk) => chunk.period === "2026-06")!;
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, june.file), "utf8")).data).toEqual([[0, null, 7]]);
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

  it("reads compact monthly JSON and validates filenames, month agreement, and ascending rows", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-invalid-json-"));
    const jsonPath = path.join(tempDir, "2026-07.json");
    fs.writeFileSync(jsonPath, "[[1782864000,1],[1782864300,2,1]]");
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    expect(generator.readJsonDirectory(tempDir)).toEqual([
      [1782864000, 1],
      [1782864300, 2, 1],
    ]);

    fs.writeFileSync(jsonPath, "[[1783037100,1],[1783036800,2]]");
    expect(() => generator.readJsonDirectory(tempDir)).toThrow("timestamps must be ascending");

    fs.writeFileSync(jsonPath, "[[1785542400,1]]");
    expect(() => generator.readJsonDirectory(tempDir)).toThrow("timestamp does not match filename month");
  });

  it.each([
    ["2026-07.json", "not-json", "malformed JSON"],
    ["2026-07.json", "{}", "expected an array"],
    ["2026-07.json", "[[1782864000,-1]]", "expected a two- or three-value tuple"],
    ["2026-13.json", "[]", "Invalid R2 JSON filename"],
  ])("rejects invalid monthly JSON input", (fileName, contents, message) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mushmom-invalid-json-"));
    fs.writeFileSync(path.join(tempDir, fileName), contents);
    const generator = require(path.join(repoRoot, "scripts/generate_stats_archive.cjs")) as StatsArchiveGenerator;
    expect(() => generator.readJsonDirectory(tempDir)).toThrow(message);
  });
});

describe("bundled i18n", () => {
  it("keeps locale registry and message coverage", () => {
    expect(Array.isArray(localeRegistry)).toBe(true);
    expect(localeRegistry.length).toBeGreaterThan(5);
    expect(localeRegistry[0]?.code).toBe("en-US");
    expect(i18nMessages["en-US"]?.["status.loading"]).toBe("LOADING");
    expect(i18nMessages["en-US"]?.["metric.charactersOnline"]).toBe("Characters online");
    expect(i18nMessages["en-US"]?.["metric.players"]).toBe("Players");
    expect(i18nMessages["zh-Hans"]?.["metric.characters"]).toBe("角色");
    expect(i18nMessages["zh-Hans"]?.["metric.players"]).toBe("玩家");
    expect(i18nMessages["zh-Hans"]?.["metric.peak"]).toBe("最高在线");
    expect(i18nMessages["zh-Hans"]?.["metric.average"]).toBe("平均在线");
    expect(i18nMessages["zh-Hant"]?.["metric.characters"]).toBe("角色");
    expect(i18nMessages["zh-Hant"]?.["metric.players"]).toBe("玩家");
    expect(i18nMessages["zh-Hans"]?.["hero.eyebrow"]).toBe("MapleLegends 在线人数追踪器");
    expect(i18nMessages["zh-Hant"]?.["hero.eyebrow"]).toBe("MapleLegends 線上人數追蹤器");
    expect(i18nMessages["de-DE"]?.["hero.eyebrow"]).toBe("Tracker der MapleLegends-Onlinezahlen");
    expect(i18nMessages["ja-JP"]?.["hero.eyebrow"]).toBe("MapleLegends オンライン人数トラッカー");
    expect(i18nMessages["ko-KR"]?.["hero.eyebrow"]).toBe("MapleLegends 온라인 인원 추적기");
    expect(i18nMessages["zh-Hans"]?.["chartView.heatmap"].length).toBeGreaterThan(0);
    for (const locale of localeRegistry) {
      expect(i18nMessages[locale.code]?.["aria.chartMetric"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["range.ytd"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["metric.characters"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["metric.players"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["metric.peak"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["metric.average"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["range.24h"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["chart.series.averagePlayers"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["ui.noPlayerData"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["error.currentPopulationRequestFailed"]?.length).toBeGreaterThan(0);
      expect(i18nMessages[locale.code]?.["metric.uniqueIp"]).toBeUndefined();
      expect(i18nMessages[locale.code]?.["ui.noUniqueIpData"]).toBeUndefined();
    }
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

  it("renders each locale's YTD label with the current year available", async () => {
    const rangeButton = createStubElement();
    const document = createStubDocument({
      querySelectorAll(selector: string) {
        return selector === "[data-i18n-year]" ? [rangeButton] : [];
      },
    });
    rangeButton.dataset.i18nYear = "range.ytd";
    const globals = createBaseGlobals({ document });
    stubGlobals(globals);
    const module = await import("../src/i18n/index") as I18nModule;
    module.setI18nData({ localeRegistry, messages: i18nMessages });

    module.MushmomI18n.applyI18n("en-US");

    expect(rangeButton.textContent).toBe("YTD");
    module.MushmomI18n.applyI18n("de-DE");
    expect(rangeButton.textContent).toBe(new Intl.DateTimeFormat("de-DE", { year: "numeric" }).format(new Date()));
    module.MushmomI18n.applyI18n("zh-Hans");
    expect(rangeButton.textContent).toBe("今年");
    module.MushmomI18n.applyI18n("ja-JP");
    expect(rangeButton.textContent).toBe("今年");
    module.MushmomI18n.applyI18n("ko-KR");
    expect(rangeButton.textContent).toBe("올해");
    expect(indexHtml).toContain('data-i18n-year="range.ytd"');
    expect(indexHtml).not.toContain('data-i18n-aria-label="range.ytd"');
    expect(indexHtml).not.toContain('data-range="ytd" data-i18n="range.ytd"');
  });
});

describe("app behavior", () => {
  it("uses two raw lines and two range bands for bucketed timeline ranges", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    const points = [
      { date: new Date(Date.UTC(2026, 3, 24, 12, 0, 0)), characterCount: 1200, playerCount: 600 },
      { date: new Date(Date.UTC(2026, 3, 24, 13, 0, 0)), characterCount: 1250, playerCount: 625 },
      { date: new Date(Date.UTC(2026, 3, 25, 12, 0, 0)), characterCount: 1300 },
    ];
    module.testApi.setCurrentRangeForTest("7d");
    const rawSeries = module.buildTimelineOptions(points).series as Array<{ smooth?: boolean; symbol?: string; type?: string }>;
    expect(rawSeries.map((series) => series.type)).toEqual(["line", "line"]);
    expect(rawSeries.every((series) => series.smooth === false)).toBe(true);
    expect(rawSeries.every((series) => series.symbol === "none")).toBe(true);
    expect((rawSeries[1] as { data: Array<[number, number | null]> }).data.map(([, value]) => value)).toEqual([600, 625, null]);
    module.testApi.setCurrentRangeForTest("28d");
    const bucketedOptions = module.buildTimelineOptions(points);
    const bucketedSeries = bucketedOptions.series as Array<{ id?: string; smooth?: boolean; symbol?: string; type?: string }>;
    expect(bucketedSeries.map((series) => series.type)).toEqual(["line", "line", "line", "line", "line", "line"]);
    expect(bucketedSeries.map((series) => series.id)).toEqual([
      "character-range-base", "character-range-spread", "character-average",
      "player-range-base", "player-range-spread", "player-average",
    ]);
    expect(bucketedSeries[2]?.smooth).toBe(true);
    expect(bucketedSeries[5]?.smooth).toBe(true);
    expect(bucketedSeries.map((series) => series.symbol)).toEqual(["none", "none", "none", "none", "none", "circle"]);
    expect((bucketedSeries[5] as { data: Array<[number, number | null]> }).data.map(([, value]) => value)).toEqual([613, null]);
    expect(bucketedOptions.yAxis.min).toBe(0);
    expect(bucketedOptions.legend.selectedMode).toBe(false);
    expect(module.buildTimelineOptions([{ date: new Date(Date.UTC(2026, 3, 25)), characterCount: 0, playerCount: 0 }]).yAxis.max).toBeUndefined();
  });

  it("shows a timeline symbol only when a series has one data point", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    module.testApi.setCurrentRangeForTest("7d");
    const singlePointOptions = module.buildTimelineOptions([
      { date: new Date(Date.UTC(2026, 3, 25)), characterCount: 0, playerCount: 0 },
    ]);
    expect(singlePointOptions.series.map((series: { symbol?: string }) => series.symbol)).toEqual(["circle", "circle"]);

    const singlePlayerPointOptions = module.buildTimelineOptions([
      { date: new Date(Date.UTC(2026, 3, 24)), characterCount: 1200 },
      { date: new Date(Date.UTC(2026, 3, 25)), characterCount: 1300, playerCount: 600 },
    ]);
    expect(singlePlayerPointOptions.series.map((series: { symbol?: string }) => series.symbol)).toEqual(["none", "circle"]);
  });

  it("switches heatmap and distribution to player samples and resets each view to characters", async () => {
    const { module } = await loadAppModule();
    const points = [
      { date: new Date(2026, 0, 1, 0), characterCount: 1200, playerCount: 600 },
      { date: new Date(2026, 0, 1, 1), characterCount: 1400 },
    ];

    module.testApi.selectChart("heatmap");
    expect(module.testApi.getChartStateForTest()).toEqual({ activeChart: "heatmap", activeMetric: "characters", metricToggleHidden: false });
    module.testApi.selectMetric("players");
    const heatmap = module.buildHeatmapOptions(points);
    expect(heatmap.series[0]?.data).toHaveLength(1);
    expect(heatmap.series[0]?.data[0]?.[3]).toBe(600);
    expect(heatmap.series[0]?.data[0]?.[2]).toBe(12);

    module.testApi.selectChart("distribution");
    expect(module.testApi.getChartStateForTest()).toEqual({ activeChart: "distribution", activeMetric: "characters", metricToggleHidden: false });
    module.testApi.selectMetric("players");
    const distribution = module.buildDistributionOptions(points);
    expect(distribution.xAxis.data).toEqual(["0-99", "100-199", "200-299", "300-399", "400-499", "500-599", "600-600"]);
    expect(distribution.series[0]?.itemStyle.color).toBe("#55b6e8");

    const emptyHeatmap = module.buildHeatmapOptions([{ date: new Date(2026, 0, 1, 0), characterCount: 1200 }]);
    expect(emptyHeatmap.graphic?.style.text).toBe("No player data");

    module.testApi.selectChart("timeline");
    expect(module.testApi.getChartStateForTest()).toEqual({ activeChart: "timeline", activeMetric: "characters", metricToggleHidden: true });
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
      { date: new Date(2024, 11, 29, 12), characterCount: 1200 },
      { date: new Date(2024, 11, 30, 12), characterCount: 1300 },
      { date: new Date(2025, 0, 4, 12), characterCount: 1100 },
      { date: new Date(2025, 0, 5, 12), characterCount: 1400 },
      { date: new Date(2025, 0, 6, 12), characterCount: 1500 },
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
      [1776945903, 1500, 750],
      [1776946203, null, 755],
    ]);
    expect(points.map((point) => point.characterCount)).toEqual([1832, 2125, 0, 1, 991, 1459, 1500]);
    expect(points.map((point) => point.playerCount)).toEqual([null, null, null, null, null, null, 750]);
  });

  it("summarizes players only from samples that include them", async () => {
    const { module } = await loadAppModule();
    expect(module.summarizePlayerCounts([
      { date: new Date(0), characterCount: 1000, playerCount: null },
      { date: new Date(1), characterCount: 1200, playerCount: 600 },
      { date: new Date(2), characterCount: 1400, playerCount: 700 },
    ])).toEqual({ peak: 700, average: 650 });

    const missing = module.summarizePlayerCounts([{ date: new Date(0), characterCount: 1000 }]);
    expect(Number.isNaN(missing.peak)).toBe(true);
    expect(Number.isNaN(missing.average)).toBe(true);
  });

  it("builds metric-card periods from endpoint coverage without rejecting internal gaps", async () => {
    const { module } = await loadAppModule();
    const latest = Date.UTC(2026, 6, 29, 12);
    const day = 24 * 60 * 60 * 1000;
    const snapshots = module.buildMetricSnapshots([
      { date: new Date(latest - 29 * day), characterCount: 100, playerCount: null },
      { date: new Date(latest - 7 * day), characterCount: 200, playerCount: 50 },
      { date: new Date(latest - day), characterCount: 300, playerCount: 60 },
      { date: new Date(latest), characterCount: 250, playerCount: 55 },
    ]);

    expect(snapshots.map((snapshot) => snapshot.period)).toEqual(["24h", "7d", "28d"]);
    expect(snapshots[0]).toMatchObject({
      peakCharacters: 300,
      averageCharacters: 275,
      peakPlayers: 60,
      averagePlayers: 57.5,
    });
    expect(Number.isNaN(snapshots[2].peakPlayers)).toBe(true);
    expect(Number.isNaN(snapshots[2].averagePlayers)).toBe(true);
  });

  it("requires player coverage at both range boundaries", async () => {
    const { module } = await loadAppModule();
    const latest = Date.UTC(2026, 6, 29, 12);
    const day = 24 * 60 * 60 * 1000;
    const [snapshot] = module.buildMetricSnapshots([
      { date: new Date(latest - 2 * day), characterCount: 100, playerCount: 50 },
      { date: new Date(latest - day), characterCount: 200, playerCount: 100 },
      { date: new Date(latest), characterCount: 300, playerCount: null },
    ]);

    expect(snapshot.period).toBe("24h");
    expect(Number.isNaN(snapshot.peakPlayers)).toBe(true);
    expect(Number.isNaN(snapshot.averagePlayers)).toBe(true);
  });

  it("advances both metric cards at the reel midpoint and wraps periods", async () => {
    vi.useFakeTimers();
    const { module } = await loadAppModule();
    const latest = Date.UTC(2026, 6, 29, 12);
    const day = 24 * 60 * 60 * 1000;
    const snapshots = module.buildMetricSnapshots([
      { date: new Date(latest - 8 * day), characterCount: 100, playerCount: 50 },
      { date: new Date(latest - day), characterCount: 300, playerCount: 150 },
      { date: new Date(latest), characterCount: 200, playerCount: 100 },
    ]);
    module.testApi.setMetricSnapshotsForTest(snapshots);

    expect(module.testApi.getMetricBoardStateForTest().activePeriod).toBe("24h");
    module.testApi.advanceMetricSnapshot();
    vi.advanceTimersByTime(249);
    expect(module.testApi.getMetricBoardStateForTest().activePeriod).toBe("24h");
    vi.advanceTimersByTime(1);
    expect(module.testApi.getMetricBoardStateForTest().activePeriod).toBe("7d");
    vi.advanceTimersByTime(250);
    module.testApi.advanceMetricSnapshot();
    vi.advanceTimersByTime(250);
    expect(module.testApi.getMetricBoardStateForTest().activePeriod).toBe("24h");
  });

  it("resumes the countdown from its remaining delay after hover pause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    const { module } = await loadAppModule();
    const latest = Date.UTC(2026, 6, 29, 12);
    const day = 24 * 60 * 60 * 1000;
    module.testApi.setMetricSnapshotsForTest(module.buildMetricSnapshots([
      { date: new Date(latest - 8 * day), characterCount: 100, playerCount: 50 },
      { date: new Date(latest), characterCount: 200, playerCount: 100 },
    ]));
    module.testApi.resetMetricRotationForTest();

    vi.advanceTimersByTime(2_000);
    module.testApi.setMetricBoardPaused("test-hover", true);
    vi.advanceTimersByTime(10_000);
    module.testApi.setMetricBoardPaused("test-hover", false);
    vi.advanceTimersByTime(3_999);
    expect(module.testApi.getMetricBoardStateForTest().activePeriod).toBe("24h");
    vi.advanceTimersByTime(251);
    expect(module.testApi.getMetricBoardStateForTest().activePeriod).toBe("7d");
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

  it("shows a dash instead of zero for missing tooltip values", async () => {
    const { module } = await loadAppModule();
    const options = module.buildTimelineOptions([
      { date: new Date(2026, 0, 1), characterCount: 1200, playerCount: null },
    ]);
    const formatter = options.tooltip.valueFormatter as (value: number | null) => number | string;

    expect(formatter(null)).toBe("-");
    expect(formatter(0)).toBe("0");
  });

  it("shows the last sample date as secondary metric content", () => {
    expect(indexHtml).toContain('id="last-sample-date" class="metric-secondary-value"');
  });

  it("spreads heatmap colors across high-population averages", async () => {
    const { module, globals } = await loadAppModule();
    useWindow(globals);
    module.testApi.setCurrentRangeForTest("7d");
    const options = module.buildHeatmapOptions([
      { date: new Date(2026, 0, 1, 0), characterCount: 2000 },
      { date: new Date(2026, 0, 1, 1), characterCount: 2200 },
      { date: new Date(2026, 0, 1, 2), characterCount: 2400 },
      { date: new Date(2026, 0, 1, 3), characterCount: 2600 },
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
      fetch: mockFetch({ usercount: 1700, uniquecount: 850 }),
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

describe("stats loader archive schema", () => {
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
      if (url === `/assets/stats/${newest.file}`) return { schemaVersion: 3, period: newest.period, timestampBase: 1782863104, data: [[0, 10]] };
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
      if (url === `/assets/stats/${older.file}`) return { schemaVersion: 3, period: older.period, timestampBase: 1704067200, data: [[0, 1]] };
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

  it("decodes schema v3 timestamp and independent nullable count deltas", async () => {
    const { module } = await loadStatsModule();
    const newest = {
      ...makeChunk("2026-06", 1782863104, 1782863404),
      rowCount: 4,
    };
    const fetcher = vi.fn(async () => ({
      schemaVersion: 3,
      period: "2026-06",
      timestampBase: 1782863104,
      data: [[0, 10, 5], [100, null, 2], [100, -3, null], [100, 1, -1]],
    }));
    const result = await module.loadInitialStatsHistory({
      manifest: makeManifest([newest]),
      fetcher: async (url: string) => url.startsWith("/api/") ? [] : fetcher(),
      normalizePayload: normalize,
    });
    expect(result.points).toEqual([
      [1782863104, 10, 5],
      [1782863204, null, 7],
      [1782863304, 7],
      [1782863404, 8, 6],
    ]);
  });

  it("rejects malformed schema v3 bases, deltas, overflow, and schema mismatches", async () => {
    const { module } = await loadStatsModule();
    const entry = makeChunk("2026-06", 1782863104);
    expect(() => module.validateChunk({
      schemaVersion: 3, period: "2026-06", timestampBase: -1, data: [[0, 10]],
    }, entry)).toThrow("invalid timestamp base");
    expect(() => module.validateChunk({
      schemaVersion: 3, period: "2026-06", timestampBase: 1782863104, data: [[1, 10]],
    }, entry)).toThrow("invalid encoded deltas");
    for (const delta of [0, -1, 1.5]) {
      expect(() => module.validateChunk({
        schemaVersion: 3,
        period: "2026-06",
        timestampBase: 1782863104,
        data: [[0, 10], [delta, 11]],
      }, { ...entry, rowCount: 2 })).toThrow("invalid encoded deltas");
    }
    for (const countDelta of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => module.validateChunk({
        schemaVersion: 3,
        period: "2026-06",
        timestampBase: 1782863104,
        data: [[0, countDelta]],
      }, entry)).toThrow("invalid encoded deltas");
    }
    expect(() => module.validateChunk({
      schemaVersion: 3, period: "2026-06", timestampBase: 1782863104, data: [[0, -1]],
    }, entry)).toThrow("invalid decoded usercount");
    expect(() => module.validateChunk({
      schemaVersion: 3,
      period: "2026-06",
      timestampBase: 1782863104,
      data: [[0, Number.MAX_SAFE_INTEGER], [1, 1]],
    }, { ...entry, maxTimestamp: 1782863105, rowCount: 2 })).toThrow("invalid decoded usercount");
    expect(() => module.validateChunk({
      schemaVersion: 3, period: "2026-06", timestampBase: 1782863104, data: [[0, 0, -1]],
    }, entry)).toThrow("invalid decoded uniquecount");
    expect(() => module.validateChunk({
      schemaVersion: 3,
      period: "2026-06",
      timestampBase: 1782863104,
      data: [[0, 0, Number.MAX_SAFE_INTEGER], [1, 0, 1]],
    }, { ...entry, maxTimestamp: 1782863105, rowCount: 2 })).toThrow("invalid decoded uniquecount");
    expect(() => module.validateChunk({
      schemaVersion: 3, period: "2026-06", timestampBase: Number.MAX_SAFE_INTEGER, data: [[0, 10], [1, 11]],
    }, { ...entry, rowCount: 2 })).toThrow("timestamp overflow");
    expect(() => module.validateChunk({
      schemaVersion: 2, period: "2026-06", data: [[1782863104, 10]],
    }, entry)).toThrow("must use schemaVersion 3");
  });

  it("supports an empty archive and rejects unsupported manifests and chunks", async () => {
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
    })).rejects.toThrow("schemaVersion 3");
    await expect(module.loadInitialStatsHistory({
      manifest: { ...makeManifest([]), schemaVersion: 2 } as never,
      fetcher: async () => [],
      normalizePayload: normalize,
    })).rejects.toThrow("schemaVersion 3");

    const newest = makeChunk("2026-06", 1782863104);
    await expect(module.loadInitialStatsHistory({
      manifest: makeManifest([newest]),
      fetcher: async (url: string) => url.startsWith("/api/") ? [] : { period: newest.period, data: [[1782863104, 10]] },
      normalizePayload: normalize,
    })).rejects.toThrow("schemaVersion 3");
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
    expect(publicManifest.schemaVersion).toBe(3);
    for (const chunk of publicManifest.chunks as StatsManifestChunk[]) {
      const payload = JSON.parse(fs.readFileSync(path.join(repoRoot, "public/assets/stats", chunk.file), "utf8"));
      expect(module.validateChunk(payload, chunk)).toHaveProperty("data");
    }
  });
});
