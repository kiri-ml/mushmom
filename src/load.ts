/// <reference path="./globals.d.ts" />

import bundledManifest from "./assets/stats/manifests.json";
import { currentUtcMonthKey, isMonthKey, monthKeysAfter } from "./stats-months";

const DEFAULT_STATS_API_BASE_URL = "/api/stats/";
const DEFAULT_ARCHIVE_BASE_URL = "/assets/stats/";
const MANIFEST_KEYS = ["schemaVersion", "dataset", "archiveThroughPeriod", "format", "chunks"];
const FORMAT_KEYS = ["rowShape", "timestampUnit", "order"];
const ENTRY_KEYS = ["period", "granularity", "file", "minTimestamp", "maxTimestamp", "rowCount"];
const CHUNK_KEYS = ["schemaVersion", "period", "data"];

type HistoryFetcher = (url: string) => Promise<unknown>;
type NormalizePayload<TPoint> = (payload: StatsPayload) => TPoint[];

interface ArchiveFetchOptions<TPoint> {
  archiveBaseUrl: string;
  fetcher: HistoryFetcher;
  normalizePayload: NormalizePayload<TPoint>;
}

interface LoadArchiveChunksOptions<TPoint> extends ArchiveFetchOptions<TPoint> {
  recentPayload: StatsPayload;
  manifest: StatsManifest;
  onArchive?: (payload: ArchiveStatsHistoryResult<TPoint>) => void;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} request failed: ${response.status}`);
  return response.json();
}

async function loadInitialStatsHistory<TPoint>(options: LoadInitialStatsHistoryOptions<TPoint>): Promise<InitialStatsHistoryResult<TPoint>> {
  const archiveBaseUrl = options.archiveBaseUrl ?? DEFAULT_ARCHIVE_BASE_URL;
  const statsApiBaseUrl = options.statsApiBaseUrl ?? DEFAULT_STATS_API_BASE_URL;
  const manifest = validateManifest(options.manifest ?? bundledManifest);
  const fetcher = options.fetcher ?? fetchJson;
  const newest = manifest.chunks[0];
  const [recentPayload, newestPoints] = await Promise.all([
    loadRecentPayload({ statsApiBaseUrl, manifest, fetcher }),
    newest ? loadArchiveChunk({ archiveBaseUrl, fetcher, normalizePayload: options.normalizePayload }, newest) : Promise.resolve([]),
  ]);
  const points = [...newestPoints, ...options.normalizePayload(recentPayload)];
  if (points.length === 0) throw new Error("Stats history contained no usable points.");
  const result = { points, recentPayload, manifest };
  options.onInitial?.(result);
  return result;
}

async function loadArchiveStatsHistory<TPoint>(options: LoadArchiveStatsHistoryOptions<TPoint>): Promise<ArchiveStatsHistoryResult<TPoint>> {
  const manifest = validateManifest(options.manifest);
  return loadArchiveChunks({
    archiveBaseUrl: options.archiveBaseUrl ?? DEFAULT_ARCHIVE_BASE_URL,
    fetcher: options.fetcher ?? fetchJson,
    recentPayload: options.recentPayload,
    manifest,
    normalizePayload: options.normalizePayload,
    onArchive: options.onArchive,
  }).catch((error: unknown) => { console.warn(error); throw error; });
}

async function loadStatsHistory<TPoint>(options: LoadStatsHistoryOptions<TPoint>): Promise<void> {
  const initial = await loadInitialStatsHistory(options);
  await loadArchiveStatsHistory({
    archiveBaseUrl: options.archiveBaseUrl,
    fetcher: options.fetcher,
    recentPayload: initial.recentPayload,
    manifest: initial.manifest,
    normalizePayload: options.normalizePayload,
    onArchive: options.onArchive,
  });
}

async function loadArchiveChunks<TPoint>(options: LoadArchiveChunksOptions<TPoint>): Promise<ArchiveStatsHistoryResult<TPoint>> {
  const chunks = selectValidatedArchiveChunks(options.manifest, options.recentPayload);
  const points = chunks.length === 0
    ? []
    : (await Promise.all(chunks.map((chunk) => loadArchiveChunk(options, chunk)))).flat();
  const result = { points, chunks };
  options.onArchive?.(result);
  return result;
}

async function loadRecentPayload(options: { statsApiBaseUrl: string; manifest: StatsManifest; fetcher: HistoryFetcher }): Promise<RawPayloadRow[]> {
  const months = monthKeysAfter(options.manifest.archiveThroughPeriod, currentUtcMonthKey());
  const payloads = await Promise.all(months.map(async (month) => {
    const payload = await options.fetcher(statsMonthPath(options.statsApiBaseUrl, month));
    if (!Array.isArray(payload)) throw new Error(`Monthly stats response for ${month} was not an array.`);
    return payload as RawPayloadRow[];
  }));
  return payloads.flat();
}

function selectArchiveChunks(manifestInput: StatsManifest, recentPayload: StatsPayload): StatsManifestChunk[] {
  const manifest = validateManifest(manifestInput);
  return selectValidatedArchiveChunks(manifest, recentPayload);
}

function selectValidatedArchiveChunks(manifest: StatsManifest, recentPayload: StatsPayload): StatsManifestChunk[] {
  const remaining = manifest.chunks.slice(1);
  const oldestRecent = oldestPayloadTimestamp(recentPayload);
  return Number.isFinite(oldestRecent)
    ? remaining.filter((chunk) => chunk.maxTimestamp < oldestRecent)
    : remaining;
}

async function loadArchiveChunk<TPoint>(options: ArchiveFetchOptions<TPoint>, entry: StatsManifestChunk): Promise<TPoint[]> {
  const payload = await options.fetcher(archivePath(options.archiveBaseUrl, entry.file));
  return options.normalizePayload(validateChunk(payload, entry));
}

function validateManifest(value: unknown): StatsManifest {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new Error("Stats manifest must use schemaVersion 2.");
  }
  requireExactKeys(value, MANIFEST_KEYS, "Stats manifest");
  if (value.dataset !== "maplelegends-online-users" || !isMonthKey(value.archiveThroughPeriod)) {
    throw new Error("Stats manifest has an invalid dataset or archiveThroughPeriod.");
  }
  const archiveThroughPeriod = value.archiveThroughPeriod;
  if (!isRecord(value.format)) throw new Error("Stats manifest has an invalid format.");
  requireExactKeys(value.format, FORMAT_KEYS, "Stats manifest format");
  if (!Array.isArray(value.format.rowShape) || value.format.rowShape.length !== 2
    || value.format.rowShape[0] !== "epochSeconds" || value.format.rowShape[1] !== "usercount"
    || value.format.timestampUnit !== "seconds" || value.format.order !== "ascending") {
    throw new Error("Stats manifest has an invalid format.");
  }
  if (!Array.isArray(value.chunks)) throw new Error("Stats manifest chunks must be an array.");
  let previous: StatsManifestChunk | undefined;
  const chunks = value.chunks.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Stats manifest chunk ${index + 1} is invalid.`);
    requireExactKeys(entry, ENTRY_KEYS, `Stats manifest chunk ${index + 1}`);
    const granularity = entry.granularity;
    const periodValid = granularity === "month"
      ? isMonthKey(entry.period)
      : granularity === "year" && /^\d{4}$/.test(String(entry.period));
    if (!periodValid || typeof entry.file !== "string"
      || !new RegExp(`^${entry.period}\\.[A-Za-z0-9_-]{8}\\.json$`).test(entry.file)
      || !isNonnegativeInteger(entry.minTimestamp) || !isNonnegativeInteger(entry.maxTimestamp)
      || !Number.isInteger(entry.rowCount) || Number(entry.rowCount) <= 0 || entry.minTimestamp > entry.maxTimestamp) {
      throw new Error(`Stats manifest chunk ${index + 1} is invalid.`);
    }
    const chunk = entry as unknown as StatsManifestChunk;
    const timestampLength = chunk.granularity === "year" ? 4 : 7;
    const boundsMatchPeriod = [chunk.minTimestamp, chunk.maxTimestamp].every((timestamp) => (
      periodForTimestamp(timestamp, timestampLength) === chunk.period
    ));
    if (!boundsMatchPeriod) {
      throw new Error(`Stats manifest chunk ${index + 1} has invalid bounds.`);
    }
    if (chunk.period > archiveThroughPeriod || (previous && (previous.period <= chunk.period || previous.minTimestamp <= chunk.maxTimestamp))) {
      throw new Error("Stats manifest chunks must be newest-first and non-overlapping.");
    }
    previous = chunk;
    return chunk;
  });
  return { ...value, format: value.format, chunks } as unknown as StatsManifest;
}

