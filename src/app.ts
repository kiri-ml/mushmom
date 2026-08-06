/// <reference path="./globals.d.ts" />

type ChartRange = "24h" | "7d" | "28d" | "90d" | "180d" | "ytd" | "1y" | "3y" | "all";
type ChartKind = "timeline" | "heatmap" | "distribution";
type ChartMetric = "characters" | "players";
type BucketUnit = "hour" | "day" | "week";
type MetricPeriod = "24h" | "7d" | "28d" | "90d";

type MetricElementKey = "currentCharacters" | "currentPlayers" | "peakPeriod" | "peakCharacters" | "peakPlayers" | "averagePeriod" | "averageCharacters" | "averagePlayers" | "lastSample" | "lastSampleDate" | "sampleCount" | "rangeLabel" | "sourceLabel";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const FIXED_RANGE_DURATION_MS: Record<Exclude<ChartRange, "all" | "ytd">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "28d": 28 * DAY_MS,
  "90d": 90 * DAY_MS,
  "180d": 180 * DAY_MS,
  "1y": 365 * DAY_MS,
  "3y": 3 * 365 * DAY_MS,
};

interface HistoricalSource {
  name: string;
  url: string | null;
}

interface StatsLoadStatus {
  kind: "loading" | "ready" | "failed";
  key: string;
  params: Record<string, string | number>;
}

interface TimelineConfig {
  labelKey: string;
  bucketKey?: string;
  unit?: BucketUnit;
  size?: number;
}

interface DistributionBucket {
  label: string;
  count: number;
}

interface BucketSummary {
  time: number;
  min: number;
  max: number;
  avg: number;
  samples: number;
}

interface BucketAccumulator extends BucketSummary {
  total: number;
}

interface MetricSnapshot {
  period: MetricPeriod;
  peakCharacters: number;
  averageCharacters: number;
  peakPlayers: number;
  averagePlayers: number;
}

const chartElement = requireElement("#population-chart");
const rangeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-range]"));
const chartButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-chart]"));
const metricButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-metric]"));
const metricToggle = requireElement("#metric-toggle");
const statsLoadStatusDot = requireElement("#stats-load-status-dot");
const statsLoadStatusText = requireElement("#stats-load-status-text");
const HEATMAP_VISUAL_MIN = 0;
const HEATMAP_VISUAL_MAX = 100;
const HEATMAP_OUTOFRANGE_COLOR = "#131617";
const HEATMAP_COLORS = [
  "#102a43",
  "#1e6091",
  "#2fbf71",
  "#f4d44d",
  "#f4a340",
  "#e84a4a",
  "#c62828",
];
const DISTRIBUTION_BAR_COLOR = "#f1c44f";
const PLAYER_COLOR = "#55b6e8";
const PLAYER_RANGE_COLOR = "rgba(85, 182, 232, 0.18)";
const CHART_AXIS_COLOR = "rgba(169, 177, 173, 0.2)";
const CHART_GRID_COLOR = "rgba(169, 177, 173, 0.09)";
const CHART_LABEL_COLOR = "#929b97";
const CHART_TOOLTIP_BACKGROUND = "#1a1f20";
const CHART_TOOLTIP_BORDER = "rgba(169, 177, 173, 0.2)";
const DISTRIBUTION_STEP = 100;
const KNOWN_BAD_GAP_START = Date.parse("2020-06-15T15:30:55.664Z");
const KNOWN_BAD_GAP_END = Date.parse("2020-06-22T01:00:00.528Z");

const elements: Record<MetricElementKey, HTMLElement> = {
  currentCharacters: requireElement("#current-character-count"),
  currentPlayers: requireElement("#current-player-count"),
  peakPeriod: requireElement("#peak-period-label"),
  peakCharacters: requireElement("#peak-character-count"),
  peakPlayers: requireElement("#peak-player-count"),
  averagePeriod: requireElement("#average-period-label"),
  averageCharacters: requireElement("#average-character-count"),
  averagePlayers: requireElement("#average-player-count"),
  lastSample: requireElement("#last-sample"),
  lastSampleDate: requireElement("#last-sample-date"),
  sampleCount: requireElement("#sample-count"),
  rangeLabel: requireElement("#range-label"),
  sourceLabel: requireElement("#source-label"),
};
const metricBoards = Array.from(document.querySelectorAll<HTMLElement>("[data-metric-board]"));
const metricRangeTickGroups = metricBoards.map((board) => (
  Array.from(board.querySelectorAll<HTMLElement>(".metric-card__range-ticks span"))
));
const METRIC_PERIODS: MetricPeriod[] = ["24h", "7d", "28d", "90d"];
const METRIC_ROTATION_MS = 6_000;
const METRIC_TRANSITION_MIDPOINT_MS = 250;
const METRIC_TRANSITION_DURATION_MS = 500;

let allPoints: StatsPoint[] = [];
let currentRange: ChartRange = "7d";
let activeChart: ChartKind = "timeline";
let activeMetric: ChartMetric = "characters";
let chart: EChartsInstance | null = null;
let historicalSource: HistoricalSource = { name: "Unknown", url: null };
let statsLoadStatus: StatsLoadStatus = { kind: "loading", key: "status.loading", params: {} };
let pendingRender = false;
let metricSnapshots: MetricSnapshot[] = [];
let activeMetricSnapshotIndex = 0;
let metricRotationTimer: ReturnType<typeof setTimeout> | null = null;
let metricRotationDeadline = 0;
let metricRotationRemainingMs = METRIC_ROTATION_MS;
let metricTransitionMidpointTimer: ReturnType<typeof setTimeout> | null = null;
let metricTransitionEndTimer: ReturnType<typeof setTimeout> | null = null;
const metricPauseReasons = new Set<string>();

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`${selector} element is required`);
  return element;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function toHeatmapScore(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (v <= 0) return 0;

  const anchors: Array<[number, number]> = [
    [0, 0], [600, 12], [800, 24], [1000, 36], [1200, 50],
    [1400, 62], [1600, 70], [1800, 76], [2000, 82],
    [2200, 88], [2400, 94], [2600, 98], [3000, 100],
  ];

  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (v <= x2) {
      const t = (v - x1) / (x2 - x1);
      return lerp(y1, y2, t);
    }
  }

  return 100;
}

