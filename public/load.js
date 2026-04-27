(function () {
  const DEFAULT_LATEST_URL = "/api/stats/latest";
  const DEFAULT_MANIFEST_URL = "/assets/stats/manifests.json";
  const DEFAULT_ARCHIVE_BASE_URL = "/assets/stats/";

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${url} request failed: ${response.status}`);

    return response.json();
  }

  async function loadStatsHistory(options = {}) {
    const {
      latestUrl = DEFAULT_LATEST_URL,
      manifestUrl = DEFAULT_MANIFEST_URL,
      archiveBaseUrl = DEFAULT_ARCHIVE_BASE_URL,
      normalizePayload,
      onInitial,
      onArchive,
      fetcher = fetchJson,
    } = options;

    if (typeof normalizePayload !== "function") {
      throw new Error("loadStatsHistory requires normalizePayload.");
    }

    const [latestPayload, manifest] = await Promise.all([
      fetcher(latestUrl),
      fetcher(manifestUrl),
    ]);
    const latestPoints = normalizePayload(latestPayload);

    if (latestPoints.length === 0) {
      throw new Error("Latest stats response contained no usable points.");
    }

    onInitial?.({
      points: latestPoints,
      latestPayload,
      manifest,
    });

    return loadArchiveChunks({
      archiveBaseUrl,
      fetcher,
      latestPayload,
      manifest,
      normalizePayload,
      onArchive,
    }).catch((error) => {
      console.warn(error);
      throw error;
    });
  }

  async function loadArchiveChunks(options) {
    const {
      archiveBaseUrl,
      fetcher,
      latestPayload,
      manifest,
      normalizePayload,
      onArchive,
    } = options;
    const chunks = selectArchiveChunks(manifest, latestPayload);

    if (chunks.length === 0) {
      onArchive?.({ points: [], chunks });
      return;
    }

    const payloads = await Promise.all(
      chunks.map((chunk) => fetcher(new URL(chunk.file, absoluteUrl(archiveBaseUrl)).pathname)),
    );
    const points = payloads.flatMap((payload) => normalizePayload(payload));

    onArchive?.({ points, chunks });
  }

  function absoluteUrl(path) {
    return new URL(path, window.location.origin);
  }

  function selectArchiveChunks(manifest, latestPayload) {
    const chunks = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
    const oldestLatest = oldestPayloadTimestamp(latestPayload);

    if (!Number.isFinite(oldestLatest)) return chunks;

    return chunks.filter((chunk) => Number(chunk.end) < oldestLatest);
  }

  function oldestPayloadTimestamp(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    const timestamps = rows
      .map(rowTimestamp)
      .filter((timestamp) => Number.isFinite(timestamp));

    return timestamps.length > 0 ? Math.min(...timestamps) : Number.NaN;
  }

  function rowTimestamp(row) {
    const value = Array.isArray(row)
      ? row[0]
      : row?.timestamp ?? row?.time ?? row?.created_at ?? row?.date;

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

  function parseTimestamp(value) {
    if (!value) return null;

    const normalized = String(value)
      .trim()
      .replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00");
    const date = new Date(normalized);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  globalThis.MushmomStatsLoader = {
    loadStatsHistory,
    selectArchiveChunks,
    oldestPayloadTimestamp,
  };
})();