function validateManifestPartition(value: unknown): StatsManifest {
  const manifest = validateManifest(value);
  const horizon = parseMonthKey(manifest.archiveThroughPeriod);
  if (!horizon) throw new Error("Stats manifest has an invalid archiveThroughPeriod.");
  manifest.chunks.forEach((chunk, index) => {
    const expectedGranularity = isMonthlyArchivePeriod(chunk.period, horizon) ? "month" : "year";
    if (chunk.granularity !== expectedGranularity) {
      throw new Error(`Stats manifest chunk ${index + 1} has invalid partitioning.`);
    }
  });
  return manifest;
}

function validateChunk(value: unknown, entry: StatsManifestChunk): StatsPayload {
  if (!isRecord(value) || value.schemaVersion !== 2) throw new Error(`Stats chunk ${entry.file} must use schemaVersion 2.`);
  requireExactKeys(value, CHUNK_KEYS, `Stats chunk ${entry.file}`);
  if (value.period !== entry.period || !Array.isArray(value.data) || value.data.length !== entry.rowCount) {
    throw new Error(`Stats chunk ${entry.file} does not match its manifest entry.`);
  }
  let previous = -1;
  for (const row of value.data) {
    if (!Array.isArray(row) || row.length !== 2 || !isNonnegativeInteger(row[0]) || !isNonnegativeInteger(row[1]) || row[0] <= previous) {
      throw new Error(`Stats chunk ${entry.file} contains invalid or unordered rows.`);
    }
    const rowPeriod = periodForTimestamp(row[0], entry.granularity === "year" ? 4 : 7);
    if (rowPeriod !== entry.period) throw new Error(`Stats chunk ${entry.file} contains a row outside its period.`);
    previous = row[0];
  }
  if (value.data[0]?.[0] !== entry.minTimestamp || value.data.at(-1)?.[0] !== entry.maxTimestamp) {
    throw new Error(`Stats chunk ${entry.file} bounds do not match its manifest entry.`);
  }
  return value as StatsPayload;
}

function requireExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function parseMonthKey(month: string): { year: number; month: number } | null {
  if (!isMonthKey(month)) return null;
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}
function isMonthlyArchivePeriod(period: string, horizon: { year: number; month: number }): boolean {
  const parsed = parseMonthKey(period);
  if (!parsed) return false;
  if (parsed.year === horizon.year) return parsed.month <= horizon.month;
  return horizon.month === 1 && parsed.year === horizon.year - 1;
}
function periodForTimestamp(timestamp: number, length: 4 | 7): string | null {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, length);
}
function absoluteUrl(path: string): URL { return new URL(path, window.location.origin); }
function statsMonthPath(baseUrl: string, month: string): string {
  const base = absoluteUrl(baseUrl); base.search = ""; base.hash = "";
  base.pathname = `${base.pathname.replace(/\/?$/, "/")}${month}`;
  return base.pathname;
}
function archivePath(baseUrl: string, file: string): string { return new URL(file, absoluteUrl(baseUrl)).pathname; }

function oldestPayloadTimestamp(payload: StatsPayload): number {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [];
  const timestamps = rows.map(rowTimestamp).filter(Number.isFinite);
  return timestamps.length ? Math.min(...timestamps) : Number.NaN;
}

function rowTimestamp(row: RawPayloadRow): number {
  const value = Array.isArray(row) ? row[0] : row.timestamp ?? row.time ?? row.created_at ?? row.date;
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return rowTimestamp([Number(value), 0]);
  if (!value) return Number.NaN;
  const date = new Date(String(value).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? Number.NaN : Math.floor(date.getTime() / 1000);
}

const MushmomStatsLoader = { loadStatsHistory, loadInitialStatsHistory, loadArchiveStatsHistory, selectArchiveChunks, oldestPayloadTimestamp };
window.MushmomStatsLoader = MushmomStatsLoader;

export { MushmomStatsLoader, loadStatsHistory, loadInitialStatsHistory, loadArchiveStatsHistory, selectArchiveChunks, oldestPayloadTimestamp, rowTimestamp, validateManifest, validateManifestPartition, validateChunk };