function getWindowLike(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function whenAppReady(): Promise<unknown[]> {
  const windowLike = getWindowLike();
  return Promise.all([globalThis.__mushmomEchartsReady || Promise.resolve(), windowLike?.MushmomI18n?.ready || Promise.resolve()]);
}

function getI18n(): MushmomI18nApi | null {
  return getWindowLike()?.MushmomI18n || null;
}

function tr(key: string, params: Record<string, string | number> = {}): string {
  const i18n = getI18n();
  if (!i18n) return key;
  return i18n.t(key, params, i18n.getCurrentLang());
}

function getCurrentLocale(): string | undefined {
  const getCurrentLang = getI18n()?.getCurrentLang;
  return typeof getCurrentLang === "function" ? getCurrentLang() : undefined;
}

function formatLocaleNumber(value: number): string {
  return Number(value).toLocaleString(getCurrentLocale());
}

function parseTimestamp(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return parseTimestamp(Number(value));
  }

  const normalized = String(value).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isKnownBadPoint(point: StatsPoint): boolean {
  const time = point.date?.getTime();
  return !Number.isFinite(time) || (time >= KNOWN_BAD_GAP_START && time < KNOWN_BAD_GAP_END) || point.characterCount < 0;
}

function normalizePayload(payload: StatsPayload): StatsPoint[] {
  const rows: RawPayloadRow[] = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.values) ? payload.values : [];

  const normalized = rows
    .map((row): { timestamp: unknown; usercount: unknown; uniquecount: unknown } => {
      if (Array.isArray(row)) {
        return { timestamp: row[0], usercount: row[1], uniquecount: row[2] };
      }

      return {
        timestamp: row.timestamp ?? row.time ?? row.created_at ?? row.date,
        usercount: row.usercount ?? row.users ?? row.players ?? row.count,
        uniquecount: row.uniquecount,
      };
    })
    .map((row): { date: Date | null; characterCount: number; playerCount: number | null } => {
      const characterCount = row.usercount == null ? Number.NaN : Number(row.usercount);
      const playerCount = row.uniquecount == null ? Number.NaN : Number(row.uniquecount);
      return {
        date: parseTimestamp(row.timestamp),
        characterCount,
        playerCount: Number.isFinite(playerCount) && playerCount >= 0 ? playerCount : null,
      };
    })
    .filter((point): point is { date: Date; characterCount: number; playerCount: number | null } => point.date instanceof Date && Number.isFinite(point.characterCount))
    .filter((point) => !isKnownBadPoint(point))
    .map((point): StatsPoint => ({ date: truncateDateToSecond(point.date) as Date, characterCount: point.characterCount, playerCount: point.playerCount }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const byTimestamp = new Map<number, StatsPoint>();
  normalized.forEach((point) => byTimestamp.set(point.date.getTime(), point));
  return [...byTimestamp.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function truncateDateToSecond(date: Date | null): Date | null {
  return date ? new Date(Math.floor(date.getTime() / 1000) * 1000) : null;
}

function formatInteger(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString(getCurrentLocale()) : "--";
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function bucketDurationMs(config: { unit: BucketUnit; size: number }): number {
  const unitMs: Record<BucketUnit, number> = { hour: HOUR_MS, day: DAY_MS, week: WEEK_MS };
  return unitMs[config.unit] * config.size;
}

function formatShortDate(date: Date, includeYear = false): string {
  return new Intl.DateTimeFormat(getCurrentLocale(), { month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}) }).format(date);
}

function formatTimelineAxisLabel(value: number, range: ChartRange = currentRange): string | number {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (range === "7d") {
    return `${formatShortDate(date)}\n${formatTime(date)}`;
  }
  return formatShortDate(date, ["1y", "3y", "all", "ytd"].includes(range));
}

function formatWeekdayLabels(): string[] {
  const formatter = new Intl.DateTimeFormat(getCurrentLocale(), { weekday: "short" });
  return Array.from({ length: 7 }, (_, dayOffset) => formatter.format(new Date(2026, 0, 4 + dayOffset, 12)));
}

function formatBucketRange(startMs: number, config: { unit: BucketUnit; size: number }): string {
  const start = new Date(startMs);
  const duration = bucketDurationMs(config);
  const exclusiveEndMs = duration > 0 ? startMs + duration : startMs;

  if (config.unit === "hour") {
    const end = new Date(Math.max(startMs, exclusiveEndMs - 60 * 1000));
    return `${formatDate(start)}<br />${formatTime(start)} - ${formatTime(end)}`;
  }

  const end = new Date(Math.max(startMs, exclusiveEndMs - 24 * 60 * 60 * 1000));
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return formatDate(start);
  const sameYear = start.getFullYear() === end.getFullYear();
  return sameYear ? `${formatShortDate(start)} - ${formatShortDate(end)}, ${end.getFullYear()}` : `${formatShortDate(start, true)} - ${formatShortDate(end, true)}`;
}

function setStatsLoadStatus(kind: StatsLoadStatus["kind"], key: string, params: Record<string, string | number> = {}): void {
  statsLoadStatus = { kind, key, params };
  statsLoadStatusDot.classList.toggle("is-ready", kind === "ready");
  statsLoadStatusDot.classList.toggle("is-failed", kind === "failed");
  statsLoadStatusText.textContent = tr(key, params);
}

function refreshStatsLoadStatusText(): void {
  statsLoadStatusText.textContent = tr(statsLoadStatus.key, statsLoadStatus.params);
}

function pointsForRange(points: StatsPoint[], range: ChartRange): StatsPoint[] {
  if (range === "all" || points.length === 0) return points;
  const latest = points[points.length - 1].date.getTime();

  if (range === "ytd") {
    const latestDate = points[points.length - 1].date;
    const yearStart = new Date(latestDate.getFullYear(), 0, 1).getTime();
    return points.filter((point) => point.date.getTime() >= yearStart);
  }

  const windowMs = FIXED_RANGE_DURATION_MS[range as Exclude<ChartRange, "all" | "ytd">]
    ?? FIXED_RANGE_DURATION_MS["24h"];
  return points.filter((point) => latest - point.date.getTime() <= windowMs);
}

function setSourceLabel(source: string, sourceUrl: string | null = null): void {
  elements.sourceLabel.textContent = "";
  if (!sourceUrl) {
    elements.sourceLabel.textContent = source;
    return;
  }
  const link = document.createElement("a");
  link.href = sourceUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = source;
  elements.sourceLabel.append(link);
}

function updateHistoricalMetrics(points: StatsPoint[], source: string, sourceUrl: string | null = null): void {
  const latest = points[points.length - 1];
  const activePeriod = metricSnapshots[activeMetricSnapshotIndex]?.period;
  metricSnapshots = buildMetricSnapshots(points);
  const retainedIndex = metricSnapshots.findIndex((snapshot) => snapshot.period === activePeriod);
  activeMetricSnapshotIndex = retainedIndex >= 0 ? retainedIndex : 0;
  renderActiveMetricSnapshot();
  resetMetricRotation();
  elements.lastSample.textContent = latest ? formatTime(latest.date) : "--";
  elements.lastSampleDate.textContent = latest ? formatDate(latest.date) : "--";
  elements.sampleCount.textContent = formatLocaleNumber(points.length);
  setSourceLabel(source, sourceUrl);
  elements.rangeLabel.textContent = points.length >= 2 ? `${formatDate(points[0].date)} - ${formatDate(points[points.length - 1].date)}` : latest ? formatDate(latest.date) : "--";
}

function clearHistoricalMetrics(source: string): void {
  metricSnapshots = [];
  activeMetricSnapshotIndex = 0;
  stopMetricRotation();
  elements.peakPeriod.textContent = tr("range.24h");
  elements.peakCharacters.textContent = "--";
  elements.peakPlayers.textContent = "--";
  elements.averagePeriod.textContent = tr("range.24h");
  elements.averageCharacters.textContent = "--";
  elements.averagePlayers.textContent = "--";
  elements.lastSample.textContent = "--";
  elements.lastSampleDate.textContent = "--";
  elements.sampleCount.textContent = "0";
  elements.rangeLabel.textContent = "--";
  setSourceLabel(source);
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : Number.NaN;
}

function summarizePlayerCounts(points: StatsPoint[]): { peak: number; average: number } {
  const counts = points
    .map((point) => point.playerCount)
    .filter((count): count is number => typeof count === "number" && Number.isFinite(count));
  return {
    peak: counts.length > 0 ? Math.max(...counts) : Number.NaN,
    average: average(counts),
  };
}

function hasMetricCoverage(
  points: StatsPoint[],
  period: MetricPeriod,
  valueSelector: (point: StatsPoint) => number | null | undefined = (point) => point.characterCount,
): boolean {
  if (points.length === 0) return false;
  const latest = points[points.length - 1].date.getTime();
  const cutoff = latest - FIXED_RANGE_DURATION_MS[period];
  let reachesCutoff = false;
  let reachesLatest = false;
  points.forEach((point) => {
    const value = valueSelector(point);
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    reachesCutoff ||= point.date.getTime() <= cutoff;
    reachesLatest ||= point.date.getTime() === latest;
  });
  return reachesCutoff && reachesLatest;
}

function buildMetricSnapshots(points: StatsPoint[]): MetricSnapshot[] {
  return METRIC_PERIODS.flatMap((period): MetricSnapshot[] => {
    if (!hasMetricCoverage(points, period)) return [];
    const visible = pointsForRange(points, period);
    const characterCounts = visible.map((point) => point.characterCount);
    const playerSummary = hasMetricCoverage(points, period, (point) => point.playerCount)
      ? summarizePlayerCounts(visible)
      : { peak: Number.NaN, average: Number.NaN };
    return [{
      period,
      peakCharacters: Math.max(...characterCounts),
      averageCharacters: average(characterCounts),
      peakPlayers: playerSummary.peak,
      averagePlayers: playerSummary.average,
    }];
  });
}

function renderActiveMetricSnapshot(): void {
  const snapshot = metricSnapshots[activeMetricSnapshotIndex];
  const availablePeriods = new Set(metricSnapshots.map((item) => item.period));
  metricRangeTickGroups.forEach((ticks) => {
    ticks.forEach((tick, index) => {
      const period = METRIC_PERIODS[index];
      tick.classList.toggle("is-active", snapshot?.period === period);
      tick.classList.toggle("is-unavailable", !availablePeriods.has(period));
    });
  });
  if (!snapshot) {
    elements.peakCharacters.textContent = "--";
    elements.peakPlayers.textContent = "--";
    elements.averageCharacters.textContent = "--";
    elements.averagePlayers.textContent = "--";
    return;
  }
  const range = tr(`range.${snapshot.period}`);
  elements.peakPeriod.textContent = range;
  elements.peakCharacters.textContent = formatInteger(snapshot.peakCharacters);
  elements.peakPlayers.textContent = formatInteger(snapshot.peakPlayers);
  elements.averagePeriod.textContent = range;
  elements.averageCharacters.textContent = formatInteger(snapshot.averageCharacters);
  elements.averagePlayers.textContent = formatInteger(snapshot.averagePlayers);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clearMetricTransitionTimers(): void {
  if (metricTransitionMidpointTimer !== null) clearTimeout(metricTransitionMidpointTimer);
  if (metricTransitionEndTimer !== null) clearTimeout(metricTransitionEndTimer);
  metricTransitionMidpointTimer = null;
  metricTransitionEndTimer = null;
  metricBoards.forEach((card) => card.classList.remove("is-transitioning"));
}

function advanceMetricSnapshot(): void {
  if (metricSnapshots.length < 2 || metricPauseReasons.size > 0) return;
  const showNext = () => {
    activeMetricSnapshotIndex = (activeMetricSnapshotIndex + 1) % metricSnapshots.length;
    renderActiveMetricSnapshot();
  };
  clearMetricTransitionTimers();
  if (prefersReducedMotion()) {
    showNext();
    return;
  }
  metricBoards.forEach((card) => card.classList.add("is-transitioning"));
  metricTransitionMidpointTimer = setTimeout(showNext, METRIC_TRANSITION_MIDPOINT_MS);
  metricTransitionEndTimer = setTimeout(() => {
    metricBoards.forEach((card) => card.classList.remove("is-transitioning"));
    metricTransitionEndTimer = null;
  }, METRIC_TRANSITION_DURATION_MS);
}

function stopMetricRotation(): void {
  if (metricRotationTimer !== null) clearTimeout(metricRotationTimer);
  metricRotationTimer = null;
  metricRotationDeadline = 0;
  metricRotationRemainingMs = METRIC_ROTATION_MS;
  metricBoards.forEach((card) => {
    card.classList.remove("is-counting");
    card.classList.remove("is-paused");
  });
  clearMetricTransitionTimers();
}

function startMetricCountdownAnimation(startProgress: number, durationMs: number): void {
  const normalizedProgress = Math.max(0, Math.min(1, startProgress));
  metricBoards.forEach((card) => {
    card.classList.remove("is-counting");
    card.classList.remove("is-paused");
    card.style.setProperty("--countdown-start", String(normalizedProgress));
    card.style.setProperty("--countdown-duration", `${Math.max(0, durationMs)}ms`);
    void card.offsetWidth;
    card.classList.add("is-counting");
  });
}

function scheduleMetricRotation(): void {
  if (metricSnapshots.length < 2 || metricPauseReasons.size > 0 || document.visibilityState === "hidden") return;
  metricRotationDeadline = Date.now() + metricRotationRemainingMs;
  metricRotationTimer = setTimeout(() => {
    metricRotationTimer = null;
    advanceMetricSnapshot();
    metricRotationRemainingMs = METRIC_ROTATION_MS;
    startMetricCountdownAnimation(1, METRIC_ROTATION_MS);
    scheduleMetricRotation();
  }, metricRotationRemainingMs);
}

function resetMetricRotation(): void {
  stopMetricRotation();
  if (metricSnapshots.length > 1 && metricPauseReasons.size === 0 && document.visibilityState !== "hidden") {
    startMetricCountdownAnimation(1, METRIC_ROTATION_MS);
    scheduleMetricRotation();
  }
}

function setMetricBoardPaused(reason: string, paused: boolean): void {
  const wasPaused = metricPauseReasons.size > 0;
  if (paused) metricPauseReasons.add(reason);
  else metricPauseReasons.delete(reason);
  const isPaused = metricPauseReasons.size > 0;
  if (!wasPaused && isPaused) {
    if (metricRotationTimer !== null) {
      clearTimeout(metricRotationTimer);
      metricRotationTimer = null;
      metricRotationRemainingMs = Math.max(0, metricRotationDeadline - Date.now());
    }
    metricBoards.forEach((card) => card.classList.add("is-paused"));
  } else if (wasPaused && !isPaused && document.visibilityState !== "hidden") {
    startMetricCountdownAnimation(
      metricRotationRemainingMs / METRIC_ROTATION_MS,
      metricRotationRemainingMs,
    );
    scheduleMetricRotation();
  }
}

function percentile(values: number[], percentileRank: number): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const index = (percentileRank / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return lerp(sorted[lower], sorted[upper], index - lower);
}

function getHeatmapVisualBounds(): { min: number; max: number } {
  return { min: HEATMAP_VISUAL_MIN, max: HEATMAP_VISUAL_MAX };
}

function getHeatmapPercentileRanks(visible: StatsPoint[]): number[] {
  if (visible.length < 2) return [];
  const spanMs = visible[visible.length - 1].date.getTime() - visible[0].date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (spanMs <= 7 * dayMs) return [];
  if (spanMs <= 45 * dayMs) return [50];
  return [90, 50, 10];
}

function buildDistributionBuckets(counts: number[]): DistributionBucket[] {
  const finiteCounts = counts.filter((value) => Number.isFinite(value));
  if (finiteCounts.length === 0) return [];
  const maxCount = finiteCounts.reduce((max, value) => Math.max(max, value), 0);
  const bucketCount = Math.max(1, Math.ceil((maxCount + 1) / DISTRIBUTION_STEP));
  const histogramBuckets = Array.from({ length: bucketCount }, (_, index) => ({ label: `${formatLocaleNumber(index * DISTRIBUTION_STEP)}-${formatLocaleNumber(Math.min(((index + 1) * DISTRIBUTION_STEP) - 1, maxCount))}`, count: 0 }));
  finiteCounts.forEach((count) => {
    const index = Math.min(Math.floor(count / DISTRIBUTION_STEP), histogramBuckets.length - 1);
    histogramBuckets[index].count += 1;
  });
  return histogramBuckets;
}

function formatPercentage(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value >= 10) return `${value.toFixed(0)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

const TIMELINE_RANGE_CONFIG: Record<Exclude<ChartRange, "24h" | "ytd">, TimelineConfig> = {
  "7d": { labelKey: "chart.series.characters" },
  "28d": { labelKey: "chart.series.averageCharactersBucket", bucketKey: "bucket.4h", unit: "hour", size: 4 },
  "90d": { labelKey: "chart.series.averageCharactersBucket", bucketKey: "bucket.12h", unit: "hour", size: 12 },
  "180d": { labelKey: "chart.series.averageCharactersBucket", bucketKey: "bucket.1d", unit: "day", size: 1 },
  "1y": { labelKey: "chart.series.averageCharactersBucket", bucketKey: "bucket.48h", unit: "day", size: 2 },
  "3y": { labelKey: "chart.series.averageCharactersBucket", bucketKey: "bucket.1w", unit: "week", size: 1 },
  all: { labelKey: "chart.series.averageCharactersBucket", bucketKey: "bucket.1w", unit: "week", size: 1 },
};

function getSeriesLabel(config: TimelineConfig): string {
  return config.bucketKey ? tr(config.labelKey, { bucket: tr(config.bucketKey) }) : tr(config.labelKey);
}

function getPlayerSeriesLabel(config: TimelineConfig): string {
  return config.bucketKey
    ? tr("chart.series.averagePlayersBucket", { bucket: tr(config.bucketKey) })
    : tr("metric.players");
}

const RANGE_WINDOW_MS: Record<Exclude<ChartRange, "all" | "ytd">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "28d": 28 * DAY_MS,
  "90d": 90 * DAY_MS,
  "180d": 180 * DAY_MS,
  "1y": 365 * DAY_MS,
  "3y": 3 * 365 * DAY_MS,
};

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfLocalWeek(date: Date): number {
  const dayStart = startOfLocalDay(date);
  const day = new Date(dayStart).getDay();
  return dayStart - day * DAY_MS;
}

function bucketStart(timestamp: number, config: { unit: BucketUnit; size: number }): number {
  const date = new Date(timestamp);
  if (config.unit === "hour") {
    const dayStart = startOfLocalDay(date);
    const hour = date.getHours();
    return dayStart + Math.floor(hour / config.size) * config.size * 60 * 60 * 1000;
  }
  if (config.unit === "day") {
    const dayStart = startOfLocalDay(date);
    const epochDay = Math.floor(dayStart / DAY_MS);
    const bucketDay = Math.floor(epochDay / config.size) * config.size;
    return bucketDay * DAY_MS;
  }
  const weekStart = startOfLocalWeek(date);
  if (config.size <= 1) return weekStart;
  const anchor = startOfLocalWeek(new Date(0));
  const weekIndex = Math.floor((weekStart - anchor) / WEEK_MS);
  return anchor + Math.floor(weekIndex / config.size) * config.size * WEEK_MS;
}

function buildBucketSummaries(
  points: StatsPoint[],
  config: { unit: BucketUnit; size: number },
  valueSelector: (point: StatsPoint) => number | null | undefined = (point) => point.characterCount,
): BucketSummary[] {
  const buckets = new Map<number, BucketAccumulator>();
  points.forEach((point) => {
    const value = valueSelector(point);
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const bucket = bucketStart(point.date.getTime(), config);
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        min: value,
        max: value,
        avg: value,
        samples: 1,
        total: value,
      });
      return;
    }
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.samples += 1;
    existing.total += value;
    existing.avg = existing.total / existing.samples;
  });
  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ total, ...bucket }) => bucket);
}

function getTimelineConfig(range: ChartRange, visible: StatsPoint[]): TimelineConfig {
  if (range !== "ytd") {
    if (range === "24h") return TIMELINE_RANGE_CONFIG["7d"];
    return TIMELINE_RANGE_CONFIG[range as Exclude<ChartRange, "24h" | "ytd">] || TIMELINE_RANGE_CONFIG["7d"];
  }
  if (visible.length === 0) return TIMELINE_RANGE_CONFIG["7d"];
  const latest = visible[visible.length - 1].date;
  const yearStart = new Date(latest.getFullYear(), 0, 1).getTime();
  const spanMs = latest.getTime() - yearStart;
  // if (spanMs <= RANGE_WINDOW_MS["7d"]) return TIMELINE_RANGE_CONFIG["7d"];
  // if (spanMs <= RANGE_WINDOW_MS["28d"]) return TIMELINE_RANGE_CONFIG["28d"];
  // if (spanMs <= RANGE_WINDOW_MS["90d"]) return TIMELINE_RANGE_CONFIG["90d"];
  // if (spanMs <= RANGE_WINDOW_MS["180d"]) return TIMELINE_RANGE_CONFIG["180d"];
  if (spanMs <= RANGE_WINDOW_MS["7d"]) return TIMELINE_RANGE_CONFIG["7d"];
  if (spanMs <= RANGE_WINDOW_MS["28d"]) return TIMELINE_RANGE_CONFIG["28d"];
  if (spanMs <= RANGE_WINDOW_MS["90d"]) return TIMELINE_RANGE_CONFIG["90d"];
  if (spanMs <= RANGE_WINDOW_MS["180d"]) return TIMELINE_RANGE_CONFIG["180d"];
  return TIMELINE_RANGE_CONFIG["1y"];
}

function emptyGraphic(text = tr("ui.noLiveData")) {
  return { type: "text", left: "center", top: "middle", style: { text, fill: CHART_LABEL_COLOR, font: "700 15px Inter, sans-serif" } };
}

function formatTooltipValue(value: number | string | null | undefined): number | string {
  if (value == null) return "-";
  return Number.isFinite(Number(value)) ? formatLocaleNumber(Number(value)) : value;
}

function baseAxisOption() {
  return { animationDuration: 450, backgroundColor: "transparent", tooltip: { trigger: "axis", backgroundColor: CHART_TOOLTIP_BACKGROUND, borderColor: CHART_TOOLTIP_BORDER, borderWidth: 1, textStyle: { color: "#f4f1e8" }, valueFormatter: formatTooltipValue } };
}

function timelineSymbol(sampleCount: number): "circle" | "none" {
  return sampleCount === 1 ? "circle" : "none";
}

function getTimelineViewBounds(points: StatsPoint[], range: ChartRange): { startValue?: number; endValue?: number } {
  if (points.length === 0) return {};
  const first = points[0].date.getTime();
  const latest = points[points.length - 1].date.getTime();
  if (range === "all") return { startValue: first, endValue: latest };
  if (range === "ytd") {
    const latestDate = points[points.length - 1].date;
    return {
      startValue: Math.max(first, new Date(latestDate.getFullYear(), 0, 1).getTime()),
      endValue: latest,
    };
  }
  const duration = FIXED_RANGE_DURATION_MS[range as Exclude<ChartRange, "all" | "ytd">]
    ?? FIXED_RANGE_DURATION_MS["24h"];
  return { startValue: Math.max(first, latest - duration), endValue: latest };
}

function buildTimelineDataZoom(points: StatsPoint[], range: ChartRange) {
  const bounds = getTimelineViewBounds(points, range);
  const shared = { ...bounds, filterMode: "filter" as const, throttle: 80 };
  return [
    { type: "inside", ...shared },
    {
      type: "slider",
      ...shared,
      height: 24,
      bottom: 16,
      borderColor: CHART_AXIS_COLOR,
      fillerColor: "rgba(125, 216, 125, 0.14)",
      handleStyle: { color: "#7dd87d" },
      textStyle: { color: CHART_LABEL_COLOR },
    },
  ];
}

function buildTimelineOptions(points: StatsPoint[]) {
  // Keep the complete raw series mounted. Range presets only change dataZoom; ECharts samples the visible window.
  const characterValues = points.map((point) => [point.date.getTime(), point.characterCount]);
  const firstPlayerIndex = points.findIndex((point) => typeof point.playerCount === "number" && Number.isFinite(point.playerCount));
  const playerSource = firstPlayerIndex >= 0 ? points.slice(firstPlayerIndex) : [];
  const playerValues = playerSource.map((point) => [
    point.date.getTime(),
    typeof point.playerCount === "number" && Number.isFinite(point.playerCount) ? point.playerCount : null,
  ]);
  const playerSampleCount = playerValues.reduce((count, [, value]) => count + (value == null ? 0 : 1), 0);
  const characterName = tr("chart.series.characters");
  const playerName = tr("metric.players");

  return {
    ...baseAxisOption(),
    legend: { top: 8, data: [characterName, playerName], selectedMode: false, textStyle: { color: CHART_LABEL_COLOR } },
    grid: { left: 52, right: 24, top: 54, bottom: 76 },
    xAxis: { type: "time", axisLine: { lineStyle: { color: CHART_AXIS_COLOR } }, axisLabel: { color: CHART_LABEL_COLOR, formatter: (value: number) => formatTimelineAxisLabel(value, currentRange) }, splitLine: { show: false } },
    yAxis: { type: "value", min: 0, axisLabel: { color: CHART_LABEL_COLOR }, splitLine: { lineStyle: { color: CHART_GRID_COLOR } } },
    dataZoom: buildTimelineDataZoom(points, currentRange),
    series: [
      {
        id: "characters",
        name: characterName,
        type: "line",
        sampling: "minmax",
        smooth: false,
        symbol: timelineSymbol(characterValues.length),
        symbolSize: 7,
        lineStyle: { width: 3, color: "#7dd87d" },
        itemStyle: { color: "#f1c44f" },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(125, 216, 125, 0.36)" }, { offset: 1, color: "rgba(125, 216, 125, 0.02)" }] } },
        data: characterValues,
      },
      {
        id: "players",
        name: playerName,
        type: "line",
        sampling: "minmax",
        smooth: false,
        connectNulls: false,
        symbol: timelineSymbol(playerSampleCount),
        symbolSize: 6,
        lineStyle: { width: 3, color: PLAYER_COLOR },
        itemStyle: { color: PLAYER_COLOR },
        data: playerValues,
        z: 4,
      },
    ],
    graphic: characterValues.length === 0 ? emptyGraphic() : null,
  };
}

function applyTimelineRange(): void {
  if (!chart) {
    render();
    return;
  }
  chart.setOption({ dataZoom: buildTimelineDataZoom(allPoints, currentRange) });
}

function pointsForMetric(points: StatsPoint[], metric: ChartMetric = activeMetric): StatsPoint[] {
  if (metric === "characters") return points;
  return points
    .filter((point) => typeof point.playerCount === "number" && Number.isFinite(point.playerCount))
    .map((point) => ({ ...point, characterCount: point.playerCount as number }));
}

function buildHeatmapOptions(points: StatsPoint[]) {
  const visible = pointsForMetric(pointsForRange(points, currentRange));
  const weekdayLabels = formatWeekdayLabels();
  const hourLabels = Array.from({ length: 24 }, (_, hour) => `${hour}:00`);
  const percentileRanks = getHeatmapPercentileRanks(visible);
  const buckets = new Map<string, number[]>();
  visible.forEach((point) => {
    const key = `${point.date.getDay()}-${point.date.getHours()}`;
    const bucket = buckets.get(key) || [];
    bucket.push(point.characterCount);
    buckets.set(key, bucket);
  });
  const values: Array<[number, number, number | null, number, Record<string, number>, number]> = [];
  buckets.forEach((bucket, key) => {
    const [day, hour] = key.split("-").map(Number);
    const averageCount = Math.round(average(bucket));
    const percentiles = Object.fromEntries(percentileRanks.map((rank) => [`p${rank}`, Math.round(percentile(bucket, rank))]));
    values.push([hour, day, toHeatmapScore(averageCount), averageCount, percentiles, bucket.length]);
  });
  const { min: visualMin, max: visualMax } = getHeatmapVisualBounds();
  const seriesName = activeMetric === "players" ? tr("chart.series.averagePlayers") : tr("chart.series.averageCharacters");
  const emptyText = activeMetric === "players" ? tr("ui.noPlayerData") : tr("ui.noLiveData");
  return { animationDuration: 450, backgroundColor: "transparent", tooltip: { position: "top", backgroundColor: CHART_TOOLTIP_BACKGROUND, borderColor: CHART_TOOLTIP_BORDER, textStyle: { color: "#f4f1e8" }, formatter: (params: { value: [number, number, number | null, number, Record<string, number>, number] }) => { const [hour, day, , count, percentiles, samples] = params.value; const rows = [`<strong>${weekdayLabels[day]} ${hourLabels[hour]}</strong>`, `${tr("chart.tooltip.avg")}: ${formatInteger(count)}`]; Object.entries(percentiles || {}).forEach(([label, value]) => { rows.push(`${label}: ${formatInteger(value)}`); }); if (percentiles && Object.keys(percentiles).length > 0) rows.push(tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(samples) })); return rows.join("<br />"); } }, grid: { left: 52, right: 24, top: 34, bottom: 88 }, xAxis: { type: "category", data: hourLabels, axisLine: { lineStyle: { color: CHART_AXIS_COLOR } }, axisLabel: { color: CHART_LABEL_COLOR }, splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.012)", "transparent"] } } }, yAxis: { type: "category", data: weekdayLabels, inverse: true, axisLine: { lineStyle: { color: CHART_AXIS_COLOR } }, axisLabel: { color: CHART_LABEL_COLOR }, splitArea: { show: true, areaStyle: { color: ["rgba(255,255,255,0.012)", "transparent"] } } }, visualMap: { min: visualMin, max: visualMax, dimension: 2, calculable: true, orient: "horizontal", left: "center", bottom: 18, textStyle: { color: CHART_LABEL_COLOR }, inRange: { color: HEATMAP_COLORS }, outOfRange: { color: [HEATMAP_OUTOFRANGE_COLOR] } }, series: [{ name: seriesName, type: "heatmap", data: values, emphasis: { itemStyle: { borderColor: "#f4f1e8", borderWidth: 1 } } }], graphic: values.length === 0 ? emptyGraphic(emptyText) : null };
}

function buildDistributionOptions(points: StatsPoint[]) {
  const visible = pointsForMetric(pointsForRange(points, currentRange));
  const counts = visible.map((point) => point.characterCount);
  const buckets = buildDistributionBuckets(counts);
  const totalSamples = counts.length || 1;
  const percentageData = buckets.map((bucket) => (bucket.count / totalSamples) * 100);
  const emptyText = activeMetric === "players" ? tr("ui.noPlayerData") : tr("ui.noLiveData");
  const barColor = activeMetric === "players" ? PLAYER_COLOR : DISTRIBUTION_BAR_COLOR;
  return { ...baseAxisOption(), tooltip: { trigger: "axis", backgroundColor: CHART_TOOLTIP_BACKGROUND, borderColor: CHART_TOOLTIP_BORDER, textStyle: { color: "#f4f1e8" }, formatter: (params: Array<{ dataIndex: number; value: number }>) => { const item = params[0]; if (!item) return ""; const bucket = buckets[item.dataIndex]; return [bucket.label, tr("chart.tooltip.ofSamples", { percent: formatPercentage(item.value) }), tr("chart.tooltip.samplesCount", { count: formatLocaleNumber(bucket.count) })].join("<br />"); } }, grid: { left: 52, right: 24, top: 34, bottom: 74 }, xAxis: { type: "category", data: buckets.map((bucket) => bucket.label), axisLine: { lineStyle: { color: CHART_AXIS_COLOR } }, axisLabel: { color: CHART_LABEL_COLOR, rotate: 35 } }, yAxis: { type: "value", axisLabel: { color: CHART_LABEL_COLOR, formatter: (value: number) => formatPercentage(value) }, splitLine: { lineStyle: { color: CHART_GRID_COLOR } } }, series: [{ name: tr("chart.series.samplesPercent"), type: "bar", barMaxWidth: 38, itemStyle: { borderRadius: [4, 4, 0, 0], borderColor: CHART_AXIS_COLOR, borderWidth: 1, color: barColor }, data: percentageData }], graphic: visible.length === 0 ? emptyGraphic(emptyText) : null };
}

function buildChartOptions(points: StatsPoint[]) {
  if (activeChart === "heatmap") return buildHeatmapOptions(points);
  if (activeChart === "distribution") return buildDistributionOptions(points);
  return buildTimelineOptions(points);
}

function updateMetricToggle(): void {
  metricToggle.hidden = activeChart === "timeline";
  metricButtons.forEach((button) => {
    const selected = button.dataset.metric === activeMetric;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function selectChart(chartName: ChartKind): void {
  activeChart = chartName;
  activeMetric = "characters";
  chartButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.chart === activeChart));
  updateMetricToggle();
}

function selectMetric(metric: ChartMetric): void {
  activeMetric = metric;
  updateMetricToggle();
}

function renderChart(): void {
  if (!chart) {
    chart = echarts.init(chartElement, null, { renderer: "canvas" });
    window.addEventListener("resize", () => {
      if (chart) chart.resize();
    });
  }
  chart.setOption(buildChartOptions(allPoints), true);
}

function render(): void {
  if (pendingRender) return;
  pendingRender = true;
  whenAppReady().then(() => {
    pendingRender = false;
    renderChart();
  });
}

function mergePoints(...groups: StatsPoint[][]): StatsPoint[] {
  const pointsByTime = new Map<number, StatsPoint>();
  groups.flat().forEach((point) => {
    const time = point.date.getTime();
    if (!pointsByTime.has(time)) pointsByTime.set(time, point);
  });
  return [...pointsByTime.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function fetchHistoricalStats(): Promise<void> {
  const loader = window.MushmomStatsLoader;
  if (!loader) throw new Error(tr("error.statsLoaderUnavailable"));
  const initial = await loader.loadInitialStatsHistory<StatsPoint>({
    normalizePayload,
    onInitial: ({ points, recentPayload }) => {
      allPoints = mergePoints([], points);
      historicalSource = { name: (recentPayload as HistoricalSourcePayload).source || "R2", url: (recentPayload as HistoricalSourcePayload).sourceUrl || null };
      updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
      render();
    },
  });

  await (globalThis.__mushmomEchartsReady || Promise.resolve());

  await loader.loadArchiveStatsHistory<StatsPoint>({
    recentPayload: initial.recentPayload,
    manifest: initial.manifest,
    normalizePayload,
    onArchive: ({ points }) => {
      if (points.length === 0) return;
      allPoints = mergePoints(points, allPoints);
      updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
      render();
    },
  });
}

async function fetchCurrentPopulation(): Promise<void> {
  const response = await fetch("/api/current", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(tr("error.currentPopulationRequestFailed", { status: response.status }));
  const payload = await response.json() as { usercount?: unknown; uniquecount?: unknown };
  const { usercount, uniquecount } = payload;
  if (!isNonnegativeInteger(usercount) || !isNonnegativeInteger(uniquecount)) throw new Error(tr("error.currentPopulationMissingCount"));
  elements.currentCharacters.textContent = formatInteger(usercount);
  elements.currentPlayers.textContent = formatInteger(uniquecount);
}

async function loadStats(): Promise<void> {
  const hadHistoricalData = allPoints.length > 0;
  setStatsLoadStatus("loading", "status.loading");
  const [statsResult, currentResult] = await Promise.allSettled([fetchHistoricalStats(), fetchCurrentPopulation()]);
  if (statsResult.status === "fulfilled") {
    setStatsLoadStatus("ready", "status.ready");
  } else {
    console.warn(statsResult.reason);
    if (!hadHistoricalData) {
      allPoints = [];
      clearHistoricalMetrics(tr("source.unavailable"));
    }
    setStatsLoadStatus("failed", "status.failed");
  }
  if (currentResult.status === "rejected") {
    console.warn(currentResult.reason);
    if (elements.currentCharacters.textContent === "") elements.currentCharacters.textContent = "--";
    if (elements.currentPlayers.textContent === "") elements.currentPlayers.textContent = "--";
  }
  render();
}

rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentRange = (button.dataset.range as ChartRange) || "7d";
    rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    if (activeChart === "timeline") {
      applyTimelineRange();
    } else {
      render();
    }
  });
});

chartButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectChart((button.dataset.chart as ChartKind) || "timeline");
    render();
  });
});

metricButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectMetric((button.dataset.metric as ChartMetric) || "characters");
    render();
  });
});

metricBoards.forEach((card, index) => {
  const pointerReason = `pointer-${index}`;
  const focusReason = `focus-${index}`;
  card.addEventListener("mouseenter", () => setMetricBoardPaused(pointerReason, true));
  card.addEventListener("mouseleave", () => setMetricBoardPaused(pointerReason, false));
  card.addEventListener("focusin", () => setMetricBoardPaused(focusReason, true));
  card.addEventListener("focusout", () => setMetricBoardPaused(focusReason, false));
});

document.addEventListener("visibilitychange", () => {
  setMetricBoardPaused("document-hidden", document.visibilityState === "hidden");
});

window.addEventListener("mushmom:languagechange", () => {
  refreshStatsLoadStatusText();
  if (allPoints.length > 0) {
    updateHistoricalMetrics(allPoints, historicalSource.name, historicalSource.url);
  } else if (statsLoadStatus.kind === "failed") {
    clearHistoricalMetrics(tr("source.unavailable"));
  }
  render();
});

function initApp(): void {
  loadStats();
}

const testApi = {
  normalizePayload,
  summarizePlayerCounts,
  isKnownBadPoint,
  formatTime,
  formatTimelineAxisLabel,
  formatWeekdayLabels,
  formatBucketRange,
  getHeatmapVisualBounds,
  getHeatmapPercentileRanks,
  buildDistributionBuckets,
  buildBucketSummaries,
  buildTimelineOptions,
  buildHeatmapOptions,
  buildDistributionOptions,
  pointsForMetric,
  hasMetricCoverage,
  buildMetricSnapshots,
  advanceMetricSnapshot,
  setMetricBoardPaused,
  selectChart,
  selectMetric,
  getChartStateForTest: () => ({ activeChart, activeMetric, metricToggleHidden: metricToggle.hidden }),
  getMetricBoardStateForTest: () => ({
    periods: metricSnapshots.map((snapshot) => snapshot.period),
    activePeriod: metricSnapshots[activeMetricSnapshotIndex]?.period ?? null,
    paused: metricPauseReasons.size > 0,
  }),
  setMetricSnapshotsForTest: (snapshots: MetricSnapshot[]) => {
    metricSnapshots = snapshots;
    activeMetricSnapshotIndex = 0;
    renderActiveMetricSnapshot();
  },
  resetMetricRotationForTest: resetMetricRotation,
  setCurrentRangeForTest: (range: ChartRange) => { currentRange = range; },
};

globalThis.__MUSHMOM_TEST__ = testApi;

export { initApp, normalizePayload, summarizePlayerCounts, hasMetricCoverage, buildMetricSnapshots, isKnownBadPoint, formatTime, formatTimelineAxisLabel, formatWeekdayLabels, formatBucketRange, getHeatmapVisualBounds, getHeatmapPercentileRanks, buildDistributionBuckets, buildBucketSummaries, buildTimelineOptions, buildHeatmapOptions, buildDistributionOptions, pointsForMetric, testApi };
