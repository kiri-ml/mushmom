/// <reference path="./globals.d.ts" />

import bundledManifest from "../public/assets/stats/manifests.json";

const DEFAULT_LATEST_URL = "/api/stats/latest";
const DEFAULT_ARCHIVE_BASE_URL = "/assets/stats/";

type HistoryFetcher = (url: string) => Promise<unknown>;
type NormalizePayload<TPoint> = (payload: StatsPayload) => TPoint[];

interface ArchiveFetchOptions<TPoint> {
  archiveBaseUrl: string;
  fetcher: HistoryFetcher;
  normalizePayload: NormalizePayload<TPoint>;
}

interface LoadArchiveChunksOptions<TPoint> extends ArchiveFetchOptions<TPoint> {
  latestPayload: StatsPayload;
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
    latestUrl = DEFAULT_LATEST_URL,
    manifest = bundledManifest as StatsManifest,
    normalizePayload,
    onInitial,
    fetcher = fetchJson,
  } = options;

  const latestPayloadRaw = await fetcher(buildLatestUrl(latestUrl, manifest));
  const latestPayload = latestPayloadRaw as StatsPayload;
  const latestPoints = normalizePayload(latestPayload);

  if (latestPoints.length === 0) {
    throw new Error("Latest stats response contained no usable points.");
  }

  const initialArchivePoints = await loadInitialArchive({
    archiveBaseUrl,
    fetcher,
    manifest,
    normalizePayload,
  });
  const result = { points: [...initialArchivePoints, ...latestPoints], latestPayload, manifest };
  onInitial?.(result);

  return result;
}

async function loadArchiveStatsHistory<TPoint>(options: LoadArchiveStatsHistoryOptions<TPoint>): Promise<ArchiveStatsHistoryResult<TPoint>> {
  const {
    archiveBaseUrl = DEFAULT_ARCHIVE_BASE_URL,
    fetcher = fetchJson,
    latestPayload,
    manifest,
    normalizePayload,
    onArchive,
  } = options;

  return loadArchiveChunks({
    archiveBaseUrl,
    fetcher,
    latestPayload,
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
    latestPayload: initial.latestPayload,
    manifest: initial.manifest,
    normalizePayload: options.normalizePayload,
    onArchive: options.onArchive,
  });
}

async function loadArchiveChunks<TPoint>(options: LoadArchiveChunksOptions<TPoint>): Promise<ArchiveStatsHistoryResult<TPoint>> {
  const { latestPayload, manifest, onArchive } = options;
  const chunks = selectArchiveChunks(manifest, latestPayload);

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

function buildLatestUrl(latestUrl: string, manifest: StatsManifest): string {
  const after = initialArchiveEnd(manifest);
  if (!Number.isFinite(after)) {
    throw new Error("Bundled stats manifest is missing a valid initial.end value.");
  }

  const url = absoluteUrl(latestUrl);
  url.search = "";
  url.searchParams.set("after", String(after));
  return url.pathname + url.search;
}

function initialArchiveEnd(manifest: StatsManifest): number {
  return Number(manifest?.initial?.end);
}

function selectArchiveChunks(manifest: StatsManifest, latestPayload: StatsPayload): StatsManifestChunk[] {
  const chunks = Array.isArray(manifest?.backfill) ? manifest.backfill : [];
  const oldestLatest = oldestPayloadTimestamp(latestPayload);

  if (!Number.isFinite(oldestLatest)) return chunks;

  return chunks.filter((chunk) => Number(chunk.end) < oldestLatest);
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
