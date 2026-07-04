/// <reference path="./globals.d.ts" />

import bundledManifest from "./assets/stats/manifests.json";
import { currentUtcMonthKey, isMonthKey, monthKeysAfter } from "./stats-months";

const DEFAULT_STATS_API_BASE_URL = "/api/stats/";
const DEFAULT_ARCHIVE_BASE_URL = "/assets/stats/";

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
  const {
    archiveBaseUrl = DEFAULT_ARCHIVE_BASE_URL,
    statsApiBaseUrl = DEFAULT_STATS_API_BASE_URL,
    manifest = bundledManifest as StatsManifest,
    normalizePayload,
    onInitial,
    fetcher = fetchJson,
  } = options;

  const [recentPayload, initialArchivePoints] = await Promise.all([
    loadRecentPayload({ statsApiBaseUrl, manifest, fetcher }),
    loadInitialArchive({ archiveBaseUrl, fetcher, manifest, normalizePayload }),
  ]);
  const recentPoints = normalizePayload(recentPayload);
  const points = [...initialArchivePoints, ...recentPoints];

  if (points.length === 0) {
    throw new Error("Stats history contained no usable points.");
  }

  const result = { points, recentPayload, manifest };
  onInitial?.(result);

  return result;
}

async function loadArchiveStatsHistory<TPoint>(options: LoadArchiveStatsHistoryOptions<TPoint>): Promise<ArchiveStatsHistoryResult<TPoint>> {
  const {
    archiveBaseUrl = DEFAULT_ARCHIVE_BASE_URL,
    fetcher = fetchJson,
    recentPayload,
    manifest,
    normalizePayload,
    onArchive,
  } = options;

  return loadArchiveChunks({
    archiveBaseUrl,
    fetcher,
    recentPayload,
    manifest,
    normalizePayload,
    onArchive,
  }).catch((error: unknown) => {
    console.warn(error);
    throw error;
  });
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
  const { recentPayload, manifest, onArchive } = options;
  const chunks = selectArchiveChunks(manifest, recentPayload);

  if (chunks.length === 0) {
    const result = { points: [], chunks };
    onArchive?.(result);
    return result;
  }

  const points = (await Promise.all(chunks.map((chunk) => loadArchiveChunk(options, chunk)))).flat();
  const result = { points, chunks };

  onArchive?.(result);
  return result;
}

function absoluteUrl(path: string): URL {
  return new URL(path, window.location.origin);
}

function initialArchivePeriod(manifest: StatsManifest): string {
  const period = manifest?.initial?.period;
  if (!isMonthKey(period)) {
    throw new Error("Bundled stats manifest is missing a valid initial.period value.");
  }
  return period;
}

function statsMonthPath(statsApiBaseUrl: string, month: string): string {
  const base = absoluteUrl(statsApiBaseUrl);
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/?$/, "/")}${month}`;
  return base.pathname;
}

async function loadRecentPayload(options: {
  statsApiBaseUrl: string;
  manifest: StatsManifest;
  fetcher: HistoryFetcher;
}): Promise<RawPayloadRow[]> {
  const { statsApiBaseUrl, manifest, fetcher } = options;
  const months = monthKeysAfter(initialArchivePeriod(manifest), currentUtcMonthKey());
  const payloads = await Promise.all(months.map(async (month) => {
    const payload = await fetcher(statsMonthPath(statsApiBaseUrl, month));
    if (!Array.isArray(payload)) {
      throw new Error(`Monthly stats response for ${month} was not an array.`);
    }
    return payload as RawPayloadRow[];
  }));
  return payloads.flat();
}

function selectArchiveChunks(manifest: StatsManifest, recentPayload: StatsPayload): StatsManifestChunk[] {
  const chunks = Array.isArray(manifest?.backfill) ? manifest.backfill : [];
  const oldestRecent = oldestPayloadTimestamp(recentPayload);

  if (!Number.isFinite(oldestRecent)) return chunks;

  return chunks.filter((chunk) => Number(chunk.end) < oldestRecent);
}

async function loadInitialArchive<TPoint>(options: ArchiveFetchOptions<TPoint> & {
  manifest: StatsManifest;
}): Promise<TPoint[]> {
  const { manifest } = options;
  const initial = manifest?.initial;
  if (!initial?.file) return [];

  return loadArchiveChunk(options, initial);
}

async function loadArchiveChunk<TPoint>(
  options: ArchiveFetchOptions<TPoint>,
  chunk: StatsManifestChunk,
): Promise<TPoint[]> {
  const { archiveBaseUrl, fetcher, normalizePayload } = options;
  const payload = await fetcher(archivePath(archiveBaseUrl, chunk.file));
  return normalizePayload(payload as StatsPayload);
}

function archivePath(archiveBaseUrl: string, file: string): string {
  return new URL(file, absoluteUrl(archiveBaseUrl)).pathname;
}

function oldestPayloadTimestamp(payload: StatsPayload): number {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : [];
  const timestamps = rows
    .map(rowTimestamp)
    .filter((timestamp): timestamp is number => Number.isFinite(timestamp));

  return timestamps.length > 0 ? Math.min(...timestamps) : Number.NaN;
}

function rowTimestamp(row: RawPayloadRow): number {
  const value = Array.isArray(row)
    ? row[0]
    : row.timestamp ?? row.time ?? row.created_at ?? row.date;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const number = Number(value);
    return number > 1e12 ? Math.floor(number / 1000) : number;
  }

  const date = parseTimestamp(value);
  return date ? Math.floor(date.getTime() / 1000) : Number.NaN;
}

function parseTimestamp(value: unknown): Date | null {
  if (!value) return null;

  const normalized = String(value)
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

const MushmomStatsLoader = {
  loadStatsHistory,
  loadInitialStatsHistory,
  loadArchiveStatsHistory,
  selectArchiveChunks,
  oldestPayloadTimestamp,
};

window.MushmomStatsLoader = MushmomStatsLoader;

export {
  MushmomStatsLoader,
  loadStatsHistory,
  loadInitialStatsHistory,
  loadArchiveStatsHistory,
  selectArchiveChunks,
  oldestPayloadTimestamp,
  rowTimestamp,
};
